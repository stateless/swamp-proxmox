import { assert, assertEquals } from "jsr:@std/assert";
import {
  bridgesFromConfig,
  createCtReq,
  ctConfigReq,
  ctDeleteReq,
  ctResizeReq,
  ctSetConfigReq,
  ctStartReq,
  ctStatusReq,
  ctStopReq,
  extractCtConfigIpv4,
  listBridgesReq,
  listCtReq,
  listStoragesReq,
  listTemplatesReq,
  parseBridges,
  parseStorages,
  parseVolids,
  storageOfVolid,
} from "./lxc.ts";

Deno.test("container request builders produce the expected /lxc paths", () => {
  assertEquals(listCtReq("pve1").path, "/nodes/pve1/lxc");
  assert(listCtReq("pve1").verb === "get");
  assertEquals(
    ctStatusReq("pve1", 9203).path,
    "/nodes/pve1/lxc/9203/status/current",
  );
  assertEquals(ctConfigReq("pve1", 9203).path, "/nodes/pve1/lxc/9203/config");
  assertEquals(
    ctStartReq("pve1", 9203).path,
    "/nodes/pve1/lxc/9203/status/start",
  );
  assertEquals(ctStartReq("pve1", 9203).verb, "create");
  assertEquals(
    ctStopReq("pve1", 9203).path,
    "/nodes/pve1/lxc/9203/status/stop",
  );
});

Deno.test("createCtReq maps options to PVE /lxc create params", () => {
  const req = createCtReq("pve1", {
    vmid: 9203,
    ostemplate: "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
    hostname: "edge-web",
    storage: "local-zfs",
    rootfsSize: 8,
    cores: 1,
    memory: 512,
    swap: 512,
    unprivileged: true,
    features: "nesting=1",
    sshPublicKeys: "ssh-ed25519 AAAA... nic\n",
    start: false,
    config: {
      net0: "name=eth0,bridge=vmbr1,ip=203.0.113.18/28,gw=203.0.113.30",
    },
  });
  assertEquals(req.verb, "create");
  assertEquals(req.path, "/nodes/pve1/lxc");
  const p = req.params!;
  assertEquals(p.vmid, 9203);
  assertEquals(
    p.ostemplate,
    "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
  );
  assertEquals(p.hostname, "edge-web");
  assertEquals(p.storage, "local-zfs");
  // Root volume spec is "<storage>:<size-in-GiB>".
  assertEquals(p.rootfs, "local-zfs:8");
  assertEquals(p.cores, 1);
  assertEquals(p.memory, 512);
  assertEquals(p.swap, 512);
  assertEquals(p.unprivileged, 1);
  assertEquals(p.features, "nesting=1");
  assertEquals(p["ssh-public-keys"], "ssh-ed25519 AAAA... nic\n");
  assertEquals(p.start, 0);
  assertEquals(
    p.net0,
    "name=eth0,bridge=vmbr1,ip=203.0.113.18/28,gw=203.0.113.30",
  );
});

Deno.test("createCtReq omits optional keys and encodes booleans", () => {
  const req = createCtReq("pve1", {
    vmid: 9204,
    ostemplate: "local:vztmpl/x.tar.zst",
    hostname: "c",
    storage: "local-zfs",
    rootfsSize: 4,
    unprivileged: false,
    start: true,
  });
  const p = req.params!;
  assertEquals(p.rootfs, "local-zfs:4");
  assertEquals(p.unprivileged, 0);
  assertEquals(p.start, 1);
  assert(!("cores" in p));
  assert(!("memory" in p));
  assert(!("features" in p));
  assert(!("ssh-public-keys" in p));
});

Deno.test("ctSetConfigReq PUTs config keys to /config", () => {
  const req = ctSetConfigReq("pve1", 9203, {
    nameserver: "1.1.1.1",
    onboot: 1,
  });
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/pve1/lxc/9203/config");
  assertEquals(req.params, { nameserver: "1.1.1.1", onboot: 1 });
});

Deno.test("ctResizeReq builds a PUT to /resize with rootfs + size", () => {
  const req = ctResizeReq("pve1", 9203, "rootfs", "+4G");
  assertEquals(req.verb, "set");
  assertEquals(req.path, "/nodes/pve1/lxc/9203/resize");
  assertEquals(req.params, { disk: "rootfs", size: "+4G" });
});

