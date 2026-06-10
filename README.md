# @stateless/proxmox

**Transport-neutral** Proxmox VE lifecycle models for
[swamp](https://github.com/systeminit/swamp) — **`@stateless/proxmox/qemu`** for
QEMU virtual machines and **`@stateless/proxmox/lxc`** for LXC containers.

> **Renamed in 2026.06.02.1:** the VM model `@stateless/proxmox/guest` →
> **`@stateless/proxmox/qemu`** ("guest" is the Proxmox umbrella for _both_ VMs
> and containers, so it was ambiguous once the `lxc` sibling arrived). Update
> instances' `type:` to `@stateless/proxmox/qemu`.

Every operation is expressed once as a PVE request (`{verb, path, params}`) that
maps 1:1 onto the PVE REST surface, then run through one of two transports:

| Transport | How it reaches PVE                                             | When to use                                        |
| --------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `api`     | HTTPS to `{apiUrl}/api2/json…`, **API-token** auth             | the API endpoint is reachable from the swamp host  |
| `ssh`     | runs `pvesh` on the node over SSH (API call is **node-local**) | the API is private / only reachable through a jump |

The `ssh` transport is the reason this exists: it dissolves the
"API-not-reachable-from-here" problem and reuses an existing SSH jump
(`proxyCommand`/`proxyJump`), while keeping the exact same operations available
when you later switch to direct token auth. Both models share the transport,
global args, guest-reference, and config-bag schemas.

## Model: `@stateless/proxmox/qemu` (virtual machines)

| Method       | Does                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookup`     | read a VM's current status (by `vmid` or `vmName`)                                                                                         |
| `sync`       | reconcile live state into the data model — one VM, or **every VM on the node** when no ref is given                                        |
| `clone`      | clone a template into a new VM (idempotent; waits for the PVE task)                                                                        |
| `setConfig`  | apply config keys — incl. cloud-init (`ciuser`, `sshkeys`, `ipconfig0`, `net0`, …) and `cores`/`memory`                                    |
| `resizeDisk` | grow a VM disk (e.g. after cloning a small template); PVE only grows                                                                       |
| `start`      | start a VM; optionally poll the qemu guest agent for an IPv4                                                                               |
| `stop`       | stop a VM (waits for the task)                                                                                                             |
| `delete`     | delete a VM, optionally purging disks/backup refs (idempotent — "already gone" is a no-op)                                                 |
| `guestExec`  | run a command **inside** a booted VM via the qemu guest agent; capture exit code + stdout/stderr                                           |
| `nodeStatus` | snapshot **host** health: CPU load, memory/swap pressure, root-fs fill, and per-disk SMART health (node from the transport; no args)       |
| `getConfig`  | read a VM's declarative **config** bag (cores, memory, disks, `netN`, cloud-init keys, tags) — the config counterpart to `lookup`'s status |
| `nodeConfig` | read node **config** inventory: storages (id/type/content/capacity) and bridges (no args)                                                  |

VMs are **cloned from a template**. Template preparation (`qm importdisk` /
`qm template`) is intentionally **out of scope** — prepare the shared template
once, then clone it here.

## Model: `@stateless/proxmox/lxc` (containers)

| Method       | Does                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lookup`     | read a container's current status (by `vmid` or `vmName`)                                                                            |
| `sync`       | reconcile live state — one container, or **every container on the node**                                                             |
| `create`     | **create a container from an OS template** (`vztmpl`); idempotent; **feasibility-verified** (see below); waits for the task          |
| `setConfig`  | apply config keys (`net0`, `nameserver`, `features`, `onboot`, …)                                                                    |
| `resize`     | grow a volume (`rootfs` or `mpN`); PVE only grows                                                                                    |
| `start`      | start a container; with `waitForIp`, read the **static IP from config** (LXC has no agent)                                           |
| `stop`       | stop a container (waits for the task)                                                                                                |
| `delete`     | delete a container, optionally purging (idempotent)                                                                                  |
| `nodeStatus` | snapshot **host** health: CPU load, memory/swap pressure, root-fs fill, and per-disk SMART health (node from the transport; no args) |
| `getConfig`  | read a container's declarative **config** bag (hostname, cores, memory, rootfs, `netN`, features, tags)                              |
| `nodeConfig` | read node **config** inventory: storages (id/type/content/capacity) and bridges (no args)                                            |

Two deliberate differences from `qemu`, both rooted in how LXC works:

- **`create`, not `clone`** — a container is built from a `vztmpl` tarball, so
  the args carry its shape (`rootfsSize`, `cores`, `memory`, `net0`, …)
  directly.
- **No in-container `exec`** — LXC has **no guest agent**; `pct exec`/`pct push`
  are CLI-only (off the REST surface). Run in-container steps through a
  node-shell model (e.g. `@swamp/ssh` driving `pct exec`/`pct push`) so this
  model stays transport-neutral. For the same reason `start --waitForIp` reads
  the configured static IP rather than polling an agent.

### `create` maps the request onto the node and verifies it first

Before mutating, `create` **maps the requested spec onto the node's live
capabilities** and fails fast with one clear message instead of an opaque PVE
error:

- **storage** — the rootfs storage exists, supports `rootdir`, and has capacity
  ≥ `rootfsSize`; the `ostemplate` exists on its (vztmpl-capable) storage;
- **network** — every `bridge=vmbrX` referenced in the net config exists.

(Compute is sanity-bounded at the schema; live capacity headroom — PVE
overcommits — is left to a higher planning layer.)

> **Unprivileged + systemd console gotcha:** a fresh unprivileged Debian-13
> container's `console-getty`/`container-getty@N` fail with `243/CREDENTIALS`
> (systemd can't mount its credentials tmpfs), so the **PVE web console shows no
> prompt**. Set **`features: nesting=1`** (then stop/start) to fix it, and set a
> root password if you need console login (key-only builds leave root locked).

## Safety gates (tags)

`delete` and `stop` are gated by PVE tags, so the model never destroys a guest
it shouldn't — and never touches one it didn't create. This matters because a
single node usually hosts swamp-managed _and_ hand-built guests side by side.

- **`swamp` (managed) tag — "is this ours?"** `create` and `clone` auto-apply a
  `swamp` tag. `delete` and `stop` **refuse any guest that is not
  `swamp`-tagged**, so the model can never stop/delete a hand-built or
  third-party guest sharing the node.
- **`production` / `protected` tags — "is this load-bearing?"** `delete`
  **additionally refuses** any guest tagged `production` or `protected`, _even
  if_ it is `swamp`-managed. (`stop` does not check these — only the managed
  tag.)
- **`force: true`** overrides both checks for that one call. The gate exists to
  make destructive ops deliberate, not to be undefeatable — but you have to ask
  for it.

Tags are ordinary PVE tags: set them in the PVE UI, or via `setConfig`
(`{"config": {"tags": "swamp;production"}}`). The tag is the literal word
`swamp` (PVE rejects emoji in tags); the 🐊 only shows up in the refusal
message. Mark anything you don't want swamp to delete with `production` (or
`protected`):

```bash
# refuses: "🐊 … is tagged production/protected" — unless you pass force
swamp model method run pve-fleet-qemu delete --input '{"vmName":"webapp"}'
swamp model method run pve-fleet-qemu delete --input '{"vmName":"webapp","force":true}'
```

## OS-neutral by design — extend, don't fork

Neither model knows the guest OS. The methods drive the **hypervisor**;
OS-specific behaviour layers on via `export const extension`:

```typescript
import { z } from "npm:zod@4";

/** Debian-flavoured convenience methods layered on the neutral qemu model. */
export const extension = {
  type: "@stateless/proxmox/qemu",
  methods: [{
    aptUpgrade: {
      description: "apt-get update && dist-upgrade inside a Debian VM.",
      arguments: z.object({ vmid: z.number().int() }),
      execute: async (args, ctx) => {
        // call guestExec under the hood, e.g. ["sh","-lc","apt-get update && apt-get -y dist-upgrade"]
        // ...
      },
    },
  }],
};
```

## Telemetry & reporting

Beyond lifecycle, both models **gather host/guest information** so you don't
reach around the model with ad-hoc SSH:

- **Per-guest metrics** ride on the `guest` / `container` record. `lookup` and
  `sync` already call `…/status/current`, so they now also capture `cpuPct`,
  `memPct`, `mem/maxMemBytes`, `disk/maxDiskBytes`, `netin/netoutBytes` and
  `uptimeSec` (all optional — absent for a stopped guest). Network IPs come from
  `ipv4` (qemu agent / lxc config).
- **Per-node health** is the `nodeStatus` method → a `nodeStatus` resource: host
  `cpuPct`, `loadavg[1m,5m,15m]`, memory/swap pressure, root-fs fill, and a
  `disks[]` array with each physical disk's **SMART verdict**
  (`PASSED`/`FAILED`/ `UNKNOWN`) and SSD `wearoutPct`. The disk SMART read needs
  a privileged endpoint; a token without it degrades to an empty disk list
  rather than failing.

```bash
swamp model method run pve-fleet-qemu nodeStatus        # host snapshot
swamp model method run pve-fleet-qemu sync              # all guests + their metrics
```

These are the **acquisition primitives**. The bundled
**`@stateless/proxmox-fleet`** report (model-scoped) is the read/aggregate layer
over them — guests grouped by node with CPU/mem, a per-node health table (load,
memory pressure, root-fs fill), a disk-health section flagging any disk not
`PASSED`, and attention flags for host pressure / running-without-IP. It is
**one report** for host, a node, a set, or all nodes (the node lives on every
record, so it's grouping — not a variant):

```bash
swamp report get @stateless/proxmox-fleet --model pve-fleet-qemu --markdown
```

A swamp report cannot reach PVE itself — it only reads what the methods above
persisted. Run them (directly, or on a schedule via a swamp workflow) first.

## Configuration

Both models take the same transport / global args:

```yaml
# ssh transport (node-local pvesh over a jump)
globalArguments:
  name: pve-fleet
  transport:
    kind: ssh
    node: pve1
    host: 192.0.2.10
    proxyJump: admin@bastion.example
    # or: proxyCommand: "ssh -W [%h]:%p admin@bastion.example"

# api transport (direct, token auth)
globalArguments:
  name: pve-fleet
  transport:
    kind: api
    node: pve1
    apiUrl: https://192.0.2.10:8006
    tokenId: svc@pve!automation
    tokenSecret: ${{ vault.get('pve-secrets', 'token_secret') }}
    # PVE ships a self-signed cert — trust its CA (the supported way):
    caCert: ${{ vault.get('pve-secrets', 'ca_cert') }} # /etc/pve/pve-root-ca.pem
```

> **TLS note:** PVE serves a self-signed certificate. Supply the node's CA via
> `caCert` (its `/etc/pve/pve-root-ca.pem`) so the endpoint is trusted. The
> `skipTlsVerify` flag exists but is a **no-op in a standard compiled runtime**
> — Deno only honors it when launched with
> `--unsafely-ignore-certificate-errors`, which you cannot pass to the `swamp`
> binary. Use `caCert`.

### Clone + cloud-init a VM (qemu)

```yaml
- name: clone
  task:
    type: model_method
    modelIdOrName: pve-fleet-qemu
    methodName: clone
    inputs: { templateId: 9000, vmid: 9001, name: webapp, storage: local-zfs }
- name: configure
  task:
    type: model_method
    modelIdOrName: pve-fleet-qemu
    methodName: setConfig
    inputs:
      vmid: 9001
      config:
        net0: "virtio,bridge=vmbr1"
        ipconfig0: "ip=198.51.100.10/24,gw=198.51.100.1"
        ciuser: deploy
        sshkeys: "ssh-ed25519 AAAA..."
- name: boot
  task:
    type: model_method
    modelIdOrName: pve-fleet-qemu
    methodName: start
    inputs: { vmid: 9001, waitForIp: true }
```

### Create a container (lxc)

```yaml
- name: create
  task:
    type: model_method
    modelIdOrName: pve-fleet-lxc
    methodName: create
    inputs:
      vmid: 9201
      ostemplate: "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"
      hostname: edge
      storage: local-zfs
      rootfsSize: 8
      cores: 1
      memory: 512
      unprivileged: true
      features: "nesting=1" # systemd/console in unprivileged CTs
      sshPublicKeys: "ssh-ed25519 AAAA..."
      config:
        net0: "name=eth0,bridge=vmbr1,ip=198.51.100.11/24,gw=198.51.100.1"
        onboot: 1
- name: boot
  task:
    type: model_method
    modelIdOrName: pve-fleet-lxc
    methodName: start
    inputs: { vmid: 9201, waitForIp: true }
```

## Security

- `tokenSecret` is schema-marked sensitive and stored via vault; it is never
  logged.
- The `ssh` transport spawns via `Deno.Command(bin, {args})` (never a local
  shell); the remote `pvesh` command is single-quote escaped, and transport
  option values are newline/NUL-guarded at schema time.
- `guestExec` (qemu) runs an **argv array** through the guest agent — no
  intermediate shell, so arguments are not re-parsed.
- Scope the PVE API token narrowly (a dedicated user + role ACL on `/vms` and
  the target storage), not `root@pam`.

## PVE token privileges (api transport)

The `ssh` transport runs `pvesh` as the SSH user (usually `root`) and needs no
extra setup. The `api` transport authenticates with an **API token**, which must
be granted privileges explicitly — a fresh token has **none**, so calls return
`HTTP 401` ("permission check failed") until you grant a role. Required
privileges by surface:

| Surface                           | Privileges (granular)                                                                                                        | Built-in role      | Path                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| **qemu lifecycle**                | `VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt, VM.Audit, VM.Monitor` (+ `VM.GuestAgent.*` for `guestExec` on recent PVE) | `PVEVMAdmin`       | `/vms`                             |
| **lxc lifecycle**                 | container-equivalent allocate/config/power/audit                                                                             | `PVEVMAdmin`       | `/vms`                             |
| **clone / rootfs alloc**          | `Datastore.AllocateSpace, Datastore.Audit`                                                                                   | `PVEDatastoreUser` | `/storage` (or the target storage) |
| **bridges (net config)**          | `SDN.Use`                                                                                                                    | `PVESDNUser`       | `/sdn/zones`                       |
| **`nodeStatus` (host telemetry)** | `Sys.Audit` (host status) + `Datastore.Audit` (disk SMART)                                                                   | `PVEAuditor`       | `/nodes` (or `/nodes/<node>`)      |

> **Read-only?** If you only run `lookup` / `sync` / `nodeStatus` (no
> lifecycle), `PVEAuditor` on `/` alone is sufficient — it covers `VM.Audit`,
> `Sys.Audit`, and `Datastore.Audit`.

### Easy setup from the command line

Run on the PVE node as `root`. Creates a privilege-separated token and grants
the full extension privilege set with built-in roles:

```bash
# 1. Create the token (privsep=1 → its own ACL, not root's). Prints the secret ONCE.
pveum user token add root@pam swamp-deploy --privsep 1
#    → copy the printed "value" into your swamp vault:
#      swamp vault put <vault> token_secret '<value>'
#    and trust the node CA (a CA cert is not secret):
#      swamp vault put <vault> ca_cert "$(cat /etc/pve/pve-root-ca.pem)"

# 2. Grant privileges (drop the lines you don't need for a read-only token):
TOK='root@pam!swamp-deploy'
pveum acl modify /vms     --tokens "$TOK" --roles PVEVMAdmin        # lifecycle
pveum acl modify /storage --tokens "$TOK" --roles PVEDatastoreUser  # clone / rootfs alloc
pveum acl modify /sdn/zones --tokens "$TOK" --roles PVESDNUser      # bridges (net config)
pveum acl modify /nodes   --tokens "$TOK" --roles PVEAuditor        # nodeStatus (host + disk SMART)

# verify:
pveum user token permissions root@pam swamp-deploy
```

(Scope `/storage`→`/storage/<id>` and `/nodes`→`/nodes/<node>` to tighten
further. A privsep token's effective rights are the **intersection** of the
user's and the token's ACL, so the token's own ACL is what governs.)

## License

MIT — see [LICENSE.txt](LICENSE.txt).
