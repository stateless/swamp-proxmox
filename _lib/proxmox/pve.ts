/**
 * Pure builders for the PVE guest-lifecycle {@link PveRequest}s and small
 * parsers for their responses. Kept side-effect-free so the request shape for
 * every operation is unit-testable without a transport.
 *
 * @module
 */

import type { PveRequest } from "./client.ts";

const qemu = (node: string, vmid?: number) =>
  vmid === undefined ? `/nodes/${node}/qemu` : `/nodes/${node}/qemu/${vmid}`;

/** GET the guest list for a node (used to resolve a name → vmid). */
export function listGuestsReq(node: string): PveRequest {
  return { verb: "get", path: qemu(node) };
}

/** GET current runtime status of a guest. */
export function statusReq(node: string, vmid: number): PveRequest {
  return { verb: "get", path: `${qemu(node, vmid)}/status/current` };
}

/** POST a clone of `templateId` into a new guest. */
export function cloneReq(
  node: string,
  templateId: number,
  opts: { vmid: number; name: string; full: boolean; storage?: string },
): PveRequest {
  const params: Record<string, string | number> = {
    newid: opts.vmid,
    name: opts.name,
    full: opts.full ? 1 : 0,
  };
  if (opts.storage !== undefined) params.storage = opts.storage;
  return { verb: "create", path: `${qemu(node, templateId)}/clone`, params };
}

/** PUT config keys onto a guest. */
export function setConfigReq(
  node: string,
  vmid: number,
  config: Record<string, string | number>,
): PveRequest {
  return { verb: "set", path: `${qemu(node, vmid)}/config`, params: config };
}

/** GET a guest's full config bag (cores, memory, disks, net, cloud-init, tags). */
export function configReq(node: string, vmid: number): PveRequest {
  return { verb: "get", path: `${qemu(node, vmid)}/config` };
}

/** POST start. */
export function startReq(node: string, vmid: number): PveRequest {
  return { verb: "create", path: `${qemu(node, vmid)}/status/start` };
}

/**
 * PUT a disk resize. `size` is an increment like `+20G` or an absolute like
 * `50G`; PVE only ever **grows** a disk (it rejects shrinking). `disk` is a
 * config key such as `scsi0`.
 */
export function resizeDiskReq(
  node: string,
  vmid: number,
  disk: string,
  size: string,
): PveRequest {
  return {
    verb: "set",
    path: `${qemu(node, vmid)}/resize`,
    params: { disk, size },
  };
}

/** POST stop. */
export function stopReq(node: string, vmid: number): PveRequest {
  return { verb: "create", path: `${qemu(node, vmid)}/status/stop` };
}

/** DELETE a guest (optionally purging from backup/HA and disks). */
export function deleteReq(
  node: string,
  vmid: number,
  purge: boolean,
): PveRequest {
  const params: Record<string, string | number> = {};
  if (purge) {
    params.purge = 1;
    params["destroy-unreferenced-disks"] = 1;
  }
  return { verb: "delete", path: qemu(node, vmid), params };
}

/** GET guest-agent network interfaces (requires qemu-guest-agent running). */
export function agentInterfacesReq(node: string, vmid: number): PveRequest {
  return {
    verb: "get",
    path: `${qemu(node, vmid)}/agent/network-get-interfaces`,
  };
}

/**
 * POST a command (argv) to the guest agent for execution. Returns `{pid}` to be
 * polled via {@link agentExecStatusReq}. Requires qemu-guest-agent in the guest.
 */
export function agentExecReq(
  node: string,
  vmid: number,
  command: string[],
): PveRequest {
  return {
    verb: "create",
    path: `${qemu(node, vmid)}/agent/exec`,
    params: { command },
  };
}

