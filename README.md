# @stateless/proxmox

**Transport-neutral** Proxmox VE lifecycle models for
[swamp](https://github.com/systeminit/swamp) — **`@stateless/proxmox/qemu`** for
QEMU virtual machines and **`@stateless/proxmox/lxc`** for LXC containers.

> **Renamed in 2026.06.02.1:** the VM model `@stateless/proxmox/guest` →
> **`@stateless/proxmox/qemu`** ("guest" is the Proxmox umbrella for *both* VMs
> and containers, so it was ambiguous once the `lxc` sibling arrived). Update
> instances' `type:` to `@stateless/proxmox/qemu`.

Every operation is expressed once as a PVE request (`{verb, path, params}`) that
maps 1:1 onto the PVE REST surface, then run through one of two transports:

| Transport | How it reaches PVE | When to use |
| --------- | ------------------ | ----------- |
| `api` | HTTPS to `{apiUrl}/api2/json…`, **API-token** auth | the API endpoint is reachable from the swamp host |
| `ssh` | runs `pvesh` on the node over SSH (API call is **node-local**) | the API is private / only reachable through a jump |

The `ssh` transport is the reason this exists: it dissolves the
"API-not-reachable-from-here" problem and reuses an existing SSH jump
(`proxyCommand`/`proxyJump`), while keeping the exact same operations available
when you later switch to direct token auth. Both models share the transport,
global args, guest-reference, and config-bag schemas.

## Model: `@stateless/proxmox/qemu` (virtual machines)

| Method | Does |
| ------ | ---- |
| `lookup` | read a VM's current status (by `vmid` or `vmName`) |
| `sync` | reconcile live state into the data model — one VM, or **every VM on the node** when no ref is given |
| `clone` | clone a template into a new VM (idempotent; waits for the PVE task) |
| `setConfig` | apply config keys — incl. cloud-init (`ciuser`, `sshkeys`, `ipconfig0`, `net0`, …) and `cores`/`memory` |
| `resizeDisk` | grow a VM disk (e.g. after cloning a small template); PVE only grows |
| `start` | start a VM; optionally poll the qemu guest agent for an IPv4 |
| `stop` | stop a VM (waits for the task) |
| `delete` | delete a VM, optionally purging disks/backup refs (idempotent — "already gone" is a no-op) |
| `guestExec` | run a command **inside** a booted VM via the qemu guest agent; capture exit code + stdout/stderr |

VMs are **cloned from a template**. Template preparation (`qm importdisk` /
`qm template`) is intentionally **out of scope** — prepare the shared template
once, then clone it here.

## Model: `@stateless/proxmox/lxc` (containers)

| Method | Does |
| ------ | ---- |
| `lookup` | read a container's current status (by `vmid` or `vmName`) |
| `sync` | reconcile live state — one container, or **every container on the node** |
| `create` | **create a container from an OS template** (`vztmpl`); idempotent; **feasibility-verified** (see below); waits for the task |
| `setConfig` | apply config keys (`net0`, `nameserver`, `features`, `onboot`, …) |
| `resize` | grow a volume (`rootfs` or `mpN`); PVE only grows |
| `start` | start a container; with `waitForIp`, read the **static IP from config** (LXC has no agent) |
| `stop` | stop a container (waits for the task) |
| `delete` | delete a container, optionally purging (idempotent) |

Two deliberate differences from `qemu`, both rooted in how LXC works:

- **`create`, not `clone`** — a container is built from a `vztmpl` tarball, so the
  args carry its shape (`rootfsSize`, `cores`, `memory`, `net0`, …) directly.
- **No in-container `exec`** — LXC has **no guest agent**; `pct exec`/`pct push`
  are CLI-only (off the REST surface). Run in-container steps through a node-shell
  model (e.g. `@swamp/ssh` driving `pct exec`/`pct push`) so this model stays
  transport-neutral. For the same reason `start --waitForIp` reads the configured
  static IP rather than polling an agent.

### `create` maps the request onto the node and verifies it first

Before mutating, `create` **maps the requested spec onto the node's live
capabilities** and fails fast with one clear message instead of an opaque PVE
error:

- **storage** — the rootfs storage exists, supports `rootdir`, and has capacity
  ≥ `rootfsSize`; the `ostemplate` exists on its (vztmpl-capable) storage;
- **network** — every `bridge=vmbrX` referenced in the net config exists.

(Compute is sanity-bounded at the schema; live capacity headroom — PVE overcommits
— is left to a higher planning layer.)

> **Unprivileged + systemd console gotcha:** a fresh unprivileged Debian-13
> container's `console-getty`/`container-getty@N` fail with `243/CREDENTIALS`
> (systemd can't mount its credentials tmpfs), so the **PVE web console shows no
> prompt**. Set **`features: nesting=1`** (then stop/start) to fix it, and set a
> root password if you need console login (key-only builds leave root locked).

## OS-neutral by design — extend, don't fork

Neither model knows the guest OS. The methods drive the **hypervisor**; OS-specific
behaviour layers on via `export const extension`:

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

## Configuration

Both models take the same transport / global args:

```yaml
# ssh transport (node-local pvesh over a jump)
globalArguments:
  name: pve-fleet
  transport:
    kind: ssh
    node: pve1
    host: 10.0.0.10
    proxyJump: admin@bastion.example
    # or: proxyCommand: "ssh -W [%h]:%p admin@bastion.example"

# api transport (direct, token auth)
globalArguments:
  name: pve-fleet
  transport:
    kind: api
    node: pve1
    apiUrl: https://10.0.0.10:8006
    tokenId: svc@pve!automation
    tokenSecret: ${{ vault.get('pve-secrets', 'token_secret') }}
    # PVE ships a self-signed cert — trust its CA (the supported way):
    caCert: ${{ vault.get('pve-secrets', 'ca_cert') }}   # /etc/pve/pve-root-ca.pem
```

> **TLS note:** PVE serves a self-signed certificate. Supply the node's CA via
> `caCert` (its `/etc/pve/pve-root-ca.pem`) so the endpoint is trusted. The
> `skipTlsVerify` flag exists but is a **no-op in a standard compiled runtime** —
> Deno only honors it when launched with `--unsafely-ignore-certificate-errors`,
> which you cannot pass to the `swamp` binary. Use `caCert`.

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
        ipconfig0: "ip=10.20.0.10/24,gw=10.20.0.1"
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
      features: "nesting=1"          # systemd/console in unprivileged CTs
      sshPublicKeys: "ssh-ed25519 AAAA..."
      config:
        net0: "name=eth0,bridge=vmbr1,ip=10.20.0.11/24,gw=10.20.0.1"
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
- Scope the PVE API token narrowly (a dedicated user + role ACL on `/vms` and the
  target storage), not `root@pam`.

## PVE token privileges (api transport)

- **qemu:** `VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt, VM.Audit,
  VM.Monitor, Datastore.AllocateSpace, Datastore.Audit, SDN.Use` — scoped to
  `/vms` and the target storage. `guestExec` additionally needs guest-agent
  execution rights (`VM.Monitor`; `VM.GuestAgent.*` on recent PVE).
- **lxc:** the container-equivalent allocate/config/power/audit on `/vms` +
  `Datastore.AllocateSpace` (rootfs) + `Datastore.Audit` (the `create` feasibility
  read of storage content) + `SDN.Use` (bridges).

## License

MIT — see [LICENSE.txt](LICENSE.txt).