Deno.test("ctDeleteReq adds purge params only when requested", () => {
  assertEquals(ctDeleteReq("pve1", 9203, false).verb, "delete");
  assertEquals(ctDeleteReq("pve1", 9203, false).params, {});
  assertEquals(ctDeleteReq("pve1", 9203, true).params, {
    purge: 1,
    "destroy-unreferenced-disks": 1,
  });
});

Deno.test("extractCtConfigIpv4 reads a static IP from netN, skips dhcp/loopback", () => {
  assertEquals(
    extractCtConfigIpv4({
      net0: "name=eth0,bridge=vmbr1,ip=203.0.113.18/28,gw=203.0.113.30",
    }),
    "203.0.113.18",
  );
  // First netN with a static v4 wins; net0 dhcp falls through to net1.
  assertEquals(
    extractCtConfigIpv4({
      net0: "name=eth0,bridge=vmbr0,ip=dhcp",
      net1: "name=eth1,bridge=vmbr3,ip=10.10.0.21/24",
    }),
    "10.10.0.21",
  );
  assertEquals(
    extractCtConfigIpv4({ net0: "name=eth0,bridge=vmbr0,ip=dhcp" }),
    undefined,
  );
  assertEquals(extractCtConfigIpv4({}), undefined);
  assertEquals(extractCtConfigIpv4(null), undefined);
  // Non-net keys are ignored.
  assertEquals(extractCtConfigIpv4({ hostname: "x", cores: 1 }), undefined);
});

Deno.test("feasibility request builders hit the right node endpoints", () => {
  assertEquals(
    listTemplatesReq("pve1", "isos").path,
    "/nodes/pve1/storage/isos/content",
  );
  assertEquals(listTemplatesReq("pve1", "isos").params, { content: "vztmpl" });
  assertEquals(listStoragesReq("pve1").path, "/nodes/pve1/storage");
  assertEquals(listBridgesReq("pve1").path, "/nodes/pve1/network");
  assertEquals(listBridgesReq("pve1").params, { type: "bridge" });
});

Deno.test("parseVolids + storageOfVolid read a content listing", () => {
  assertEquals(
    parseVolids([
      {
        volid: "isos:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
        format: "tzst",
      },
      { notavolid: 1 },
    ]),
    ["isos:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"],
  );
  assertEquals(parseVolids(null), []);
  assertEquals(storageOfVolid("isos:vztmpl/debian.tar.zst"), "isos");
  assertEquals(storageOfVolid("local-zfs:8"), "local-zfs");
  assertEquals(storageOfVolid("bare"), "bare");
});

Deno.test("parseStorages splits content types and reads avail", () => {
  const caps = parseStorages([
    { storage: "local", type: "dir", content: "snippets", avail: 100 },
    { storage: "isos", type: "dir", content: "iso,vztmpl", avail: 2853023616 },
    { storage: "local-zfs", type: "zfspool", content: "rootdir,images" },
    { bogus: 1 },
  ]);
  assertEquals(caps.length, 3);
  assertEquals(caps[1].content, ["iso", "vztmpl"]);
  assertEquals(caps[2].content, ["rootdir", "images"]);
  assertEquals(caps[2].avail, undefined);
});

Deno.test("parseBridges reads iface names", () => {
  assertEquals(
    parseBridges([{ iface: "vmbr0", type: "bridge" }, { iface: "vmbr1" }, {}]),
    ["vmbr0", "vmbr1"],
  );
  assertEquals(parseBridges("nope"), []);
});

Deno.test("bridgesFromConfig extracts unique bridges from netN entries", () => {
  assertEquals(
    bridgesFromConfig({
      net0: "name=eth0,bridge=vmbr1,ip=203.0.113.18/28,gw=203.0.113.30",
      net1: "name=eth1,bridge=vmbr3,ip=10.10.0.21/24",
      nameserver: "1.1.1.1",
    }),
    ["vmbr1", "vmbr3"],
  );
  assertEquals(bridgesFromConfig({ net0: "name=eth0,bridge=vmbr0" }), [
    "vmbr0",
  ]);
  assertEquals(bridgesFromConfig(undefined), []);
  assertEquals(bridgesFromConfig({ cores: 1 }), []);
});
