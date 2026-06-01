/**
 * Zod schemas + inferred types for `@stateless/proxmox/guest`.
 *
 * The model is **transport-neutral**: the same guest-lifecycle operations run
 * either over the Proxmox REST API directly (`kind: "api"`, token auth) or by
 * executing `pvesh` on the node over SSH (`kind: "ssh"`). `pvesh` mirrors the
 * REST surface 1:1, so a single internal request shape (see client.ts) drives
 * both. This module concentrates every schema so the validation surface is
 * auditable in one read and tests can import the schemas directly.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/**
 * Refuse strings carrying newlines or NUL bytes in positions that become SSH
 * option values (proxyCommand, identityFile, …) or `pvesh` argv. OpenSSH
 * option parsing is not airtight against embedded newlines; rejecting them at
 * schema time stops a crafted config from smuggling extra `-o` flags or argv.
 */
export function safeArg(label: string): z.ZodString {
  return z.string().refine(
    // deno-lint-ignore no-control-regex
    (s) => !/[\x00\r\n]/.test(s),
    { message: `${label} must not contain newlines or NUL bytes` },
  );
}

/** A Proxmox node name (e.g. "sh1"). */
const NodeName = safeArg("node").min(1);

// ---------------------------------------------------------------------------
// Transport (api | ssh)
// ---------------------------------------------------------------------------

/**
 * Direct REST transport. Uses PVE API-token auth — the least-privilege,
 * stateless method (`Authorization: PVEAPIToken=user@realm!id=secret`).
 * Requires the API endpoint to be network-reachable from the swamp host.
 */
export const ApiTransportSchema = z.object({
  kind: z.literal("api"),
  node: NodeName,
  apiUrl: safeArg("apiUrl").url().describe(
    "PVE API base, e.g. https://192.168.12.10:8006",
  ),
  tokenId: safeArg("tokenId").min(1).describe(
    "API token id: user@realm!tokenname (e.g. svc-swamp@pve!build)",
  ),
  tokenSecret: z.string().min(1).meta({ sensitive: true }).describe(
    "API token secret — supply via `${{ vault.get('<vault>', '<key>') }}`.",
  ),
  caCert: z.string().min(1).optional().describe(
    "PEM of the CA that signed the PVE endpoint cert (PVE's is self-signed: " +
      "`/etc/pve/pve-root-ca.pem` on the node). The supported way to trust a " +
      "self-signed PVE endpoint — newlines are preserved, so it is NOT " +
      "newline-guarded; pass it as-is (a CA cert is not secret).",
  ),
  skipTlsVerify: z.boolean().default(false).describe(
    "Attempt to skip TLS verification. NOTE: in a standard (compiled) swamp " +
      "runtime this is a no-op — Deno only honors it when started with the " +
      "global --unsafely-ignore-certificate-errors flag. For a self-signed " +
      "PVE cert, prefer `caCert`.",
  ),
});
export type ApiTransport = z.infer<typeof ApiTransportSchema>;

/**
 * SSH transport. Runs `pvesh` (and, where the REST API has no equivalent,
 * `qm`) on the node itself, so the API call is node-local — no API
 * reachability needed from the swamp host, and an existing jump is reused via
 * `proxyCommand`/`proxyJump`. Auth is SSH key/agent only (no passwords here).
 */
export const SshTransportSchema = z.object({
  kind: z.literal("ssh"),
  node: NodeName,
  host: safeArg("host").min(1).describe("SSH target (address of the node)."),
  user: safeArg("user").default("root").describe(
    "SSH user — must be able to run pvesh/qm (typically root).",
  ),
  port: z.number().int().positive().max(65535).default(22),
  proxyJump: safeArg("proxyJump").optional(),
  proxyCommand: safeArg("proxyCommand").optional(),
  identityFile: safeArg("identityFile").optional(),
  identityAgent: safeArg("identityAgent").optional(),
  strictHostKeyChecking: z.enum(["yes", "accept-new", "no", "off"]).optional(),
  connectTimeoutSec: z.number().int().positive().default(15),
  sshBinary: safeArg("sshBinary").min(1).default("ssh"),
  pveshBinary: safeArg("pveshBinary").min(1).default("pvesh"),
});
export type SshTransport = z.infer<typeof SshTransportSchema>;

export const TransportSchema = z.discriminatedUnion("kind", [
  ApiTransportSchema,
  SshTransportSchema,
]);
export type Transport = z.infer<typeof TransportSchema>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this guest fleet."),
  transport: TransportSchema,
  /** Seconds to poll a PVE task (clone/start/stop) before giving up. */
  taskTimeoutSec: z.number().int().positive().default(300),
  /** Seconds between task/agent polls. */
  pollIntervalSec: z.number().int().positive().default(3),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Guest reference (vmid and/or name)
// ---------------------------------------------------------------------------

/** PVE VMIDs are >= 100 (100 and below are reserved). */
const Vmid = z.number().int().min(100).max(999_999_999);

