/**
 * `@stateless/proxmox/qemu` — a transport-neutral Proxmox VE **QEMU VM**
 * lifecycle model. (Sibling: `@stateless/proxmox/lxc` for containers.)
 *
 * The same operations (`lookup`, `clone`, `setConfig`, `start`, `stop`,
 * `delete`) run either over the PVE REST API directly (`transport.kind:
 * "api"`, token auth) or by executing `pvesh` on the node over SSH
 * (`transport.kind: "ssh"`) — useful when the API is only reachable through a
 * jump. Cloud-init is applied with `setConfig` (PVE cloud-init is just config
 * keys: `ciuser`, `sshkeys`, `ipconfig0`, …). Template preparation
 * (`qm importdisk`/`qm template`) is intentionally out of scope; build the
 * shared template once, then clone it here.
 *
 * @module
 */

import {
  executeRequest,
  isUpid,
  PveError,
  type PveRequest,
  waitForTask,
} from "./_lib/proxmox/client.ts";
import {
  agentExecReq,
  agentExecStatusReq,
  agentInterfacesReq,
  assertGate,
  cloneReq,
  configReq,
  deleteReq,
  extractIpv4,
  type GuestExecResult,
  listGuestsReq,
  parseConfig,
  parseExecPid,
  parseExecStatus,
  parseGuestList,
  resizeDiskReq,
  resolveVmidFromList,
  setConfigReq,
  startReq,
  statusReq,
  stopReq,
  withManagedTag,
} from "./_lib/proxmox/pve.ts";
import {
  CloneArgsSchema,
  DeleteArgsSchema,
  ExecResultSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  GuestConfigSchema,
  GuestExecArgsSchema,
  GuestStateSchema,
  LookupArgsSchema,
  NodeConfigArgsSchema,
  NodeConfigSchema,
  NodeStatusArgsSchema,
  NodeStatusSchema,
  ResizeDiskArgsSchema,
  SetConfigArgsSchema,
  StartArgsSchema,
  StopArgsSchema,
  SyncArgsSchema,
} from "./_lib/proxmox/schemas.ts";
import {
  type GuestMetrics,
  isDiskUnhealthy,
  nodeBridgesReq,
  nodeDisksReq,
  nodeStatusReq,
  nodeStoragesReq,
  parseBridges,
  parseGuestMetrics,
  parseNodeDisks,
  parseNodeStatus,
  parseStorages,
} from "./_lib/proxmox/node.ts";

// --- Minimal structural typings for the method context (declared locally,
// never imported — the convention every swamp extension follows). ----------

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<DataHandle>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

/** Context passed to a pre-flight check (no resource writers, per the API). */
interface CheckContext {
  globalArgs: GlobalArgs;
}

interface CheckResult {
  pass: boolean;
  errors?: string[];
}

// --- Orchestration helpers -------------------------------------------------

/** Resolve a guest reference to a concrete vmid (looking it up by name). */
async function resolveVmid(
  global: GlobalArgs,
  ref: { vmid?: number; vmName?: string },
): Promise<number> {
  if (ref.vmid !== undefined) return ref.vmid;
  const list = await executeRequest(
    global,
    listGuestsReq(global.transport.node),
  );
  return resolveVmidFromList(parseGuestList(list), ref.vmName!);
}

/** Run a request and, when it returns a task handle, wait for completion. */
async function runAndAwait(
  global: GlobalArgs,
  req: PveRequest,
): Promise<void> {
  const result = await executeRequest(global, req);
  if (isUpid(result)) await waitForTask(global, result);
}

