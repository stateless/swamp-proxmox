/**
 * Transport-neutral Proxmox VE request client.
 *
 * Every guest operation is expressed once as a {@link PveRequest}
 * (`{verb, path, params}`) that maps 1:1 onto the PVE REST surface, then run
 * through one of two executors:
 *
 *   - **api**  — HTTPS `fetch` to `{apiUrl}/api2/json{path}`, API-token auth.
 *   - **ssh**  — `pvesh <verb> <path> -k v … --output-format json` executed on
 *                the node over SSH (the API call is node-local).
 *
 * Both unwrap PVE's `{data: …}` envelope and return the inner `data`. Process
 * spawning (ssh) and `fetch` (api) are injectable seams so tests observe the
 * exact argv / URL / headers / body without a live node.
 *
 * Security: ssh argv goes through `Deno.Command(bin, {args})` — never
 * `sh -c` locally. The remote `pvesh` command is a single string parsed by the
 * node's shell, so every interpolated value is POSIX single-quote escaped
 * (`shellQuote`); transport option values are additionally newline/NUL-guarded
 * at schema time (see schemas.ts).
 *
 * @module
 */

import type { GlobalArgs, SshTransport, Transport } from "./schemas.ts";

/** PVE verbs — identical names in the REST API and the `pvesh` CLI. */
export type PveVerb = "get" | "create" | "set" | "delete";

/** One transport-neutral PVE operation. */
export interface PveRequest {
  verb: PveVerb;
  /** API path under `/api2/json`, e.g. `/nodes/pve1/qemu/9000/clone`. */
  path: string;
  /**
   * Operation parameters (form/query for api; `-k v` for pvesh). An array value
   * encodes a repeated parameter — PVE's "list" arguments such as the guest
   * agent's `command` (argv): `command=foo&command=bar` over the API, and
   * `-command foo -command bar` over pvesh.
   */
  params?: Record<string, string | number | string[]>;
}

/** Raw outcome of a spawned process. */
export interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process executor (ssh transport). Default shells via Deno. */
export type CommandExecutor = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<ExecOutcome>;

/** Injectable fetch (api transport). Default is the global `fetch`. */
export type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// Verb → HTTP method
// ---------------------------------------------------------------------------

const HTTP_METHOD: Record<PveVerb, string> = {
  get: "GET",
  create: "POST",
  set: "PUT",
  delete: "DELETE",
};

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/** POSIX single-quote escape so the node's shell treats `s` as one literal. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// SSH transport: argv + remote command assembly
// ---------------------------------------------------------------------------

/** Build the shared `-o`/`-i`/`-J`/`-p` SSH option list. */
function sshOptions(t: SshTransport): string[] {
  const o: string[] = [];
  o.push("-o", `ConnectTimeout=${t.connectTimeoutSec}`);
  o.push("-o", "BatchMode=yes");
  if (t.strictHostKeyChecking !== undefined) {
    o.push("-o", `StrictHostKeyChecking=${t.strictHostKeyChecking}`);
  }
  if (t.identityAgent !== undefined) {
    o.push("-o", `IdentityAgent=${t.identityAgent}`);
  }
  if (t.proxyCommand !== undefined) {
    o.push("-o", `ProxyCommand=${t.proxyCommand}`);
  }
  if (t.proxyJump !== undefined) o.push("-J", t.proxyJump);
  if (t.identityFile !== undefined) o.push("-i", t.identityFile);
  o.push("-p", String(t.port));
  return o;
}

/**
 * The remote `pvesh` command string (parsed by the node's shell). Path and
 * keys are constructed/validated by us; every value is shell-quoted.
 */
export function buildRemoteCommand(t: SshTransport, req: PveRequest): string {
  const parts = [t.pveshBinary, req.verb, shellQuote(req.path)];
  for (const [k, v] of Object.entries(req.params ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      parts.push(`-${k}`, shellQuote(String(item)));
    }
  }
  parts.push("--output-format", "json");
  return parts.join(" ");
}

/** Full local argv: `ssh <opts> -- user@host '<remote pvesh command>'`. */
export function buildSshArgv(t: SshTransport, req: PveRequest): string[] {
  return [
    t.sshBinary,
    ...sshOptions(t),
    "--",
    `${t.user}@${t.host}`,
    buildRemoteCommand(t, req),
  ];
}

// ---------------------------------------------------------------------------
// API transport: URL / headers / body assembly
// ---------------------------------------------------------------------------