const GuestRef = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional().describe(
    "Guest name; resolved to a vmid when vmid is omitted.",
  ),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});

// ---------------------------------------------------------------------------
// Method-specific argument schemas
// ---------------------------------------------------------------------------

/** A bag of PVE config keys (net0, ipconfig0, ciuser, sshkeys, memory, …). */
const ConfigBag = z.record(
  z.string().regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    "config key must be alphanumeric",
  ),
  z.union([z.string(), z.number()]),
);

export const LookupArgsSchema = GuestRef;
export type LookupArgs = z.infer<typeof LookupArgsSchema>;

/**
 * `sync` reconciles live PVE state back into the data model. Unlike the other
 * guest refs there is **no refine**: omitting both `vmid` and `vmName` syncs
 * every guest on the node (a single fan-out read), which is the usual way to
 * refresh current knowledge of the fleet for lifecycle management.
 */
export const SyncArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional().describe(
    "Sync just this guest; omit (with vmid) to sync all guests on the node.",
  ),
});
export type SyncArgs = z.infer<typeof SyncArgsSchema>;

/**
 * `guestExec` runs a command inside a booted guest via the qemu guest agent.
 * The command is an argv array (program + arguments); it is the generic,
 * OS-neutral primitive higher layers build on (in-guest config, health probes,
 * package updates) instead of reaching around the model with raw SSH.
 */
export const GuestExecArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional(),
  command: z.array(z.string().min(1)).min(1).describe(
    'argv: program + arguments, e.g. ["systemctl", "is-active", "nginx"].',
  ),
  timeoutSec: z.number().int().positive().default(30).describe(
    "Max seconds to wait for the command to finish inside the guest.",
  ),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});
export type GuestExecArgs = z.infer<typeof GuestExecArgsSchema>;

export const CloneArgsSchema = z.object({
  templateId: Vmid.describe("Source template VMID to clone from."),
  vmid: Vmid.describe("New guest VMID."),
  name: safeArg("name").min(1).describe("New guest name."),
  full: z.boolean().default(true).describe("Full clone (vs linked)."),
  storage: safeArg("storage").min(1).optional().describe(
    "Target storage for a full clone (defaults to the template's).",
  ),
});
export type CloneArgs = z.infer<typeof CloneArgsSchema>;

export const SetConfigArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional(),
  config: ConfigBag.describe("PVE config keys to apply."),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});
export type SetConfigArgs = z.infer<typeof SetConfigArgsSchema>;

export const StartArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional(),
  waitForIp: z.boolean().default(false).describe(
    "After start, poll the guest agent for an IPv4 address.",
  ),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});
export type StartArgs = z.infer<typeof StartArgsSchema>;

export const StopArgsSchema = GuestRef;
export type StopArgs = z.infer<typeof StopArgsSchema>;

/**
 * `resizeDisk` grows a guest disk. The lifecycle model's thin mechanism for the
 * "vm specs" gap: cores/memory already flow through `setConfig`, but a cloned
 * guest inherits the template's small disk, so growing it needs its own call.
 * PVE only **grows** disks — shrinking is rejected by the API.
 */
export const ResizeDiskArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional(),
  disk: safeArg("disk").regex(
    /^(scsi|sata|virtio|ide)\d+$/,
    "disk must be a disk key like scsi0, virtio0, sata0",
  ).default("scsi0").describe("Disk config key to grow (e.g. scsi0)."),
  size: safeArg("size").regex(
    /^\+?\d+(\.\d+)?[KMGT]?$/,
    'size must be an increment like "+20G" or an absolute like "50G"',
  ).describe("Increment (`+20G`) or absolute target (`50G`); PVE only grows."),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});
export type ResizeDiskArgs = z.infer<typeof ResizeDiskArgsSchema>;

export const DeleteArgsSchema = z.object({
  vmid: Vmid.optional(),
  vmName: safeArg("vmName").min(1).optional(),
  purge: z.boolean().default(true).describe(
    "Also remove the VM from backup jobs and HA, and purge disks.",
  ),
}).refine((a) => a.vmid !== undefined || a.vmName !== undefined, {
  message: "Provide vmid or vmName",
});
export type DeleteArgs = z.infer<typeof DeleteArgsSchema>;

// ---------------------------------------------------------------------------
// Resource record schema
// ---------------------------------------------------------------------------

/** Stable guest-state record written after lifecycle operations. */
export const GuestStateSchema = z.object({
  vmid: z.number().int(),
  name: z.string().optional(),
  node: z.string(),
  status: z.string().describe("running | stopped | unknown."),
  ipv4: z.string().optional().describe("First non-loopback IPv4, if known."),
  lastOperation: z.string(),
  recordedAt: z.string(),
});
export type GuestState = z.infer<typeof GuestStateSchema>;

/** Result of a `guestExec` command run inside a guest. */
export const ExecResultSchema = z.object({
  vmid: z.number().int(),
  node: z.string(),
  command: z.array(z.string()),
  exited: z.boolean(),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  recordedAt: z.string(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;
