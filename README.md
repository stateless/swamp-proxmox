# @stateless/proxmox

A **transport-neutral** Proxmox VE guest-lifecycle model for
[swamp](https://github.com/systeminit/swamp).

Every operation is expressed once as a PVE request (`{verb, path, params}`) that
maps 1:1 onto the PVE REST surface, then run through one of two transports:

| Transport | How it reaches PVE | When to use |
| --------- | ------------------ | ----------- |
| `api` | HTTPS to `{apiUrl}/api2/json…`, **API-token** auth | the API endpoint is reachable from the swamp host |
| `ssh` | runs `pvesh` on the node over SSH (API call is **node-local**) | the API is private / only reachable through a jump |

The `ssh` transport is the reason this exists: it dissolves the
"API-not-reachable-from-here" problem and reuses an existing SSH jump
(`proxyCommand`/`proxyJump`), while keeping the exact same operations available
when you later switch to direct token auth.

## Model: `@stateless/proxmox/guest`

| Method | Does |
| ------ | ---- |
| `lookup` | read a guest's current status (by `vmid` or `vmName`) |
| `sync` | reconcile live state into the data model — one guest, or **every guest on the node** when no ref is given |
| `clone` | clone a template into a new guest (idempotent; waits for the PVE task) |
| `setConfig` | apply config keys — incl. cloud-init (`ciuser`, `sshkeys`, `ipconfig0`, `net0`, …) and `cores`/`memory` |
| `resizeDisk` | grow a guest disk (e.g. after cloning a small template); PVE only grows |
| `start` | start a guest; optionally poll the guest agent for an IPv4 |
| `stop` | stop a guest (waits for the task) |
| `delete` | delete a guest, optionally purging disks/backup refs (idempotent — "already gone" is a no-op) |
| `guestExec` | run a command **inside** a booted guest via the qemu guest agent; capture exit code + stdout/stderr |

`clone` and `delete` are **idempotent** — re-running a half-finished build does
not error on an already-present VMID, and deleting a guest that is already gone
is a no-op. A pre-flight check (`transport-reachable`, label `live`) confirms the
node answers `GET /version` over the configured transport — and, for the `api`
transport, that the token authenticates — before any mutating method runs. Skip
it with `--skip-check-label live` when offline.

Template preparation (`qm importdisk` / `qm template`) is intentionally **out of
scope** — prepare the shared template once, then clone it here.

### OS-neutral by design

The model knows nothing about the guest operating system. `clone`/`setConfig`/
`start`/`stop`/`delete` drive the **hypervisor**, and `guestExec` is a generic
"run argv in the guest" primitive — the building block any OS layer composes on,
rather than baking distro assumptions into the model. To add OS-specific
behaviour (a Debian package-update action, a Windows sysprep step), **extend the
type** instead of forking it:

```typescript
import { z } from "npm:zod@4";

/** Debian-flavoured convenience methods layered on the neutral guest model. */
export const extension = {
  type: "@stateless/proxmox/guest",
  methods: [{
    aptUpgrade: {
      description: "apt-get update && dist-upgrade inside a Debian guest.",
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

```yaml
# ssh transport (node-local pvesh over a jump)
globalArguments:
  name: pve-guests
  transport:
    kind: ssh
    node: pve1
    host: 10.0.0.10
    proxyJump: admin@bastion.example
    # or: proxyCommand: "ssh -W [%h]:%p admin@bastion.example"

# api transport (direct, token auth)
globalArguments:
  name: pve-guests
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

### Apply cloud-init + clone in a workflow

```yaml
- name: clone
  task:
    type: model_method
    modelIdOrName: pve-guests
    methodName: clone
    inputs: { templateId: 9000, vmid: 9001, name: webapp, storage: local-zfs }
- name: configure
  task:
    type: model_method
    modelIdOrName: pve-guests
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
    modelIdOrName: pve-guests
    methodName: start
    inputs: { vmid: 9001, waitForIp: true }
```

### Run a command inside a guest

```yaml
- name: health-check
  task:
    type: model_method
    modelIdOrName: pve-guests
    methodName: guestExec
    inputs:
      vmid: 9001
      command: ["systemctl", "is-active", "nginx"]   # argv — no shell
      timeoutSec: 30
```

The result resource records `exited`, `exitCode`, `stdout`, and `stderr`.

### Example use-cases

- **Build pipeline** — `clone` a golden template → `setConfig` first-boot
  cloud-init (network, ssh keys) → `start` and wait for the agent IPv4. Re-run
  it safely; idempotent `clone` skips an existing VMID.
- **Fleet reconcile** — `sync` with no ref to refresh current state of every
  guest on the node (status + name) into the data model on a schedule.
- **Post-boot configuration / health** — `guestExec` to apply in-guest config,
  check a service, or read back a value, without standing up separate SSH
  plumbing to each guest.
- **Private clusters** — point the `ssh` transport at a jump host so swamp drives
  a PVE node whose API is not directly reachable.

## Security

- `tokenSecret` is schema-marked sensitive and stored via vault; it is never
  logged.
- The `ssh` transport spawns via `Deno.Command(bin, {args})` (never a local
  shell); the remote `pvesh` command is single-quote escaped, and transport
  option values are newline/NUL-guarded at schema time.
- `guestExec` runs an **argv array** (program + arguments) through the guest
  agent — there is no intermediate shell, so the arguments are not re-parsed.
  Each element is passed verbatim (multi-line script bodies are fine); the guest
  executes only what you list.
- Scope the PVE API token narrowly (a dedicated user + role ACL on `/vms` and
  the target storage), not `root@pam`.

## PVE token privileges (api transport)

`VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt, VM.Audit, VM.Monitor,
Datastore.AllocateSpace, Datastore.Audit, SDN.Use` — scoped to `/vms` and the
target storage. `guestExec` additionally needs guest-agent execution rights
(`VM.GuestAgent.Unrestricted` on recent PVE); omit it if you don't use
`guestExec`.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
