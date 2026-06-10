/**
 * Handler tests for the lxc model. Each method's `execute()` is driven over the
 * api transport with the `setFetch` seam returning canned PVE responses, so the
 * orchestration is covered without a live node. Success and failure paths.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { resetSeams, setFetch } from "./_lib/proxmox/client.ts";
import { model } from "./proxmox_lxc.ts";

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

Deno.test("getConfig: writes a config resource from the container config", async () => {
  try {
    routes({
      "/nodes/pve1/lxc/9201/config": {
        hostname: "edge",
        cores: 1,
        memory: 512,
        rootfs: "local-zfs:8",
        net0: "name=eth0,bridge=vmbr1,ip=10.20.0.11/24",
        tags: "swamp",
      },
    });
    const writes: Write[] = [];
    const res = await model.methods.getConfig.execute(
      { vmid: 9201 },
      mockCtx(writes),
    );
    assertEquals(res.dataHandles.length, 1);
    assertEquals(writes[0].specName, "config");
    assertEquals(writes[0].instanceName, "ct-9201-config");
    const data = writes[0].data as {
      vmid: number;
      config: Record<string, unknown>;
    };
    assertEquals(data.vmid, 9201);
    assertEquals(data.config.hostname, "edge");
    assertEquals(data.config.cores, 1);
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
          content: "rootdir,images",
          avail: 5000,
        },
      ],
      "/nodes/pve1/network": [{ iface: "vmbr0" }, { iface: "vmbr1" }],
    });
    const writes: Write[] = [];
    await model.methods.nodeConfig.execute({}, mockCtx(writes));
    assertEquals(writes[0].specName, "nodeConfig");
    assertEquals(writes[0].instanceName, "node-pve1-config");
    const data = writes[0].data as { storages: unknown[]; bridges: string[] };
    assertEquals(data.storages.length, 1);
    assertEquals(data.bridges, ["vmbr0", "vmbr1"]);
  } finally {
    resetSeams();
  }
});

Deno.test("stop: refuses a non-swamp-managed container (safety gate)", async () => {
  try {
    routes({
      "/nodes/pve1/lxc": [{ vmid: 9201, name: "hand-built", tags: "" }],
    });
    await assertRejects(
      () =>
        model.methods.stop.execute({ vmid: 9201, force: false }, mockCtx([])),
      Error,
      "not swamp-managed",
    );
  } finally {
    resetSeams();
  }
});
