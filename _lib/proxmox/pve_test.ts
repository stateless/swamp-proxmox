import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  agentExecReq,
  agentExecStatusReq,
  agentInterfacesReq,
  assertGate,
  cloneReq,
  configReq,
  deleteReq,
  extractIpv4,
  isManaged,
  isProtected,
  listGuestsReq,
  parseConfig,
  parseExecPid,
  parseExecStatus,
  parseGuestList,
  parseTags,
  resizeDiskReq,
  resolveVmidFromList,
  setConfigReq,
  startReq,
  statusReq,
  stopReq,
  withManagedTag,
} from "./pve.ts";

Deno.test("request builders produce the expected PVE paths", () => {
  assertEquals(listGuestsReq("pve1").path, "/nodes/pve1/qemu");
  assertEquals(
    statusReq("pve1", 9001).path,
    "/nodes/pve1/qemu/9001/status/current",
  );
  assertEquals(
    startReq("pve1", 9001).path,
    "/nodes/pve1/qemu/9001/status/start",
  );
  assertEquals(stopReq("pve1", 9001).path, "/nodes/pve1/qemu/9001/status/stop");
  assertEquals(
    agentInterfacesReq("pve1", 9001).path,
    "/nodes/pve1/qemu/9001/agent/network-get-interfaces",
  );
});

Deno.test("cloneReq maps options to PVE params", () => {
  const req = cloneReq("pve1", 9000, {
    vmid: 9001,
    name: "cp",
    full: true,
    storage: "local-zfs",
  });
  assertEquals(req.verb, "create");
  assertEquals(req.path, "/nodes/pve1/qemu/9000/clone");
  assertEquals(req.params, {
    newid: 9001,
    name: "cp",
    full: 1,
    storage: "local-zfs",
  });
});

Deno.test("cloneReq encodes a linked clone as full=0 and omits storage", () => {
  const req = cloneReq("pve1", 9000, { vmid: 9002, name: "x", full: false });
  assertEquals(req.params, { newid: 9002, name: "x", full: 0 });
});

Deno.test("resizeDiskReq builds a PUT to /resize with disk + size", () => {
  const req = resizeDiskReq("pve1", 9001, "scsi0", "+47G");
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/pve1/qemu/9001/resize");
  assertEquals(req.params, { disk: "scsi0", size: "+47G" });
});

Deno.test("setConfigReq passes config keys through to PUT", () => {
  const req = setConfigReq("pve1", 9001, {
    net0: "virtio,bridge=vmbr3",
    ipconfig0: "ip=10.10.0.20/24,gw=10.10.0.1",
  });
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/pve1/qemu/9001/config");
  assertEquals(req.params!.net0, "virtio,bridge=vmbr3");
});

Deno.test("configReq GETs the guest config endpoint", () => {
  assertEquals(configReq("pve1", 9001), {
    verb: "get",
    path: "/nodes/pve1/qemu/9001/config",
  });
});

Deno.test("parseConfig keeps scalars, normalises booleans, drops non-scalars", () => {
  const cfg = parseConfig({
    cores: 2,
    memory: 2048,
    net0: "virtio,bridge=vmbr1",
    onboot: true, // → 1
    template: false, // → 0
    unmanaged: { nested: "x" }, // dropped
    bogus: ["a"], // dropped
    digest: "abc123",
  });
  assertEquals(cfg, {
    cores: 2,
    memory: 2048,
    net0: "virtio,bridge=vmbr1",
    onboot: 1,
    template: 0,
    digest: "abc123",
  });
  assertEquals(parseConfig(null), {});
  assertEquals(parseConfig("nope"), {});
});

Deno.test("deleteReq adds purge params only when requested", () => {
  assertEquals(deleteReq("pve1", 9001, false).params, {});
  assertEquals(deleteReq("pve1", 9001, true).params, {
    purge: 1,
    "destroy-unreferenced-disks": 1,
  });
});

Deno.test("parseGuestList tolerates non-array and missing fields", () => {
  assertEquals(parseGuestList(null), []);
  assertEquals(parseGuestList("nope"), []);
  const out = parseGuestList([{ vmid: 105, name: "webapp" }, { foo: 1 }]);
  assertEquals(out, [{
    vmid: 105,
    name: "webapp",
    status: undefined,
    tags: [],
  }]);
});

Deno.test("parseGuestList captures + splits tags", () => {
  const out = parseGuestList([{
    vmid: 9201,
    name: "cp",
    tags: "swamp;production",
  }]);
  assertEquals(out[0].tags, ["swamp", "production"]);
});

Deno.test("parseTags splits on ;/, lowercases, drops empties", () => {
  assertEquals(parseTags("swamp;production"), ["swamp", "production"]);
  assertEquals(parseTags("Swamp, Web"), ["swamp", "web"]);
  assertEquals(parseTags(""), []);
  assertEquals(parseTags(undefined), []);
  assertEquals(parseTags(123), []);
});

