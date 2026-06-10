import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  buildApiCall,
  buildRemoteCommand,
  buildSshArgv,
  executeRequest,
  isUpid,
  PveError,
  resetSeams,
  setCommandExecutor,
  setFetch,
  shellQuote,
  waitForTask,
} from "./client.ts";
import { GlobalArgsSchema, ResizeDiskArgsSchema } from "./schemas.ts";

const sshGlobal = GlobalArgsSchema.parse({
  name: "pve1",
  transport: {
    kind: "ssh",
    node: "pve1",
    host: "10.0.0.10",
    proxyCommand: "ssh -W [%h]:%p admin@bastion.example",
    identityFile: "/home/u/.ssh/id_example",
  },
});

const apiGlobal = GlobalArgsSchema.parse({
  name: "pve1",
  transport: {
    kind: "api",
    node: "pve1",
    apiUrl: "https://10.0.0.10:8006",
    tokenId: "svc@pve!automation",
    tokenSecret: "testsecret",
  },
});

Deno.test("ResizeDiskArgsSchema: defaults disk, validates size, requires a ref", () => {
  const ok = ResizeDiskArgsSchema.parse({ vmid: 9001, size: "+20G" });
  assertEquals(ok.disk, "scsi0"); // default
  assertEquals(
    ResizeDiskArgsSchema.parse({ vmid: 9001, size: "50G" }).size,
    "50G",
  );
  // bad size (unit-only / garbage) rejected
  assert(!ResizeDiskArgsSchema.safeParse({ vmid: 9001, size: "big" }).success);
  // bad disk key rejected
  assert(
    !ResizeDiskArgsSchema.safeParse({ vmid: 9001, disk: "nic0", size: "+1G" })
      .success,
  );
  // must provide vmid or vmName
  assert(!ResizeDiskArgsSchema.safeParse({ size: "+1G" }).success);
});

Deno.test("shellQuote escapes embedded single quotes", () => {
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("a'b"), "'a'\\''b'");
});

Deno.test("buildRemoteCommand quotes path + values, appends json", () => {
  const t = sshGlobal.transport as Extract<
    typeof sshGlobal.transport,
    { kind: "ssh" }
  >;
  const cmd = buildRemoteCommand(t, {
    verb: "create",
    path: "/nodes/pve1/qemu/9000/clone",
    params: { newid: 9001, name: "copyparty" },
  });
  assertEquals(
    cmd,
    "pvesh create '/nodes/pve1/qemu/9000/clone' -newid '9001' " +
      "-name 'copyparty' --output-format json",
  );
});

Deno.test("buildRemoteCommand repeats the flag for array params (argv)", () => {
  const t = sshGlobal.transport as Extract<
    typeof sshGlobal.transport,
    { kind: "ssh" }
  >;
  const cmd = buildRemoteCommand(t, {
    verb: "create",
    path: "/nodes/pve1/qemu/9001/agent/exec",
    params: { command: ["systemctl", "is-active", "nginx"] },
  });
  assertEquals(
    cmd,
    "pvesh create '/nodes/pve1/qemu/9001/agent/exec' " +
      "-command 'systemctl' -command 'is-active' -command 'nginx' " +
      "--output-format json",
  );
});

Deno.test("buildSshArgv carries ssh options + destination", () => {
  const t = sshGlobal.transport as Extract<
    typeof sshGlobal.transport,
    { kind: "ssh" }
  >;
  const argv = buildSshArgv(t, { verb: "get", path: "/nodes/pve1/qemu" });
  assertEquals(argv[0], "ssh");
  assert(argv.includes("-o"));
  assert(argv.some((a) => a.startsWith("ProxyCommand=")));
  assert(argv.includes("-i"));
  assert(argv.includes("root@10.0.0.10"));
  // remote command is the final argv element
  assert(argv.at(-1)!.startsWith("pvesh get "));
});

Deno.test("buildApiCall: GET puts params in query, sets auth header", () => {
  const t = apiGlobal.transport as Extract<
    typeof apiGlobal.transport,
    { kind: "api" }
  >;
  const { url, init } = buildApiCall(t, {
    verb: "get",
    path: "/nodes/pve1/qemu/9001/status/current",
  });
  assertEquals(
    url,
    "https://10.0.0.10:8006/api2/json" +
      "/nodes/pve1/qemu/9001/status/current",
  );
  assertEquals(init.method, "GET");
  assertEquals(
    (init.headers as Record<string, string>).Authorization,
    "PVEAPIToken=svc@pve!automation=testsecret",
  );
  assert(init.body === undefined);
});

Deno.test("buildApiCall: POST urlencodes body + content-type", () => {
  const t = apiGlobal.transport as Extract<
    typeof apiGlobal.transport,
    { kind: "api" }
  >;
  const { url, init } = buildApiCall(t, {
    verb: "create",
    path: "/nodes/pve1/qemu/9000/clone",
    params: { newid: 9001, name: "cp" },
  });
  assert(url.endsWith("/qemu/9000/clone"));
  assertEquals(init.method, "POST");
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assertEquals(String(init.body), "newid=9001&name=cp");
});