/** Assemble the HTTP call for the api transport. */
export function buildApiCall(
  t: Extract<Transport, { kind: "api" }>,
  req: PveRequest,
): { url: string; init: RequestInit } {
  const method = HTTP_METHOD[req.verb];
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${t.tokenId}=${t.tokenSecret}`,
    Accept: "application/json",
  };
  const base = `${t.apiUrl.replace(/\/+$/, "")}/api2/json${req.path}`;
  const params = req.params ?? {};
  const hasParams = Object.keys(params).length > 0;

  if (method === "GET" || method === "DELETE") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
    }
    const url = hasParams ? `${base}?${qs.toString()}` : base;
    return { url, init: { method, headers } };
  }

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) body.append(k, String(item));
  }
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  return { url: base, init: { method, headers, body } };
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

const defaultExecutor: CommandExecutor = async (argv, opts) => {
  const cmd = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  return {
    code: out.success ? 0 : out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

let activeExecutor: CommandExecutor = defaultExecutor;
let activeFetch: FetchFn = fetch;

/** Replace the ssh process executor (test seam). */
export function setCommandExecutor(e: CommandExecutor): void {
  activeExecutor = e;
}
/** Replace the api fetch (test seam). */
export function setFetch(f: FetchFn): void {
  activeFetch = f;
}
/** Restore production executor + fetch. */
export function resetSeams(): void {
  activeExecutor = defaultExecutor;
  activeFetch = fetch;
}

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

/** Thrown when a PVE operation fails (non-zero ssh exit or HTTP >= 400). */
export class PveError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "PveError";
  }
}

/**
 * Run a request on the configured transport and return the unwrapped `data`.
 * `data` may be a UPID string for asynchronous operations (see waitForTask).
 */
export async function executeRequest(
  global: GlobalArgs,
  req: PveRequest,
): Promise<unknown> {
  const t = global.transport;
  if (t.kind === "ssh") {
    const argv = buildSshArgv(t, req);
    const outcome = await activeExecutor(argv, {
      timeoutMs: global.taskTimeoutSec * 1000,
    });
    if (outcome.code !== 0) {
      throw new PveError(
        `pvesh ${req.verb} ${req.path} failed (exit ${outcome.code})`,
        outcome.stderr.trim() || outcome.stdout.trim(),
      );
    }
    const text = outcome.stdout.trim();
    if (text.length === 0) return null;
    return parsePveshJson(text);
  }

  // api transport
  const { url, init } = buildApiCall(t, req);
  // A custom TLS client is a disposable resource — created per request and
  // closed in `finally` so we never leak a file descriptor when the api
  // transport runs in a loop. `caCert` (trusting the PVE self-signed CA) is the
  // working path; `skipTlsVerify` is honored only by a runtime started with the
  // global --unsafely-ignore-certificate-errors flag (a no-op otherwise).
  let customClient: { close?: () => void } | undefined;
  if (t.caCert || t.skipTlsVerify) {
    const opts: Record<string, unknown> = {};
    if (t.caCert) opts.caCerts = [t.caCert];
    if (t.skipTlsVerify) opts.unsafelyIgnoreCertificateErrors = true;
    // deno-lint-ignore no-explicit-any
    customClient = (Deno as any).createHttpClient?.(opts);
    if (customClient) {
      (init as RequestInit & { client?: unknown }).client = customClient;
    }
  }
  try {
    const res = await activeFetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PveError(
        `${init.method} ${req.path} failed (HTTP ${res.status})`,
        body.slice(0, 500),
      );
    }
    const json = await res.json().catch(() => null);
    return json && typeof json === "object" && "data" in json
      ? (json as { data: unknown }).data
      : json;
  } finally {
    customClient?.close?.();
  }
}

/**
 * Parse `pvesh --output-format json` stdout. Task-creating endpoints (clone,
 * start, …) make `pvesh` print human worker-progress lines ("create full clone
 * of drive …") to stdout *before* the JSON result, so a plain `JSON.parse` of
 * the whole buffer fails. Try the whole buffer, then the last JSON-parseable
 * line, then fall back to a bare UPID match.
 */
function parsePveshJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch { /* progress lines may precede the JSON — scan below */ }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* keep scanning toward the start */ }
  }
  const upid = text.match(/UPID:[^\s"]+/);
  if (upid) return upid[0];
  // Exit code was already checked (0) by the caller. Non-JSON stdout here is a
  // human confirmation from a no-data mutation (e.g. `pvesh set …/config`
  // prints "update VM <id>: …") — treat as success with no structured result.
  return null;
}

/** True for a PVE task handle (`UPID:node:…`). */
export function isUpid(x: unknown): x is string {
  return typeof x === "string" && x.startsWith("UPID:");
}

/**
 * Poll a PVE task to completion. Throws on non-OK exit status or timeout.
 * Returns the final task status object.
 */
export async function waitForTask(
  global: GlobalArgs,
  upid: string,
): Promise<Record<string, unknown>> {
  const node = global.transport.node;
  const deadline = Date.now() + global.taskTimeoutSec * 1000;
  // Raw UPID (colons intact): pvesh takes it as a CLI arg, and the PVE REST
  // API accepts it un-encoded in the path. URL-encoding breaks pvesh.
  const path = `/nodes/${node}/tasks/${upid}/status`;
  while (true) {
    const status = await executeRequest(global, { verb: "get", path }) as
      | Record<string, unknown>
      | null;
    if (status && status.status === "stopped") {
      if (status.exitstatus !== "OK") {
        throw new PveError(
          `task ${upid} ended with status ${String(status.exitstatus)}`,
        );
      }
      return status;
    }
    if (Date.now() > deadline) {
      throw new PveError(`task ${upid} did not finish within timeout`);
    }
    await new Promise((r) => setTimeout(r, global.pollIntervalSec * 1000));
  }
}