Deno.test("isManaged / isProtected key off tags", () => {
  assert(isManaged(["swamp", "production"]));
  assert(!isManaged(["web"]));
  assert(!isManaged(undefined));
  assert(isProtected(["production"]));
  assert(isProtected(["protected"]));
  assert(!isProtected(["swamp"]));
});

Deno.test("withManagedTag adds swamp idempotently, preserving others", () => {
  assertEquals(withManagedTag(undefined), "swamp");
  assertEquals(withManagedTag("web"), "web;swamp");
  assertEquals(withManagedTag("swamp;web"), "swamp;web");
});

Deno.test("assertGate enforces managed + protected unless force", () => {
  // not swamp-managed → blocked
  assertThrows(
    () =>
      assertGate(["web"], {
        force: false,
        op: "delete",
        vmid: 9,
        checkProtected: true,
      }),
    Error,
    "not swamp-managed",
  );
  // swamp-managed but production + delete → blocked
  assertThrows(
    () =>
      assertGate(["swamp", "production"], {
        force: false,
        op: "delete",
        vmid: 9,
        checkProtected: true,
      }),
    Error,
    "production/protected",
  );
  // swamp-managed, not protected → ok
  assertGate(["swamp"], {
    force: false,
    op: "delete",
    vmid: 9,
    checkProtected: true,
  });
  // stop only needs managed (no protected check)
  assertGate(["swamp", "production"], { force: false, op: "stop", vmid: 9 });
  // force bypasses everything
  assertGate(["web"], {
    force: true,
    op: "delete",
    vmid: 9,
    checkProtected: true,
  });
});

Deno.test("resolveVmidFromList finds, rejects missing and ambiguous", () => {
  const list = [
    { vmid: 105, name: "webapp" },
    { vmid: 9001, name: "cp" },
    { vmid: 9002, name: "cp" },
  ];
  assertEquals(resolveVmidFromList(list, "webapp"), 105);
  assertThrows(
    () => resolveVmidFromList(list, "nope"),
    Error,
    "no guest named",
  );
  assertThrows(() => resolveVmidFromList(list, "cp"), Error, "ambiguous");
});

Deno.test("extractIpv4 returns first non-loopback IPv4", () => {
  const data = {
    result: [
      {
        name: "lo",
        "ip-addresses": [
          { "ip-address-type": "ipv4", "ip-address": "127.0.0.1" },
        ],
      },
      {
        name: "eth0",
        "ip-addresses": [
          { "ip-address-type": "ipv6", "ip-address": "fe80::1" },
          { "ip-address-type": "ipv4", "ip-address": "10.10.0.20" },
        ],
      },
    ],
  };
  assertEquals(extractIpv4(data), "10.10.0.20");
  assertEquals(extractIpv4({ result: [] }), undefined);
  assertEquals(extractIpv4(null), undefined);
});

Deno.test("listGuestsReq is a GET", () => {
  assert(listGuestsReq("pve1").verb === "get");
});

Deno.test("agentExecReq posts the command argv as an array param", () => {
  const req = agentExecReq("pve1", 9001, ["systemctl", "is-active", "nginx"]);
  assertEquals(req.verb, "create");
  assertEquals(req.path, "/nodes/pve1/qemu/9001/agent/exec");
  assertEquals(req.params, { command: ["systemctl", "is-active", "nginx"] });
});

Deno.test("agentExecStatusReq GETs exec-status by pid", () => {
  const req = agentExecStatusReq("pve1", 9001, 4242);
  assertEquals(req.verb, "get");
  assertEquals(req.path, "/nodes/pve1/qemu/9001/agent/exec-status");
  assertEquals(req.params, { pid: 4242 });
});

Deno.test("parseExecPid reads numeric and string pids, throws otherwise", () => {
  assertEquals(parseExecPid({ pid: 4242 }), 4242);
  assertEquals(parseExecPid({ pid: "4242" }), 4242);
  assertThrows(() => parseExecPid({}), Error, "did not return a pid");
  assertThrows(() => parseExecPid(null), Error, "did not return a pid");
});

Deno.test("parseExecStatus maps exited/exitcode/out-data/err-data", () => {
  assertEquals(
    parseExecStatus({
      exited: 1,
      exitcode: 0,
      "out-data": "active\n",
      "err-data": "",
    }),
    { exited: true, exitCode: 0, stdout: "active\n", stderr: "" },
  );
  // still-running: exited 0, no code/output yet
  assertEquals(parseExecStatus({ exited: 0 }), {
    exited: false,
    exitCode: undefined,
    stdout: undefined,
    stderr: undefined,
  });
  // signal-terminated: exited but no exitcode
  assertEquals(parseExecStatus({ exited: 1 }).exited, true);
  assertEquals(parseExecStatus({ exited: 1 }).exitCode, undefined);
});
