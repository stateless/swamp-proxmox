import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  agentExecReq,
  agentExecStatusReq,
  agentInterfacesReq,
  cloneReq,
  deleteReq,
  extractIpv4,
  listGuestsReq,
  parseExecPid,
  parseExecStatus,
  parseGuestList,
  resizeDiskReq,
  resolveVmidFromList,
  setConfigReq,
  startReq,
  statusReq,
  stopReq,
} from "./pve.ts";

Deno.test("request builders produce the expected PVE paths", () => {
  assertEquals(listGuestsReq("sh1").path, "/nodes/sh1/qemu");
  assertEquals(statusReq("sh1", 9001).path, "/nodes/sh1/qemu/9001/status/current");
  assertEquals(startReq("sh1", 9001).path, "/nodes/sh1/qemu/9001/status/start");
  assertEquals(stopReq("sh1", 9001).path, "/nodes/sh1/qemu/9001/status/stop");
  assertEquals(
    agentInterfacesReq("sh1", 9001).path,
    "/nodes/sh1/qemu/9001/agent/network-get-interfaces",
  );
});

Deno.test("cloneReq maps options to PVE params", () => {
  const req = cloneReq("sh1", 9000, {
    vmid: 9001,
    name: "cp",
    full: true,
    storage: "local-zfs",
  });
  assertEquals(req.verb, "create");
  assertEquals(req.path, "/nodes/sh1/qemu/9000/clone");
  assertEquals(req.params, { newid: 9001, name: "cp", full: 1, storage: "local-zfs" });
});

Deno.test("cloneReq encodes a linked clone as full=0 and omits storage", () => {
  const req = cloneReq("sh1", 9000, { vmid: 9002, name: "x", full: false });
  assertEquals(req.params, { newid: 9002, name: "x", full: 0 });
});

Deno.test("resizeDiskReq builds a PUT to /resize with disk + size", () => {
  const req = resizeDiskReq("sh1", 9001, "scsi0", "+47G");
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/sh1/qemu/9001/resize");
  assertEquals(req.params, { disk: "scsi0", size: "+47G" });
});

Deno.test("setConfigReq passes config keys through to PUT", () => {
  const req = setConfigReq("sh1", 9001, {
    net0: "virtio,bridge=vmbr3",
    ipconfig0: "ip=192.168.80.20/24,gw=192.168.80.1",
  });
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/sh1/qemu/9001/config");
  assertEquals(req.params!.net0, "virtio,bridge=vmbr3");
});

Deno.test("deleteReq adds purge params only when requested", () => {
  assertEquals(deleteReq("sh1", 9001, false).params, {});
  assertEquals(deleteReq("sh1", 9001, true).params, {
    purge: 1,
    "destroy-unreferenced-disks": 1,
  });
});

Deno.test("parseGuestList tolerates non-array and missing fields", () => {
  assertEquals(parseGuestList(null), []);
  assertEquals(parseGuestList("nope"), []);
  const out = parseGuestList([{ vmid: 105, name: "box" }, { foo: 1 }]);
  assertEquals(out, [{ vmid: 105, name: "box", status: undefined }]);
});

Deno.test("resolveVmidFromList finds, rejects missing and ambiguous", () => {
  const list = [
    { vmid: 105, name: "box" },
    { vmid: 9001, name: "cp" },
    { vmid: 9002, name: "cp" },
  ];
  assertEquals(resolveVmidFromList(list, "box"), 105);
  assertThrows(() => resolveVmidFromList(list, "nope"), Error, "no guest named");
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
          { "ip-address-type": "ipv4", "ip-address": "192.168.80.20" },
        ],
      },
    ],
  };
  assertEquals(extractIpv4(data), "192.168.80.20");
  assertEquals(extractIpv4({ result: [] }), undefined);
  assertEquals(extractIpv4(null), undefined);
});

Deno.test("listGuestsReq is a GET", () => {
  assert(listGuestsReq("sh1").verb === "get");
});

Deno.test("agentExecReq posts the command argv as an array param", () => {
  const req = agentExecReq("sh1", 9001, ["systemctl", "is-active", "nginx"]);
  assertEquals(req.verb, "create");
  assertEquals(req.path, "/nodes/sh1/qemu/9001/agent/exec");
  assertEquals(req.params, { command: ["systemctl", "is-active", "nginx"] });
});

Deno.test("agentExecStatusReq GETs exec-status by pid", () => {
  const req = agentExecStatusReq("sh1", 9001, 4242);
  assertEquals(req.verb, "get");
  assertEquals(req.path, "/nodes/sh1/qemu/9001/agent/exec-status");
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