/** GET the status/output of a prior agent exec by its pid. */
export function agentExecStatusReq(
  node: string,
  vmid: number,
  pid: number,
): PveRequest {
  return {
    verb: "get",
    path: `${qemu(node, vmid)}/agent/exec-status`,
    params: { pid },
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** A guest summary as returned in the `/qemu` (or `/lxc`) list. */
export interface GuestSummary {
  vmid: number;
  name?: string;
  status?: string;
  /** PVE guest tags (the node's `tags` string, split + lowercased). */
  tags?: string[];
}

/** Split a PVE `tags` value ("a;b" or "a,b") into a lowercased array. */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/[;,]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Tags that mark a guest as protected from deletion — `delete` refuses unless
 * called with `force: true`. PVE lowercases tags, so match in lowercase.
 */
export const PROTECTED_TAGS = ["production", "protected"];

/** True if any of the guest's tags marks it protected from deletion. */
export function isProtected(tags: string[] | undefined): boolean {
  return (tags ?? []).some((t) => PROTECTED_TAGS.includes(t));
}

/**
 * The tag marking a guest as swamp-managed. Destructive methods (`delete`,
 * `stop`) refuse to touch a guest that lacks it, so swamp never operates on the
 * hand-managed fleet by accident. `create`/`clone` apply it to new guests.
 */
export const MANAGED_TAG = "swamp";

/** True if the guest is swamp-managed (tagged `swamp`). */
export function isManaged(tags: string[] | undefined): boolean {
  return (tags ?? []).includes(MANAGED_TAG);
}

/** Merge `MANAGED_TAG` into an existing PVE tags string (idempotent). */
export function withManagedTag(existing: unknown): string {
  const tags = parseTags(existing);
  if (!tags.includes(MANAGED_TAG)) tags.push(MANAGED_TAG);
  return tags.join(";");
}

/**
 * Enforce the safety gates before a destructive op, given the target guest's
 * tags. Throws unless: the guest is swamp-managed (tagged `swamp`), and — when
 * `checkProtected` — not tagged production/protected. `force` skips both.
 */
export function assertGate(
  tags: string[] | undefined,
  opts: { force: boolean; op: string; vmid: number; checkProtected?: boolean },
): void {
  if (opts.force) return;
  if (!isManaged(tags)) {
    throw new Error(
      `🐊 ${opts.op}: guest ${opts.vmid} is not swamp-managed (no ` +
        `'${MANAGED_TAG}' tag) — refusing to touch a non-swamp guest. ` +
        `Pass force=true to override.`,
    );
  }
  if (opts.checkProtected && isProtected(tags)) {
    throw new Error(
      `🐊 ${opts.op}: guest ${opts.vmid} is tagged production/protected — ` +
        `refusing to delete. Pass force=true to override.`,
    );
  }
}

/** Coerce the `/qemu` (or `/lxc`) list response into typed summaries. */
export function parseGuestList(data: unknown): GuestSummary[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((g) => {
    if (g && typeof g === "object" && "vmid" in g) {
      const rec = g as Record<string, unknown>;
      return [{
        vmid: Number(rec.vmid),
        name: typeof rec.name === "string" ? rec.name : undefined,
        status: typeof rec.status === "string" ? rec.status : undefined,
        tags: parseTags(rec.tags),
      }];
    }
    return [];
  });
}

/** Find a guest's vmid by exact name. Throws if not found / ambiguous. */
export function resolveVmidFromList(
  guests: GuestSummary[],
  name: string,
): number {
  const matches = guests.filter((g) => g.name === name);
  if (matches.length === 0) throw new Error(`no guest named "${name}"`);
  if (matches.length > 1) {
    throw new Error(
      `guest name "${name}" is ambiguous (vmids ${
        matches.map((m) => m.vmid).join(", ")
      })`,
    );
  }
  return matches[0].vmid;
}

/** The pid returned by `agent/exec`. Throws if the response lacks one. */
export function parseExecPid(data: unknown): number {
  const pid = (data as { pid?: unknown })?.pid;
  if (typeof pid === "number") return pid;
  if (typeof pid === "string" && /^\d+$/.test(pid)) return Number(pid);
  throw new Error("guest agent exec did not return a pid");
}

/** Outcome of a guest-agent command execution. */
export interface GuestExecResult {
  exited: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Coerce an `agent/exec-status` response. PVE reports completion as `exited`
 * (0/1), the program's `exitcode`, and captured `out-data`/`err-data`.
 */
export function parseExecStatus(data: unknown): GuestExecResult {
  const rec = (data ?? {}) as Record<string, unknown>;
  const exited = rec.exited === 1 || rec.exited === true;
  const exitCode = typeof rec.exitcode === "number" ? rec.exitcode : undefined;
  const stdout = typeof rec["out-data"] === "string"
    ? rec["out-data"] as string
    : undefined;
  const stderr = typeof rec["err-data"] === "string"
    ? rec["err-data"] as string
    : undefined;
  return { exited, exitCode, stdout, stderr };
}

/**
 * Coerce a guest `/config` response into a flat scalar bag. PVE config values
 * are scalars (`cores`, `memory`, `scsi0`, `net0`, `ipconfig0`, `tags`, …) plus
 * a `digest`; booleans are normalised to 0/1 and non-scalars dropped, so the
 * record round-trips cleanly through the resource schema.
 */
export function parseConfig(data: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = v;
      else if (typeof v === "boolean") out[k] = v ? 1 : 0;
    }
  }
  return out;
}

/**
 * Extract the first non-loopback IPv4 from a guest-agent
 * `network-get-interfaces` result, if any.
 */
export function extractIpv4(data: unknown): string | undefined {
  const result = (data as { result?: unknown })?.result;
  if (!Array.isArray(result)) return undefined;
  for (const iface of result) {
    const addrs = (iface as { "ip-addresses"?: unknown })?.["ip-addresses"];
    if (!Array.isArray(addrs)) continue;
    for (const a of addrs) {
      const rec = a as Record<string, unknown>;
      if (
        rec["ip-address-type"] === "ipv4" &&
        typeof rec["ip-address"] === "string" &&
        rec["ip-address"] !== "127.0.0.1"
      ) {
        return rec["ip-address"];
      }
    }
  }
  return undefined;
}