Deno.test("buildApiCall: POST repeats array params in the body", () => {
  const t = apiGlobal.transport as Extract<
    typeof apiGlobal.transport,
    { kind: "api" }
  >;
  const { init } = buildApiCall(t, {
    verb: "create",
    path: "/nodes/pve1/qemu/9001/agent/exec",
    params: { command: ["systemctl", "is-active", "nginx"] },
  });
  assertEquals(
    String(init.body),
    "command=systemctl&command=is-active&command=nginx",
  );
});

Deno.test("executeRequest (ssh): parses pvesh json stdout", async () => {
  setCommandExecutor(() =>
    Promise.resolve({ code: 0, stdout: '[{"vmid":105}]', stderr: "" })
  );
  try {
    const data = await executeRequest(sshGlobal, {
      verb: "get",
      path: "/nodes/pve1/qemu",
    });
    assertEquals(data, [{ vmid: 105 }]);
  } finally {
    resetSeams();
  }
});

Deno.test("executeRequest (ssh): non-zero exit throws PveError w/ stderr", async () => {
  setCommandExecutor(() =>
    Promise.resolve({ code: 2, stdout: "", stderr: "no such VM" })
  );
  try {
    await assertRejects(
      () => executeRequest(sshGlobal, { verb: "get", path: "/x" }),
      PveError,
      "no such VM",
    );
  } finally {
    resetSeams();
  }
});

Deno.test("executeRequest (ssh): tolerates worker progress before the UPID", async () => {
  setCommandExecutor(() =>
    Promise.resolve({
      code: 0,
      stdout:
        "create full clone of drive scsi0 (local-zfs:base-9000-disk-0)\n" +
        '"UPID:pve1:0001:clone:OK"',
      stderr: "",
    })
  );
  try {
    const data = await executeRequest(sshGlobal, {
      verb: "create",
      path: "/nodes/pve1/qemu/9000/clone",
    });
    assertEquals(data, "UPID:pve1:0001:clone:OK");
  } finally {
    resetSeams();
  }
});

Deno.test("executeRequest (ssh): no-data mutation confirmation → null", async () => {
  setCommandExecutor(() =>
    Promise.resolve({
      code: 0,
      stdout: "update VM 9201: -agent 1 -net0 virtio,bridge=vmbr3",
      stderr: "",
    })
  );
  try {
    const data = await executeRequest(sshGlobal, {
      verb: "set",
      path: "/nodes/pve1/qemu/9201/config",
    });
    assertEquals(data, null);
  } finally {
    resetSeams();
  }
});

Deno.test("executeRequest (api): unwraps the data envelope", async () => {
  setFetch(
    ((_u: string | URL | Request, _i?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { status: "running" } }), {
          status: 200,
        }),
      )) as typeof fetch,
  );
  try {
    const data = await executeRequest(apiGlobal, {
      verb: "get",
      path: "/nodes/pve1/qemu/9001/status/current",
    });
    assertEquals(data, { status: "running" });
  } finally {
    resetSeams();
  }
});

Deno.test("executeRequest (api): HTTP >= 400 throws PveError", async () => {
  setFetch(
    ((_u: string | URL | Request, _i?: RequestInit) =>
      Promise.resolve(
        new Response("forbidden", { status: 403 }),
      )) as typeof fetch,
  );
  try {
    await assertRejects(
      () => executeRequest(apiGlobal, { verb: "delete", path: "/x" }),
      PveError,
      "HTTP 403",
    );
  } finally {
    resetSeams();
  }
});

Deno.test("isUpid recognises task handles", () => {
  assert(isUpid("UPID:pve1:0000:OK"));
  assert(!isUpid("running"));
  assert(!isUpid(42));
});

Deno.test("waitForTask resolves when task stops OK", async () => {
  setCommandExecutor(() =>
    Promise.resolve({
      code: 0,
      stdout: '{"status":"stopped","exitstatus":"OK"}',
      stderr: "",
    })
  );
  try {
    const status = await waitForTask(sshGlobal, "UPID:pve1:1:clone");
    assertEquals(status.exitstatus, "OK");
  } finally {
    resetSeams();
  }
});

Deno.test("waitForTask throws on non-OK exit status", async () => {
  setCommandExecutor(() =>
    Promise.resolve({
      code: 0,
      stdout: '{"status":"stopped","exitstatus":"clone failed"}',
      stderr: "",
    })
  );
  try {
    await assertRejects(
      () => waitForTask(sshGlobal, "UPID:pve1:1:clone"),
      PveError,
      "clone failed",
    );
  } finally {
    resetSeams();
  }
});
