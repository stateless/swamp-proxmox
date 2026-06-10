/**
 * Node-level PVE request builders + parsers — host health primitives shared by
 * both guest models (`/qemu` and `/lxc`). Unlike {@link ./pve.ts} and
 * {@link ./lxc.ts} these target the `/nodes/<node>` surface directly (not a
 * guest), so they are guest-type-neutral and live in one place.
 *
 * Surfaces the signals the lifecycle resources don't carry: host CPU load,
 * memory/swap pressure, root-filesystem fill, and per-physical-disk SMART
 * health. Plus {@link parseGuestMetrics}, the shared extractor for the per-guest
 * cpu/mem/disk/net numbers already returned by `…/status/current` (both qemu and
 * lxc) that the thin `guest` state record otherwise discards.
 *
 * Kept side-effect-free so every request shape and parse is unit-testable
 * without a transport.
 *
 * @module
 */

import type { PveRequest } from "./client.ts";

/** GET the node's runtime status (cpu, loadavg, memory, swap, rootfs, uptime). */
export function nodeStatusReq(node: string): PveRequest {
  return { verb: "get", path: `/nodes/${node}/status` };
}

/** GET the node's physical disk list (incl. SMART health + SSD wearout). */
export function nodeDisksReq(node: string): PveRequest {
  return { verb: "get", path: `/nodes/${node}/disks/list` };
}

/** GET the node's storage list (id, type, content types, capacity). */
export function nodeStoragesReq(node: string): PveRequest {
  return { verb: "get", path: `/nodes/${node}/storage` };
}

