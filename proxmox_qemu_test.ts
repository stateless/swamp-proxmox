/**
 * Handler tests for the qemu model. Each method's `execute()` is driven over the
 * api transport with the `setFetch` seam returning canned PVE responses, so the
 * orchestration (resolve → request → parse → writeResource) is covered without a
 * live node. Success and failure paths.
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { resetSeams, setFetch } from "./_lib/proxmox/client.ts";
import { model } from "./proxmox_qemu.ts";

const API_GLOBAL = {
  name: "test",
  transport: {
    kind: "api" as const,
    node: "pve1",
    apiUrl: "https://pve.test:8006",
    tokenId: "svc@pve!k",
    tokenSecret: "secret",
    skipTlsVerify: false,
  },
  taskTimeoutSec: 5,
  pollIntervalSec: 1,
};

interface Write {
  specName: string;
  instanceName: string;
  data: unknown;
}

function mockCtx(writes: Write[]) {
  return {
    globalArgs: API_GLOBAL,
    writeResource: (specName: string, instanceName: string, data: unknown) => {
      writes.push({ specName, instanceName, data });
      return Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
        dataId: "id",
        version: 1,
      });
    },
    logger: { info: () => {}, warning: () => {} },
  };
}

/** Route api fetches by PVE path (sans `/api2/json` + query) to canned `data`. */
function routes(map: Record<string, unknown>) {
  setFetch((input: string | URL | Request) => {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const path = new URL(raw).pathname.replace("/api2/json", "");
    const data = path in map ? map[path] : null;
    return Promise.resolve(
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

Deno.test("getConfig: writes a config resource with the PVE config bag", async () => {
  try {
    routes({
      "/nodes/pve1/qemu/9001/config": {
        cores: 2,
        memory: 2048,
        net0: "virtio,bridge=vmbr1",
        tags: "swamp",
        digest: "abc",
      },
    });
    const writes: Write[] = [];
    const res = await model.methods.getConfig.execute(
      { vmid: 9001 },
      mockCtx(writes),
    );
    assertEquals(res.dataHandles.length, 1);
    assertEquals(writes[0].specName, "config");
    assertEquals(writes[0].instanceName, "vm-9001-config");
    const data = writes[0].data as {
      vmid: number;
      config: Record<string, unknown>;
    };
    assertEquals(data.vmid, 9001);
    assertEquals(data.config.cores, 2);
    assertEquals(data.config.net0, "virtio,bridge=vmbr1");
  } finally {
    resetSeams();
  }
});

Deno.test("nodeConfig: writes storages + bridges", async () => {
  try {
    routes({
      "/nodes/pve1/storage": [
        {
          storage: "local-zfs",
          type: "zfspool",
          content: "images,rootdir",
          avail: 1000,
        },
        { storage: "isos", type: "dir", content: "vztmpl,iso" },
      ],
      "/nodes/pve1/network": [{ iface: "vmbr0", type: "bridge" }, {
        iface: "vmbr1",
      }],
    });
    const writes: Write[] = [];
    await model.methods.nodeConfig.execute({}, mockCtx(writes));
    assertEquals(writes[0].specName, "nodeConfig");
    assertEquals(writes[0].instanceName, "node-pve1-config");
    const data = writes[0].data as { storages: unknown[]; bridges: string[] };
    assertEquals(data.storages.length, 2);
    assertEquals(data.bridges, ["vmbr0", "vmbr1"]);
  } finally {
    resetSeams();
  }
});

Deno.test("nodeStatus: parses host metrics + disk SMART into a record", async () => {
  try {
    routes({
      "/nodes/pve1/status": {
        cpu: 0.25,
        cpuinfo: { cpus: 8 },
        loadavg: ["0.5", "0.4", "0.3"],
        memory: { total: 1000, used: 600 },
        rootfs: { total: 500, used: 50 },
        uptime: 123,
      },
      "/nodes/pve1/disks/list": [
        { devpath: "/dev/sda", type: "ssd", health: "PASSED", wearout: 97 },
        { devpath: "/dev/sdb", type: "hdd", health: "FAILED" },
      ],
    });
    const writes: Write[] = [];
    await model.methods.nodeStatus.execute({}, mockCtx(writes));
    assertEquals(writes[0].specName, "nodeStatus");
    const d = writes[0].data as {
      cpuPct: number;
      memPct: number;
      loadavg: number[];
      disks: { health: string }[];
    };
    assertEquals(d.cpuPct, 25);
    assertEquals(d.memPct, 60);
    assertEquals(d.loadavg, [0.5, 0.4, 0.3]);
    assertEquals(d.disks.length, 2);
    assert(d.disks.some((x) => x.health === "FAILED"));
  } finally {
    resetSeams();
  }
});

Deno.test("lookup: captures per-guest metrics from status/current", async () => {
  try {
    routes({
      "/nodes/pve1/qemu/9001/status/current": {
        status: "running",
        name: "web",
        cpu: 0.5,
        mem: 512,
        maxmem: 1024,
      },
    });
    const writes: Write[] = [];
    await model.methods.lookup.execute({ vmid: 9001 }, mockCtx(writes));
    assertEquals(writes[0].specName, "guest");
    const d = writes[0].data as {
      status: string;
      cpuPct: number;
      memPct: number;
    };
    assertEquals(d.status, "running");
    assertEquals(d.cpuPct, 50);
    assertEquals(d.memPct, 50);
  } finally {
    resetSeams();
  }
});

Deno.test("stop: refuses a non-swamp-managed guest (safety gate)", async () => {
  try {
    routes({
      "/nodes/pve1/qemu": [{ vmid: 9001, name: "hand-built", tags: "" }],
    });
    await assertRejects(
      () =>
        model.methods.stop.execute({ vmid: 9001, force: false }, mockCtx([])),
      Error,
      "not swamp-managed",
    );
  } finally {
    resetSeams();
  }
});