/** Read current status and write a guest-state resource. */
async function recordState(
  ctx: MethodContext,
  vmid: number,
  lastOperation: string,
  opts: { ipv4?: string; nameHint?: string } = {},
): Promise<DataHandle> {
  const global = ctx.globalArgs;
  const node = global.transport.node;
  let status = "unknown";
  let name = opts.nameHint;
  let metrics: GuestMetrics = {};
  try {
    const cur = await executeRequest(global, statusReq(node, vmid)) as
      | Record<string, unknown>
      | null;
    if (cur) {
      if (typeof cur.status === "string") status = cur.status;
      if (typeof cur.name === "string") name = cur.name;
      metrics = parseGuestMetrics(cur);
    }
  } catch (err) {
    ctx.logger.warning("status read failed for vmid {vmid}: {error}", {
      vmid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const state = GuestStateSchema.parse({
    vmid,
    name,
    node,
    status,
    ipv4: opts.ipv4,
    ...metrics,
    lastOperation,
    recordedAt: new Date().toISOString(),
  });
  ctx.logger.info("{op}: guest {vmid} is {status}", {
    op: lastOperation,
    vmid,
    status,
  });
  return ctx.writeResource("guest", name ?? `vm-${vmid}`, state);
}

/** Best-effort poll of the guest agent for a non-loopback IPv4. */
async function pollIpv4(
  global: GlobalArgs,
  vmid: number,
): Promise<string | undefined> {
  const node = global.transport.node;
  const deadline = Date.now() + global.taskTimeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const data = await executeRequest(global, agentInterfacesReq(node, vmid));
      const ip = extractIpv4(data);
      if (ip) return ip;
    } catch {
      // Agent not up yet — keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, global.pollIntervalSec * 1000));
  }
  return undefined;
}

/** True when `vmid` currently exists on the node (drives idempotency). */
async function guestPresent(
  global: GlobalArgs,
  vmid: number,
): Promise<boolean> {
  const list = parseGuestList(
    await executeRequest(global, listGuestsReq(global.transport.node)),
  );
  return list.some((g) => g.vmid === vmid);
}

/** Poll the guest agent for a command's completion, returning its outcome. */
async function pollExec(
  global: GlobalArgs,
  vmid: number,
  pid: number,
  timeoutSec: number,
): Promise<GuestExecResult> {
  const node = global.transport.node;
  const deadline = Date.now() + timeoutSec * 1000;
  while (true) {
    const status = parseExecStatus(
      await executeRequest(global, agentExecStatusReq(node, vmid, pid)),
    );
    if (status.exited) return status;
    if (Date.now() > deadline) {
      throw new PveError(
        `guest exec pid ${pid} on vmid ${vmid} did not finish within ${timeoutSec}s`,
      );
    }
    await new Promise((r) => setTimeout(r, global.pollIntervalSec * 1000));
  }
}

// --- Model -----------------------------------------------------------------

/** Transport-neutral Proxmox VE guest-lifecycle model. */
export const model = {
  type: "@stateless/proxmox/qemu",
  version: "2026.06.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    guest: {
      description: "Last observed state of a Proxmox guest.",
      schema: GuestStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    exec: {
      description: "Result of the most recent guestExec command run.",
      schema: ExecResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    nodeStatus: {
      description:
        "Host-health snapshot of the node: CPU load, memory/swap pressure, " +
        "root-filesystem fill, and per-disk SMART health.",
      schema: NodeStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    config: {
      description:
        "A guest's declarative config bag (cores, memory, disks, net, " +
        "cloud-init keys, tags) as returned by PVE.",
      schema: GuestConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    nodeConfig: {
      description:
        "Node config inventory: storages (id/type/content/capacity) and bridges.",
      schema: NodeConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "transport-reachable": {
      description:
        "PVE answers GET /version over the configured transport — validates " +
        "reachability and (for the api transport) token authentication before " +
        "any mutating operation runs.",
      labels: ["live"],
      appliesTo: [
        "clone",
        "setConfig",
        "resizeDisk",
        "start",
        "stop",
        "delete",
        "guestExec",
      ],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        try {
          await executeRequest(context.globalArgs, {
            verb: "get",
            path: "/version",
          });
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [
              `PVE pre-flight (GET /version) failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ],
          };
        }
      },
    },
  },
  methods: {
    lookup: {
      description: "Read a guest's current runtime status.",
      arguments: LookupArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("lookup guest {vmid}", { vmid });
        const handle = await recordState(ctx, vmid, "lookup");
        return { dataHandles: [handle] };
      },
    },

    getConfig: {
      description:
        "Read a guest's declarative config bag (cores, memory, disks, net, " +
        "cloud-init keys, tags) — the config counterpart to lookup's status.",
      arguments: LookupArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        const vmid = await resolveVmid(global, args);
        const config = parseConfig(
          await executeRequest(global, configReq(node, vmid)),
        );
        const record = GuestConfigSchema.parse({
          vmid,
          node,
          config,
          recordedAt: new Date().toISOString(),
        });
        ctx.logger.info("getConfig guest {vmid}: {n} keys", {
          vmid,
          n: Object.keys(config).length,
        });
        const handle = await ctx.writeResource(
          "config",
          `vm-${vmid}-config`,
          record,
        );
        return { dataHandles: [handle] };
      },
    },

    nodeStatus: {
      description:
        "Snapshot host health: CPU load, memory/swap pressure, root-filesystem " +
        "fill, and per-disk SMART health. Node comes from the transport.",
      arguments: NodeStatusArgsSchema,
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        ctx.logger.info("nodeStatus: probing {node}", { node });
        const facts = parseNodeStatus(
          await executeRequest(global, nodeStatusReq(node)),
        );
        // Disk SMART needs a privileged endpoint; a token without it shouldn't
        // sink the whole snapshot — degrade to an empty disk list.
        let disks: ReturnType<typeof parseNodeDisks> = [];
        try {
          disks = parseNodeDisks(
            await executeRequest(global, nodeDisksReq(node)),
          );
        } catch (err) {
          ctx.logger.warning(
            "nodeStatus: disk list failed on {node}: {error}",
            {
              node,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        const unhealthy = disks.filter(isDiskUnhealthy).length;
        const record = NodeStatusSchema.parse({
          node,
          ...facts,
          disks,
          recordedAt: new Date().toISOString(),
        });
        ctx.logger.info(
          "nodeStatus {node}: cpu {cpu}% · mem {mem}% · rootfs {root}% · " +
            "{disks} disks ({unhealthy} not PASSED)",
          {
            node,
            cpu: facts.cpuPct ?? "?",
            mem: facts.memPct ?? "?",
            root: facts.rootfsPct ?? "?",
            disks: disks.length,
            unhealthy,
          },
        );
        const handle = await ctx.writeResource(
          "nodeStatus",
          `node-${node}`,
          record,
        );
        return { dataHandles: [handle] };
      },
    },

    nodeConfig: {
      description:
        "Read node config inventory: storages (id/type/content/capacity) and " +
        "bridges. The config counterpart to nodeStatus.",
      arguments: NodeConfigArgsSchema,
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        const storages = parseStorages(
          await executeRequest(global, nodeStoragesReq(node)),
        );
        const bridges = parseBridges(
          await executeRequest(global, nodeBridgesReq(node)),
        );
        const record = NodeConfigSchema.parse({
          node,
          storages,
          bridges,
          recordedAt: new Date().toISOString(),
        });
        ctx.logger.info("nodeConfig {node}: {s} storages, {b} bridges", {
          node,
          s: storages.length,
          b: bridges.length,
        });
        const handle = await ctx.writeResource(
          "nodeConfig",
          `node-${node}-config`,
          record,
        );
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Reconcile live PVE state into the data model — one guest, or every " +
        "guest on the node when no vmid/vmName is given.",
      arguments: SyncArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        if (args.vmid === undefined && args.vmName === undefined) {
          const list = parseGuestList(
            await executeRequest(global, listGuestsReq(node)),
          );
          ctx.logger.info("sync: reconciling {n} guests on {node}", {
            n: list.length,
            node,
          });
          const handles: DataHandle[] = [];
          for (const g of list) {
            handles.push(
              await recordState(ctx, g.vmid, "sync", { nameHint: g.name }),
            );
          }
          return { dataHandles: handles };
        }
        const vmid = await resolveVmid(global, args);
        ctx.logger.info("sync guest {vmid}", { vmid });
        const handle = await recordState(ctx, vmid, "sync");
        return { dataHandles: [handle] };
      },
    },

    clone: {
      description: "Clone a template into a new guest (waits for the task).",
      arguments: CloneArgsSchema,
      execute: async (
        args: {
          templateId: number;
          vmid: number;
          name: string;
          full: boolean;
          storage?: string;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        // Idempotent: a re-run of a half-finished build must not error on an
        // already-present VMID. If the target exists, record its state and skip.
        if (await guestPresent(ctx.globalArgs, args.vmid)) {
          ctx.logger.info(
            "clone: vmid {vmid} already present — skipping (idempotent)",
            { vmid: args.vmid },
          );
          const handle = await recordState(ctx, args.vmid, "clone (existing)", {
            nameHint: args.name,
          });
          return { dataHandles: [handle] };
        }
        ctx.logger.info("cloning template {tid} → vmid {vmid} ({name})", {
          tid: args.templateId,
          vmid: args.vmid,
          name: args.name,
        });
        await runAndAwait(
          ctx.globalArgs,
          cloneReq(node, args.templateId, {
            vmid: args.vmid,
            name: args.name,
            full: args.full,
            storage: args.storage,
          }),
        );
        // 🐊 tag the clone swamp-managed so later destructive ops are permitted
        // (and non-swamp guests stay protected from swamp).
        await executeRequest(
          ctx.globalArgs,
          setConfigReq(node, args.vmid, { tags: withManagedTag(undefined) }),
        );
        const handle = await recordState(ctx, args.vmid, "clone", {
          nameHint: args.name,
        });
        return { dataHandles: [handle] };
      },
    },

    setConfig: {
      description: "Apply config keys (incl. cloud-init) to a guest.",
      arguments: SetConfigArgsSchema,
      execute: async (
        args: {
          vmid?: number;
          vmName?: string;
          config: Record<string, string | number>;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("setConfig guest {vmid}: {keys}", {
          vmid,
          keys: Object.keys(args.config).join(","),
        });
        await executeRequest(
          ctx.globalArgs,
          setConfigReq(node, vmid, args.config),
        );
        const handle = await recordState(ctx, vmid, "setConfig");
        return { dataHandles: [handle] };
      },
    },

    resizeDisk: {
      description:
        "Grow a guest disk (e.g. after cloning a small template). PVE only " +
        "grows — shrinking is rejected.",
      arguments: ResizeDiskArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; disk: string; size: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("resizeDisk guest {vmid}: {disk} += {size}", {
          vmid,
          disk: args.disk,
          size: args.size,
        });
        await executeRequest(
          ctx.globalArgs,
          resizeDiskReq(node, vmid, args.disk, args.size),
        );
        const handle = await recordState(ctx, vmid, "resizeDisk");
        return { dataHandles: [handle] };
      },
    },

    start: {
      description: "Start a guest; optionally wait for a guest-agent IPv4.",
      arguments: StartArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; waitForIp: boolean },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("starting guest {vmid}", { vmid });
        await runAndAwait(ctx.globalArgs, startReq(node, vmid));
        const ipv4 = args.waitForIp
          ? await pollIpv4(ctx.globalArgs, vmid)
          : undefined;
        if (args.waitForIp && !ipv4) {
          ctx.logger.warning("guest {vmid} started but no agent IPv4 seen", {
            vmid,
          });
        }
        const handle = await recordState(ctx, vmid, "start", { ipv4 });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop a guest (waits for the task).",
      arguments: StopArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; force: boolean },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        // 🐊 ownership gate: only stop swamp-managed guests (unless force).
        const guest = parseGuestList(
          await executeRequest(ctx.globalArgs, listGuestsReq(node)),
        ).find((g) => g.vmid === vmid);
        assertGate(guest?.tags, { force: args.force, op: "stop", vmid });
        ctx.logger.info("stopping guest {vmid}", { vmid });
        await runAndAwait(ctx.globalArgs, stopReq(node, vmid));
        const handle = await recordState(ctx, vmid, "stop");
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a guest (waits for the task).",
      arguments: DeleteArgsSchema,
      execute: async (
        args: {
          vmid?: number;
          vmName?: string;
          purge: boolean;
          force: boolean;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        // Resolve against a single list read so "already gone" (by vmid *or*
        // name) is a clean no-op rather than a "no guest named …" error.
        const list = parseGuestList(
          await executeRequest(ctx.globalArgs, listGuestsReq(node)),
        );
        let vmid = args.vmid;
        if (vmid === undefined) {
          const matches = list.filter((g) => g.name === args.vmName);
          if (matches.length > 1) {
            throw new Error(
              `guest name "${args.vmName}" is ambiguous (vmids ${
                matches.map((m) => m.vmid).join(", ")
              })`,
            );
          }
          vmid = matches[0]?.vmid;
        }
        const present = vmid !== undefined &&
          list.some((g) => g.vmid === vmid);
        if (!present) {
          ctx.logger.info(
            "delete: {ref} not present — already gone (idempotent)",
            { ref: args.vmName ?? args.vmid },
          );
          if (vmid === undefined) return { dataHandles: [] };
          const goneState = GuestStateSchema.parse({
            vmid,
            node,
            status: "deleted",
            lastOperation: "delete (absent)",
            recordedAt: new Date().toISOString(),
          });
          const goneHandle = await ctx.writeResource(
            "guest",
            `vm-${vmid}`,
            goneState,
          );
          return { dataHandles: [goneHandle] };
        }
        // 🐊 gates: only delete swamp-managed guests, and never a
        // production/protected one, unless force overrides.
        assertGate(list.find((g) => g.vmid === vmid)?.tags, {
          force: args.force,
          op: "delete",
          vmid: vmid!,
          checkProtected: true,
        });
        ctx.logger.info("deleting guest {vmid} (purge={purge})", {
          vmid,
          purge: args.purge,
        });
        await runAndAwait(ctx.globalArgs, deleteReq(node, vmid, args.purge));
        const state = GuestStateSchema.parse({
          vmid,
          node,
          status: "deleted",
          lastOperation: "delete",
          recordedAt: new Date().toISOString(),
        });
        const handle = await ctx.writeResource("guest", `vm-${vmid}`, state);
        return { dataHandles: [handle] };
      },
    },

    guestExec: {
      description:
        "Run a command inside a booted guest via the qemu guest agent and " +
        "capture its exit code + stdout/stderr (OS-neutral primitive).",
      arguments: GuestExecArgsSchema,
      execute: async (
        args: {
          vmid?: number;
          vmName?: string;
          command: string[];
          timeoutSec: number;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        const vmid = await resolveVmid(global, args);
        ctx.logger.info("guestExec {vmid}: {cmd}", {
          vmid,
          cmd: args.command.join(" "),
        });
        const pid = parseExecPid(
          await executeRequest(global, agentExecReq(node, vmid, args.command)),
        );
        const outcome = await pollExec(global, vmid, pid, args.timeoutSec);
        if (outcome.exitCode !== undefined && outcome.exitCode !== 0) {
          ctx.logger.warning("guestExec {vmid} exited non-zero ({code})", {
            vmid,
            code: outcome.exitCode,
          });
        }
        const record = ExecResultSchema.parse({
          vmid,
          node,
          command: args.command,
          exited: outcome.exited,
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          recordedAt: new Date().toISOString(),
        });
        const handle = await ctx.writeResource(
          "exec",
          `vm-${vmid}-exec`,
          record,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
