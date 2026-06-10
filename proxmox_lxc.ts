/**
 * `@stateless/proxmox/lxc` — a transport-neutral Proxmox VE **LXC container**
 * lifecycle model. (Sibling: `@stateless/proxmox/qemu` for VMs.)
 *
 * The same operations (`lookup`, `create`, `setConfig`, `start`, `stop`,
 * `delete`, `resize`, `sync`) run either over the PVE REST API directly
 * (`transport.kind: "api"`, token auth) or by executing `pvesh` on the node
 * over SSH (`transport.kind: "ssh"`) — the `/lxc` REST surface is identical
 * either way, so the shared transport client is reused untouched.
 *
 * A container is **created from an OS template** (a `vztmpl` tarball) rather
 * than cloned. There is intentionally **no in-container `exec`/`push`**: LXC has
 * no guest agent and `pct exec`/`pct push` are CLI-only (off the REST surface),
 * so run in-container steps through a node-shell model (`@swamp/ssh`) instead.
 * For the same reason `start --waitForIp` reads the static IP from the
 * container config rather than polling an agent.
 *
 * @module
 */

import {
  executeRequest,
  isUpid,
  type PveRequest,
  waitForTask,
} from "./_lib/proxmox/client.ts";
import {
  assertGate,
  parseConfig,
  parseGuestList,
  resolveVmidFromList,
  withManagedTag,
} from "./_lib/proxmox/pve.ts";
import {
  bridgesFromConfig,
  type CreateCtOpts,
  createCtReq,
  ctConfigReq,
  ctDeleteReq,
  ctResizeReq,
  ctSetConfigReq,
  ctStartReq,
  ctStatusReq,
  ctStopReq,
  extractCtConfigIpv4,
  listBridgesReq,
  listCtReq,
  listStoragesReq,
  listTemplatesReq,
  parseBridges,
  parseStorages,
  parseVolids,
  storageOfVolid,
} from "./_lib/proxmox/lxc.ts";
import {
  CreateCtArgsSchema,
  CtResizeArgsSchema,
  DeleteArgsSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  GuestConfigSchema,
  GuestStateSchema,
  LookupArgsSchema,
  NodeConfigArgsSchema,
  NodeConfigSchema,
  NodeStatusArgsSchema,
  NodeStatusSchema,
  SetConfigArgsSchema,
  StartArgsSchema,
  StopArgsSchema,
  SyncArgsSchema,
} from "./_lib/proxmox/schemas.ts";
import {
  type GuestMetrics,
  isDiskUnhealthy,
  nodeDisksReq,
  nodeStatusReq,
  parseGuestMetrics,
  parseNodeDisks,
  parseNodeStatus,
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

/** Resolve a container reference to a concrete vmid (looking it up by name). */
async function resolveVmid(
  global: GlobalArgs,
  ref: { vmid?: number; vmName?: string },
): Promise<number> {
  if (ref.vmid !== undefined) return ref.vmid;
  const list = await executeRequest(global, listCtReq(global.transport.node));
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

/** Read current status and write a container-state resource. */
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
    const cur = await executeRequest(global, ctStatusReq(node, vmid)) as
      | Record<string, unknown>
      | null;
    if (cur) {
      if (typeof cur.status === "string") status = cur.status;
      // LXC status/current reports the hostname under `name`.
      if (typeof cur.name === "string") name = cur.name;
      metrics = parseGuestMetrics(cur);
    }
  } catch (err) {
    ctx.logger.warning("status read failed for ct {vmid}: {error}", {
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
  ctx.logger.info("{op}: container {vmid} is {status}", {
    op: lastOperation,
    vmid,
    status,
  });
  return ctx.writeResource("container", name ?? `ct-${vmid}`, state);
}

/** Read the container's static IPv4 from its config (LXC has no agent). */
async function readConfigIpv4(
  global: GlobalArgs,
  vmid: number,
): Promise<string | undefined> {
  try {
    const config = await executeRequest(
      global,
      ctConfigReq(global.transport.node, vmid),
    );
    return extractCtConfigIpv4(config);
  } catch {
    return undefined;
  }
}

/** True when `vmid` currently exists on the node (drives idempotency). */
async function ctPresent(global: GlobalArgs, vmid: number): Promise<boolean> {
  const list = parseGuestList(
    await executeRequest(global, listCtReq(global.transport.node)),
  );
  return list.some((g) => g.vmid === vmid);
}

/**
 * Map the requested spec onto the node's live capabilities and collect every
 * reason it can't succeed, so `create` fails fast with one clear message
 * instead of an opaque PVE error. Verifies storage (the OS template exists, and
 * the rootfs storage supports `rootdir` with enough capacity) and network
 * (every bridge referenced in the net config exists on the node). Compute is
 * sanity-bounded at the schema; live capacity headroom (PVE overcommits) is a
 * future non-mutating `verify` method, not asserted here.
 */
async function verifyCreateFeasible(
  global: GlobalArgs,
  args: CreateCtOpts,
): Promise<string[]> {
  const node = global.transport.node;
  const errors: string[] = [];

  // Storage: list once, then map both the rootfs and the template against it.
  const storages = parseStorages(
    await executeRequest(global, listStoragesReq(node)),
  );
  const root = storages.find((s) => s.storage === args.storage);
  if (!root) {
    errors.push(
      `rootfs storage "${args.storage}" not found on ${node} (have: ${
        storages.map((s) => s.storage).join(", ") || "none"
      })`,
    );
  } else {
    if (!root.content.includes("rootdir")) {
      errors.push(
        `storage "${args.storage}" does not support a container rootfs ` +
          `(content: ${root.content.join(",") || "none"}; needs "rootdir")`,
      );
    }
    const needBytes = args.rootfsSize * 1024 ** 3;
    if (root.avail !== undefined && root.avail < needBytes) {
      errors.push(
        `storage "${args.storage}" has ~${
          Math.floor(root.avail / 1024 ** 3)
        } GiB free, less than the requested ${args.rootfsSize} GiB rootfs`,
      );
    }
  }

  // OS template must exist on its storage (also confirms vztmpl support).
  const tmplStorage = storageOfVolid(args.ostemplate);
  try {
    const available = parseVolids(
      await executeRequest(global, listTemplatesReq(node, tmplStorage)),
    );
    if (!available.includes(args.ostemplate)) {
      errors.push(
        `ostemplate "${args.ostemplate}" not found on storage ` +
          `"${tmplStorage}" (available: ${
            available.join(", ") || "none — does it have content=vztmpl?"
          })`,
      );
    }
  } catch (err) {
    errors.push(
      `could not list templates on storage "${tmplStorage}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Network: every bridge referenced in the net config must exist on the node.
  const wantBridges = bridgesFromConfig(args.config);
  if (wantBridges.length > 0) {
    const have = new Set(
      parseBridges(await executeRequest(global, listBridgesReq(node))),
    );
    for (const b of wantBridges) {
      if (!have.has(b)) {
        errors.push(
          `bridge "${b}" not found on ${node} (have: ${
            [...have].join(", ") || "none"
          })`,
        );
      }
    }
  }

  return errors;
}

// --- Model -----------------------------------------------------------------

/** Transport-neutral Proxmox VE LXC-container lifecycle model. */
export const model = {
  type: "@stateless/proxmox/lxc",
  version: "2026.06.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    container: {
      description: "Last observed state of a Proxmox LXC container.",
      schema: GuestStateSchema,
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
        "A container's declarative config bag (hostname, cores, memory, " +
        "rootfs, net, features, tags) as returned by PVE.",
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
        "create",
        "setConfig",
        "start",
        "stop",
        "delete",
        "resize",
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
      description: "Read a container's current runtime status.",
      arguments: LookupArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("lookup container {vmid}", { vmid });
        const handle = await recordState(ctx, vmid, "lookup");
        return { dataHandles: [handle] };
      },
    },

    getConfig: {
      description:
        "Read a container's declarative config bag (hostname, cores, memory, " +
        "rootfs, net, features, tags) — the config counterpart to lookup.",
      arguments: LookupArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        const vmid = await resolveVmid(global, args);
        const config = parseConfig(
          await executeRequest(global, ctConfigReq(node, vmid)),
        );
        const record = GuestConfigSchema.parse({
          vmid,
          node,
          config,
          recordedAt: new Date().toISOString(),
        });
        ctx.logger.info("getConfig container {vmid}: {n} keys", {
          vmid,
          n: Object.keys(config).length,
        });
        const handle = await ctx.writeResource(
          "config",
          `ct-${vmid}-config`,
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
          await executeRequest(global, listStoragesReq(node)),
        );
        const bridges = parseBridges(
          await executeRequest(global, listBridgesReq(node)),
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
        "Reconcile live PVE state into the data model — one container, or " +
        "every container on the node when no vmid/vmName is given.",
      arguments: SyncArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const global = ctx.globalArgs;
        const node = global.transport.node;
        if (args.vmid === undefined && args.vmName === undefined) {
          const list = parseGuestList(
            await executeRequest(global, listCtReq(node)),
          );
          ctx.logger.info("sync: reconciling {n} containers on {node}", {
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
        ctx.logger.info("sync container {vmid}", { vmid });
        const handle = await recordState(ctx, vmid, "sync");
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create a container from an OS template (waits for the task). " +
        "Idempotent: a re-run skips an already-present VMID.",
      arguments: CreateCtArgsSchema,
      execute: async (
        args: CreateCtOpts,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        if (await ctPresent(ctx.globalArgs, args.vmid)) {
          ctx.logger.info(
            "create: vmid {vmid} already present — skipping (idempotent)",
            { vmid: args.vmid },
          );
          const handle = await recordState(
            ctx,
            args.vmid,
            "create (existing)",
            { nameHint: args.hostname },
          );
          return { dataHandles: [handle] };
        }
        // Map the request onto the node's live capabilities and fail fast with
        // one clear message rather than an opaque PVE error mid-create.
        const problems = await verifyCreateFeasible(ctx.globalArgs, args);
        if (problems.length > 0) {
          throw new Error(
            `create: requested resources are not feasible on ${node}:\n - ` +
              problems.join("\n - "),
          );
        }
        ctx.logger.info("creating container {vmid} ({hostname}) from {tmpl}", {
          vmid: args.vmid,
          hostname: args.hostname,
          tmpl: args.ostemplate,
        });
        // Auto-tag the new container 🐊 swamp-managed so later destructive ops
        // are permitted (and non-swamp guests stay protected).
        const tagged: CreateCtOpts = {
          ...args,
          config: {
            ...(args.config ?? {}),
            tags: withManagedTag(args.config?.tags),
          },
        };
        await runAndAwait(ctx.globalArgs, createCtReq(node, tagged));
        const handle = await recordState(ctx, args.vmid, "create", {
          nameHint: args.hostname,
        });
        return { dataHandles: [handle] };
      },
    },

    setConfig: {
      description: "Apply config keys to a container.",
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
        ctx.logger.info("setConfig container {vmid}: {keys}", {
          vmid,
          keys: Object.keys(args.config).join(","),
        });
        await executeRequest(
          ctx.globalArgs,
          ctSetConfigReq(node, vmid, args.config),
        );
        const handle = await recordState(ctx, vmid, "setConfig");
        return { dataHandles: [handle] };
      },
    },

    start: {
      description:
        "Start a container; optionally read its static IPv4 from config.",
      arguments: StartArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; waitForIp: boolean },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("starting container {vmid}", { vmid });
        await runAndAwait(ctx.globalArgs, ctStartReq(node, vmid));
        const ipv4 = args.waitForIp
          ? await readConfigIpv4(ctx.globalArgs, vmid)
          : undefined;
        if (args.waitForIp && !ipv4) {
          ctx.logger.warning(
            "container {vmid} started but no static IPv4 in config (DHCP?)",
            { vmid },
          );
        }
        const handle = await recordState(ctx, vmid, "start", { ipv4 });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop a container (waits for the task).",
      arguments: StopArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; force: boolean },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        // 🐊 ownership gate: only stop swamp-managed containers (unless force).
        const guest = parseGuestList(
          await executeRequest(ctx.globalArgs, listCtReq(node)),
        ).find((g) => g.vmid === vmid);
        assertGate(guest?.tags, { force: args.force, op: "stop", vmid });
        ctx.logger.info("stopping container {vmid}", { vmid });
        await runAndAwait(ctx.globalArgs, ctStopReq(node, vmid));
        const handle = await recordState(ctx, vmid, "stop");
        return { dataHandles: [handle] };
      },
    },

    resize: {
      description:
        "Grow a container volume (rootfs or mpN). PVE only grows — shrinking " +
        "is rejected.",
      arguments: CtResizeArgsSchema,
      execute: async (
        args: { vmid?: number; vmName?: string; disk: string; size: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const node = ctx.globalArgs.transport.node;
        const vmid = await resolveVmid(ctx.globalArgs, args);
        ctx.logger.info("resize container {vmid}: {disk} += {size}", {
          vmid,
          disk: args.disk,
          size: args.size,
        });
        await executeRequest(
          ctx.globalArgs,
          ctResizeReq(node, vmid, args.disk, args.size),
        );
        const handle = await recordState(ctx, vmid, "resize");
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a container (waits for the task).",
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
        // name) is a clean no-op rather than a "no container named …" error.
        const list = parseGuestList(
          await executeRequest(ctx.globalArgs, listCtReq(node)),
        );
        let vmid = args.vmid;
        if (vmid === undefined) {
          const matches = list.filter((g) => g.name === args.vmName);
          if (matches.length > 1) {
            throw new Error(
              `container name "${args.vmName}" is ambiguous (vmids ${
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
            "container",
            `ct-${vmid}`,
            goneState,
          );
          return { dataHandles: [goneHandle] };
        }
        // 🐊 gates: only delete swamp-managed containers, and never a
        // production/protected one, unless force overrides.
        assertGate(list.find((g) => g.vmid === vmid)?.tags, {
          force: args.force,
          op: "delete",
          vmid: vmid!,
          checkProtected: true,
        });
        ctx.logger.info("deleting container {vmid} (purge={purge})", {
          vmid,
          purge: args.purge,
        });
        await runAndAwait(ctx.globalArgs, ctDeleteReq(node, vmid, args.purge));
        const state = GuestStateSchema.parse({
          vmid,
          node,
          status: "deleted",
          lastOperation: "delete",
          recordedAt: new Date().toISOString(),
        });
        const handle = await ctx.writeResource(
          "container",
          `ct-${vmid}`,
          state,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
