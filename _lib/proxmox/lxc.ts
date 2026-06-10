/**
 * Pure builders for the PVE **LXC container** lifecycle {@link PveRequest}s and
 * small parsers for their responses. Mirrors {@link ./pve.ts} (QEMU VMs) but
 * targets the `/lxc` REST surface. Kept side-effect-free so the request shape
 * for every operation is unit-testable without a transport.
 *
 * Unlike QEMU, an LXC container is **created from an OS template**
 * (`POST /nodes/<node>/lxc` with `ostemplate`) rather than cloned, and there is
 * **no guest agent** — so there is deliberately no `agent/exec` builder here.
 * In-container commands are `pct exec` (CLI-only, off the REST surface); run
 * them through a node-shell model (`@swamp/ssh`) instead.
 *
 * @module
 */

import type { PveRequest } from "./client.ts";

// Node-neutral storage/bridge reads live in node.ts now; re-exported here under
// their original names so the lxc create-feasibility code + tests are unchanged.
export {
  nodeBridgesReq as listBridgesReq,
  nodeStoragesReq as listStoragesReq,
  parseBridges,
  parseStorages,
  type StorageCap,
} from "./node.ts";

const lxc = (node: string, vmid?: number) =>
  vmid === undefined ? `/nodes/${node}/lxc` : `/nodes/${node}/lxc/${vmid}`;

/** GET the container list for a node (used to resolve a name → vmid). */
export function listCtReq(node: string): PveRequest {
  return { verb: "get", path: lxc(node) };
}

/** GET current runtime status of a container. */
export function ctStatusReq(node: string, vmid: number): PveRequest {
  return { verb: "get", path: `${lxc(node, vmid)}/status/current` };
}

/** GET the full config of a container (used to read a static IP after start). */
export function ctConfigReq(node: string, vmid: number): PveRequest {
  return { verb: "get", path: `${lxc(node, vmid)}/config` };
}

/**
 * GET the container-template (`vztmpl`) listing for a storage. Used by `create`
 * to verify the `ostemplate` exists before mutating — a missing or mistyped
 * template otherwise fails deep in PVE with an opaque error, and not every
 * storage even carries `vztmpl` content.
 */
export function listTemplatesReq(node: string, storage: string): PveRequest {
  return {
    verb: "get",
    path: `/nodes/${node}/storage/${storage}/content`,
    params: { content: "vztmpl" },
  };
}

/** Options for {@link createCtReq}. */
export interface CreateCtOpts {
  vmid: number;
  /** OS template volume id, e.g. `local:vztmpl/debian-13-standard_…_amd64.tar.zst`. */
  ostemplate: string;
  hostname: string;
  /** Storage for the root volume (e.g. `local-zfs`). */
  storage: string;
  /** Root volume size in GiB. */
  rootfsSize: number;
  cores?: number;
  /** RAM in MiB. */
  memory?: number;
  /** Swap in MiB. */
  swap?: number;
  unprivileged?: boolean;
  /** PVE features string, e.g. `nesting=1`. */
  features?: string;
  /** Newline-separated authorized SSH public keys for root. */
  sshPublicKeys?: string;
  /** Whether to start the container immediately after creation. */
  start?: boolean;
  /** Extra config keys (net0, nameserver, searchdomain, onboot, …). */
  config?: Record<string, string | number>;
}

/** POST create a new container from an OS template. */
export function createCtReq(node: string, opts: CreateCtOpts): PveRequest {
  const params: Record<string, string | number> = {
    vmid: opts.vmid,
    ostemplate: opts.ostemplate,
    hostname: opts.hostname,
    storage: opts.storage,
    // PVE root-volume spec: "<storage>:<size-in-GiB>".
    rootfs: `${opts.storage}:${opts.rootfsSize}`,
  };
  if (opts.cores !== undefined) params.cores = opts.cores;
  if (opts.memory !== undefined) params.memory = opts.memory;
  if (opts.swap !== undefined) params.swap = opts.swap;
  if (opts.unprivileged !== undefined) {
    params.unprivileged = opts.unprivileged ? 1 : 0;
  }
  if (opts.features !== undefined) params.features = opts.features;
  if (opts.sshPublicKeys !== undefined) {
    params["ssh-public-keys"] = opts.sshPublicKeys;
  }
  if (opts.start !== undefined) params.start = opts.start ? 1 : 0;
  for (const [k, v] of Object.entries(opts.config ?? {})) params[k] = v;
  return { verb: "create", path: lxc(node), params };
}

