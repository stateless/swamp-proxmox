import { assert, assertEquals } from "jsr:@std/assert";
import {
  isDiskUnhealthy,
  nodeBridgesReq,
  nodeDisksReq,
  nodeStatusReq,
  nodeStoragesReq,
  parseGuestMetrics,
  parseNodeDisks,
  parseNodeStatus,
} from "./node.ts";

Deno.test("nodeStatusReq / nodeDisksReq build node-level GET paths", () => {
  assertEquals(nodeStatusReq("pve1"), {
    verb: "get",
    path: "/nodes/pve1/status",
  });
  assertEquals(nodeDisksReq("pve1"), {
    verb: "get",
    path: "/nodes/pve1/disks/list",
  });
});

Deno.test("nodeStoragesReq / nodeBridgesReq build node-config GET paths", () => {
  assertEquals(nodeStoragesReq("pve1"), {
    verb: "get",
    path: "/nodes/pve1/storage",
  });
  assertEquals(nodeBridgesReq("pve1"), {
    verb: "get",
    path: "/nodes/pve1/network",
    params: { type: "bridge" },
  });
});

Deno.test("parseNodeStatus: fractions→percent, pressure, string loadavg", () => {
  const f = parseNodeStatus({
    cpu: 0.0123, // 1.23%
    cpuinfo: { cpus: 16 },
    loadavg: ["0.10", "0.25", "0.30"], // PVE returns strings
    memory: { total: 1000, used: 250 },
    swap: { total: 200, used: 50 },
    rootfs: { total: 400, used: 100 },
    uptime: 99999,
    kversion: "Linux 6.8",
    pveversion: "pve-manager/8.4",
  });
  assertEquals(f.cpuPct, 1.2);
  assertEquals(f.cpus, 16);
  assertEquals(f.loadavg, [0.1, 0.25, 0.3]);
  assertEquals(f.memPct, 25);
  assertEquals(f.swapPct, 25);
  assertEquals(f.rootfsPct, 25);
  assertEquals(f.uptimeSec, 99999);
  assertEquals(f.kernelVersion, "Linux 6.8");
  assertEquals(f.pveVersion, "pve-manager/8.4");
});

Deno.test("parseNodeStatus: missing/garbage fields degrade to undefined", () => {
  const f = parseNodeStatus({ memory: { total: 0, used: 0 } });
  assertEquals(f.cpuPct, undefined);
  assertEquals(f.memPct, undefined); // total 0 → no divide
  assertEquals(f.loadavg, undefined);
  assertEquals(f.rootfsPct, undefined);
});

Deno.test("parseNodeDisks: health uppercased, wearout N/A dropped", () => {
  const disks = parseNodeDisks([
    {
      devpath: "/dev/sda",
      model: " Samsung SSD 870 ",
      type: "ssd",
      size: 500107862016,
      health: "passed",
      wearout: 98,
      used: "ZFS",
    },
    {
      devpath: "/dev/sdb",
      type: "hdd",
      health: "FAILED",
      wearout: "N/A", // spinning disk → no numeric wearout
    },
    { /* no devpath */ model: "ghost" },
  ]);
  assertEquals(disks.length, 2); // the devpath-less entry is dropped
  assertEquals(disks[0].health, "PASSED");
  assertEquals(disks[0].model, "Samsung SSD 870"); // trimmed
  assertEquals(disks[0].wearoutPct, 98);
  assertEquals(disks[1].wearoutPct, undefined);
  assert(!isDiskUnhealthy(disks[0]));
  assert(isDiskUnhealthy(disks[1]));
});

Deno.test("parseNodeDisks: absent/blank health → UNKNOWN (unhealthy)", () => {
  const [d] = parseNodeDisks([{ devpath: "/dev/nvme0n1", health: "" }]);
  assertEquals(d.health, "UNKNOWN");
  assert(isDiskUnhealthy(d));
});

Deno.test("parseGuestMetrics: cpu fraction→percent, mem pressure", () => {
  const m = parseGuestMetrics({
    status: "running",
    cpu: 0.5, // 50%
    cpus: 4,
    mem: 512,
    maxmem: 1024,
    disk: 10,
    maxdisk: 100,
    netin: 123,
    netout: 456,
    uptime: 60,
  });
  assertEquals(m.cpuPct, 50);
  assertEquals(m.cpus, 4);
  assertEquals(m.memPct, 50);
  assertEquals(m.memBytes, 512);
  assertEquals(m.maxMemBytes, 1024);
  assertEquals(m.netinBytes, 123);
  assertEquals(m.uptimeSec, 60);
});

Deno.test("parseGuestMetrics: stopped/empty guest → all undefined", () => {
  const m = parseGuestMetrics({ status: "stopped" });
  assertEquals(m.cpuPct, undefined);
  assertEquals(m.memPct, undefined);
  assertEquals(m.memBytes, undefined);
  // safe to spread onto a state record with no effect
  assertEquals(Object.values(m).every((v) => v === undefined), true);
});