/** GET the node's network interfaces, filtered to bridges. */
export function nodeBridgesReq(node: string): PveRequest {
  return {
    verb: "get",
    path: `/nodes/${node}/network`,
    params: { type: "bridge" },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number, else undefined (PVE sometimes returns "N/A"). */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

/** used/total → percent (0–100, one decimal), or undefined when not derivable. */
function pct(
  used: number | undefined,
  total: number | undefined,
): number | undefined {
  if (used === undefined || total === undefined || total <= 0) return undefined;
  return Math.round((used / total) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Node status
// ---------------------------------------------------------------------------

/** Typed host status parsed from `/nodes/<node>/status`. */
export interface NodeStatusFacts {
  /** Host CPU utilisation as a percent (PVE reports a 0–1 fraction). */
  cpuPct?: number;
  /** Logical CPU count, when reported. */
  cpus?: number;
  /** Load average [1m, 5m, 15m] (PVE reports these as strings). */
  loadavg?: number[];
  memTotal?: number;
  memUsed?: number;
  /** Memory pressure: used/total as a percent. */
  memPct?: number;
  swapTotal?: number;
  swapUsed?: number;
  swapPct?: number;
  rootfsTotal?: number;
  rootfsUsed?: number;
  /** Root-filesystem fill: used/total as a percent. */
  rootfsPct?: number;
  uptimeSec?: number;
  kernelVersion?: string;
  pveVersion?: string;
}

/** Coerce a `/nodes/<node>/status` response into typed host facts. */
export function parseNodeStatus(data: unknown): NodeStatusFacts {
  const r = (data ?? {}) as Record<string, unknown>;
  const mem = (r.memory ?? {}) as Record<string, unknown>;
  const swap = (r.swap ?? {}) as Record<string, unknown>;
  const root = (r.rootfs ?? {}) as Record<string, unknown>;
  const cpuinfo = (r.cpuinfo ?? {}) as Record<string, unknown>;

  const cpuFrac = num(r.cpu);
  const memTotal = num(mem.total);
  const memUsed = num(mem.used);
  const swapTotal = num(swap.total);
  const swapUsed = num(swap.used);
  const rootTotal = num(root.total);
  const rootUsed = num(root.used);

  const loadavg = Array.isArray(r.loadavg)
    ? r.loadavg.map(num).filter((n): n is number => n !== undefined)
    : undefined;

  return {
    cpuPct: cpuFrac === undefined ? undefined : Math.round(cpuFrac * 1000) / 10,
    cpus: num(cpuinfo.cpus) ?? num(r.cpus),
    loadavg: loadavg && loadavg.length ? loadavg : undefined,
    memTotal,
    memUsed,
    memPct: pct(memUsed, memTotal),
    swapTotal,
    swapUsed,
    swapPct: pct(swapUsed, swapTotal),
    rootfsTotal: rootTotal,
    rootfsUsed: rootUsed,
    rootfsPct: pct(rootUsed, rootTotal),
    uptimeSec: num(r.uptime),
    kernelVersion: typeof r.kversion === "string" ? r.kversion : undefined,
    pveVersion: typeof r.pveversion === "string" ? r.pveversion : undefined,
  };
}

// ---------------------------------------------------------------------------
// Node disks (SMART health)
// ---------------------------------------------------------------------------

/** A physical disk's health summary from `/nodes/<node>/disks/list`. */
export interface NodeDiskFacts {
  device: string;
  type?: string;
  model?: string;
  serial?: string;
  sizeBytes?: number;
  /** SMART overall verdict: PASSED | FAILED | UNKNOWN (uppercased). */
  health: string;
  /**
   * SSD/NVMe life remaining as a percent, when PVE reports it (higher is
   * healthier; PVE returns "N/A" for spinning disks — dropped here).
   */
  wearoutPct?: number;
  /** What PVE sees using the disk (ZFS, LVM, partitions, …), when known. */
  usedBy?: string;
}

/** True when a disk's SMART verdict is anything other than a clean PASSED. */
export function isDiskUnhealthy(d: NodeDiskFacts): boolean {
  return d.health.toUpperCase() !== "PASSED";
}

/** Coerce a `/nodes/<node>/disks/list` response into typed disk facts. */
export function parseNodeDisks(data: unknown): NodeDiskFacts[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    const device = typeof r.devpath === "string" ? r.devpath : undefined;
    if (!device) return [];
    const health = typeof r.health === "string" && r.health.trim() !== ""
      ? r.health.toUpperCase()
      : "UNKNOWN";
    return [{
      device,
      type: typeof r.type === "string" ? r.type : undefined,
      model: typeof r.model === "string" ? r.model.trim() : undefined,
      serial: typeof r.serial === "string" ? r.serial : undefined,
      sizeBytes: num(r.size),
      health,
      wearoutPct: num(r.wearout),
      usedBy: typeof r.used === "string" ? r.used : undefined,
    }];
  });
}

// ---------------------------------------------------------------------------
// Node config — storage + bridges (node-neutral; the lxc model re-exports
// these for its create-feasibility checks).
// ---------------------------------------------------------------------------

/** A node storage's capabilities (from {@link nodeStoragesReq}). */
export interface StorageCap {
  storage: string;
  type?: string;
  /** Content types the storage accepts (vztmpl, rootdir, images, …). */
  content: string[];
  /** Bytes available, when reported. */
  avail?: number;
}

/** Coerce the `/nodes/<node>/storage` list into typed capabilities. */
export function parseStorages(data: unknown): StorageCap[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((e) => {
    if (!e || typeof e !== "object" || !("storage" in e)) return [];
    const r = e as Record<string, unknown>;
    const content = typeof r.content === "string"
      ? r.content.split(",").map((c) => c.trim()).filter(Boolean)
      : [];
    return [{
      storage: String(r.storage),
      type: typeof r.type === "string" ? r.type : undefined,
      content,
      avail: typeof r.avail === "number" ? r.avail : undefined,
    }];
  });
}

/** Bridge interface names from a `/nodes/<node>/network?type=bridge` list. */
export function parseBridges(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((e) => {
    const i = (e as Record<string, unknown> | null)?.iface;
    return typeof i === "string" ? [i] : [];
  });
}

// ---------------------------------------------------------------------------
// Per-guest metrics (shared by qemu + lxc /status/current)
// ---------------------------------------------------------------------------

/** Runtime metrics extracted from a guest `…/status/current` response. */
export interface GuestMetrics {
  /** Guest CPU utilisation as a percent (PVE reports a 0–1 fraction). */
  cpuPct?: number;
  cpus?: number;
  memBytes?: number;
  maxMemBytes?: number;
  /** Memory fill: mem/maxmem as a percent. */
  memPct?: number;
  diskBytes?: number;
  maxDiskBytes?: number;
  netinBytes?: number;
  netoutBytes?: number;
  uptimeSec?: number;
}

/**
 * Extract per-guest runtime metrics from the `…/status/current` payload both
 * guest models already fetch. Returns an all-undefined object for a stopped or
 * statusless guest (every field optional) — callers spread it onto the state
 * record without further guarding.
 */
export function parseGuestMetrics(cur: unknown): GuestMetrics {
  const r = (cur ?? {}) as Record<string, unknown>;
  const cpuFrac = num(r.cpu);
  const memBytes = num(r.mem);
  const maxMemBytes = num(r.maxmem);
  return {
    cpuPct: cpuFrac === undefined ? undefined : Math.round(cpuFrac * 1000) / 10,
    cpus: num(r.cpus),
    memBytes,
    maxMemBytes,
    memPct: pct(memBytes, maxMemBytes),
    diskBytes: num(r.disk),
    maxDiskBytes: num(r.maxdisk),
    netinBytes: num(r.netin),
    netoutBytes: num(r.netout),
    uptimeSec: num(r.uptime),
  };
}