/** PUT config keys onto a container. */
export function ctSetConfigReq(
  node: string,
  vmid: number,
  config: Record<string, string | number>,
): PveRequest {
  return { verb: "set", path: `${lxc(node, vmid)}/config`, params: config };
}

/** POST start. */
export function ctStartReq(node: string, vmid: number): PveRequest {
  return { verb: "create", path: `${lxc(node, vmid)}/status/start` };
}

/** POST stop. */
export function ctStopReq(node: string, vmid: number): PveRequest {
  return { verb: "create", path: `${lxc(node, vmid)}/status/stop` };
}

/** DELETE a container (optionally purging from backup/HA and disks). */
export function ctDeleteReq(
  node: string,
  vmid: number,
  purge: boolean,
): PveRequest {
  const params: Record<string, string | number> = {};
  if (purge) {
    params.purge = 1;
    params["destroy-unreferenced-disks"] = 1;
  }
  return { verb: "delete", path: lxc(node, vmid), params };
}

/**
 * PUT a root/mount-point volume resize. `disk` is `rootfs` or `mpN`; `size` is
 * an increment like `+4G` or an absolute like `16G`. PVE only **grows**.
 */
export function ctResizeReq(
  node: string,
  vmid: number,
  disk: string,
  size: string,
): PveRequest {
  return {
    verb: "set",
    path: `${lxc(node, vmid)}/resize`,
    params: { disk, size },
  };
}

/**
 * Extract the first static IPv4 from an LXC config's `netN` entries. PVE
 * encodes them as `name=eth0,bridge=vmbr0,ip=198.51.100.21/24,gw=…`. Returns the
 * bare address (no CIDR), or undefined for DHCP/none.
 */
export function extractCtConfigIpv4(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  for (const [key, val] of Object.entries(config as Record<string, unknown>)) {
    if (!/^net\d+$/.test(key) || typeof val !== "string") continue;
    const m = val.match(/(?:^|,)ip=(\d+\.\d+\.\d+\.\d+)(?:\/\d+)?/);
    if (m && m[1] !== "127.0.0.1") return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Feasibility parsers — map a requested spec onto the node's live capabilities
// (storage content/capacity, bridges) so `create` can verify before mutating.
// ---------------------------------------------------------------------------

/** Volids from a storage content listing (e.g. `isos:vztmpl/debian-…tar.zst`). */
export function parseVolids(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((e) => {
    const v = (e as Record<string, unknown> | null)?.volid;
    return typeof v === "string" ? [v] : [];
  });
}

/** Storage id parsed from a volid / ostemplate spec ("storage:type/file"). */
export function storageOfVolid(volid: string): string {
  const i = volid.indexOf(":");
  return i === -1 ? volid : volid.slice(0, i);
}

/**
 * Extract the bridges referenced by a config bag's `netN` entries — PVE encodes
 * them as `name=eth0,bridge=vmbr1,ip=…`. Returns unique bridge names.
 */
export function bridgesFromConfig(
  config: Record<string, string | number> | undefined,
): string[] {
  const out = new Set<string>();
  for (const [key, val] of Object.entries(config ?? {})) {
    if (!/^net\d+$/.test(key) || typeof val !== "string") continue;
    const m = val.match(/(?:^|,)bridge=([^,]+)/);
    if (m) out.add(m[1]);
  }
  return [...out];
}
