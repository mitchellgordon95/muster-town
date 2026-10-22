import { describe, expect, test } from "vitest";
import type { Agent, Building } from "@muster-town/schema";
import { FlyApi, SandboxBackend } from "../src/index.ts";
import { flyMachineName, flyVolumeName } from "../src/desk/fly.ts";

interface Req { method: string; path: string; body: any }

/** An in-memory Machines API: `exec` answers come from `execAnswers` (in order), everything else is canned. */
function fakeFly(opts: { startFails?: number; machines?: any[]; volumes?: any[] } = {}) {
  const reqs: Req[] = [];
  const machines: any[] = opts.machines ?? [];
  const volumes: any[] = opts.volumes ?? [];
  const execAnswers: ((cmd: string[]) => { stdout?: string; stderr?: string; exit_code?: number })[] = [];
  let startFails = opts.startFails ?? 0;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace("/v1/apps/muster-desks", "") + new URL(url).search;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    reqs.push({ method, path, body });
    const reply = (status: number, json: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) }) as Response;
    if (method === "GET" && path === "/machines") return reply(200, machines);
    if (method === "GET" && path === "/volumes") return reply(200, volumes);
    if (method === "POST" && path === "/volumes") { const v = { id: "vol_1", state: "created", ...body }; volumes.push(v); return reply(201, v); }
    if (method === "POST" && path === "/machines") { const m = { id: "m_1", state: "created", name: body.name }; machines.push(m); return reply(200, m); }
    if (path.includes("/wait")) return reply(200, { ok: true });
    if (path.endsWith("/start")) { if (startFails-- > 0) return reply(412, { error: "failed_precondition: machine still stopping" }); return reply(200, { ok: true }); }
    if (path.endsWith("/stop")) return reply(200, { ok: true });
    if (path.endsWith("/exec")) { const a = execAnswers.shift() ?? (() => ({})); const r = a(body.command); return reply(200, { stdout: "", stderr: "", exit_code: 0, exit_signal: 0, ...r }); }
    if (method === "DELETE") return reply(200, { ok: true });
    return reply(404, { error: "unexpected " + method + " " + path });
  }) as unknown as typeof fetch;
  return { reqs, machines, volumes, execAnswers, fetchFn };
}

const api = (f: ReturnType<typeof fakeFly>, extra = {}) => new FlyApi({ app: "muster-desks", token: "FlyV1 tok", image: "registry.fly.io/muster-desks:desk", pollMs: 1, fetch: f.fetchFn, ...extra });

describe("FlyApi", () => {
  test("names are made safe for Fly", () => {
    expect(flyMachineName("desk-workshop-ag_urlkwfp5q2")).toBe("desk-workshop-ag-urlkwfp5q2");
    expect(flyVolumeName("deskhome-ag_urlkwfp5q2")).toBe("deskhome_ag_urlkwfp5q2");
    expect(flyVolumeName("deskhome-" + "x".repeat(40)).length).toBe(30);
  });

  test("create makes the volume, then a Machine that mounts it, waits for start and hands the home to the desk user", async () => {
    const f = fakeFly();
    const info = await api(f, { region: "ord", memoryMb: 4096 }).create({ name: "desk-workshop-ag_1", labels: { "muster-town.agent": "ag_1" }, volume: "deskhome-ag_1", mountPath: "/home/agent" });
    expect(info).toMatchObject({ name: "desk-workshop-ag_1", state: "started" });
    const vol = f.reqs.find((r) => r.method === "POST" && r.path === "/volumes")!;
    expect(vol.body).toMatchObject({ name: "deskhome_ag_1", region: "ord", size_gb: 5 });
    const m = f.reqs.find((r) => r.method === "POST" && r.path === "/machines")!;
    expect(m.body).toMatchObject({
      name: "desk-workshop-ag-1", region: "ord",
      config: { image: "registry.fly.io/muster-desks:desk", restart: { policy: "no" }, guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 }, mounts: [{ volume: "vol_1", path: "/home/agent" }], metadata: { "muster-town.agent": "ag_1" } },
    });
    expect(m.body.config.init.cmd[0]).toBe("sleep");
    expect(f.reqs.some((r) => r.path.includes("/wait?state=started"))).toBe(true);
    const chown = f.reqs.find((r) => r.path.endsWith("/exec"))!;
    expect(chown.body.command.join(" ")).toMatch(/chown agent:agent '\/home\/agent'/);
  });

  test("options passed as undefined (as the runtime does for unset config) keep the defaults", async () => {
    const f = fakeFly();
    await api(f, { region: undefined, cpuKind: undefined, cpus: undefined, memoryMb: undefined }).create({ name: "desk-c-ag_1", labels: {}, volume: "deskhome-ag_1", mountPath: "/home/agent" });
    const m = f.reqs.find((r) => r.method === "POST" && r.path === "/machines")!;
    expect(m.body).toMatchObject({ region: "iad", config: { guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 } } });
  });

  test("create reuses an existing volume", async () => {
    const f = fakeFly({ volumes: [{ id: "vol_old", name: "deskhome_ag_1", state: "created" }] });
    await api(f).create({ name: "desk-c-ag_1", labels: {}, volume: "deskhome-ag_1", mountPath: "/home/agent" });
    expect(f.reqs.some((r) => r.method === "POST" && r.path === "/volumes")).toBe(false);
    expect(f.reqs.find((r) => r.method === "POST" && r.path === "/machines")!.body.config.mounts[0].volume).toBe("vol_old");
  });

  test("find maps Machine states", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "desk-c-ag-1", state: "stopped" }, { id: "b", name: "desk-c-ag-2", state: "started" }, { id: "c", name: "desk-c-ag-3", state: "starting" }] });
    const a = api(f);
    expect(await a.find("desk-c-ag_1")).toMatchObject({ id: "a", state: "stopped" });
    expect(await a.find("desk-c-ag_2")).toMatchObject({ state: "started" });
    expect(await a.find("desk-c-ag_3")).toMatchObject({ state: "other" });
    expect(await a.find("desk-c-ag_9")).toBeNull();
  });

  test("start retries while Fly says the Machine is still stopping", async () => {
    const f = fakeFly({ startFails: 2, machines: [{ id: "a", name: "desk-c-ag-1", state: "stopped" }] });
    await api(f).start("desk-c-ag_1");
    expect(f.reqs.filter((r) => r.path.endsWith("/start"))).toHaveLength(3);
  }, 15_000);

  test("writeSecretFile sends the content base64-encoded in the exec command, not in the clear", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "n", state: "started" }] });
    await api(f).writeSecretFile("n", "/tmp/.env1", "export T='s3cret'\n");
    const cmd = f.reqs.find((r) => r.path.endsWith("/exec"))!.body.command.join(" ");
    expect(cmd).not.toContain("s3cret");
    expect(cmd).toContain(Buffer.from("export T='s3cret'\n").toString("base64"));
    expect(cmd).toMatch(/umask 077/);
  });

  test("run starts the command in the background and follows its log and exit code with short polls", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "n", state: "started" }] });
    f.execAnswers.push(() => ({})); // launch
    f.execAnswers.push(() => ({ stdout: "one\ntw\n__EXIT__" })); // partial line, no exit yet
    f.execAnswers.push((cmd) => {
      expect(cmd.join(" ")).toContain("tail -c +7"); // "one\ntw" is 6 bytes
      return { stdout: "o\nthree\n__EXIT__7" };
    });
    const lines: string[] = [];
    const code = await api(f).run("n", "( agent-town-desk run )", (s, l) => lines.push(l));
    expect(code).toBe(7);
    expect(lines).toEqual(["one", "two", "three"]);
    const launch = f.reqs.filter((r) => r.path.endsWith("/exec"))[0].body.command.join(" ");
    expect(launch).toContain("runuser -u agent");
    expect(launch).toContain("nohup");
    expect(launch).toContain(Buffer.from("#!/bin/sh\n", "utf8").toString("base64").slice(0, 8)); // the wrapper script travels base64
  });

  test("run stops polling when aborted", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "n", state: "started" }] });
    const ac = new AbortController();
    f.execAnswers.push(() => ({}));
    for (let i = 0; i < 50; i++) f.execAnswers.push(() => ({ stdout: "\n__EXIT__" }));
    setTimeout(() => ac.abort(), 20);
    expect(await api(f).run("n", "x", undefined, ac.signal)).toBe(-1);
  });

  test("run gives up after repeated poll failures", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "n", state: "started" }] });
    f.execAnswers.push(() => ({}));
    const real = f.fetchFn;
    let n = 0;
    const failing = (async (url: string, init?: RequestInit) => (String(url).endsWith("/exec") && ++n > 1 ? ({ ok: false, status: 500, text: async () => "boom" } as Response) : real(url, init))) as typeof fetch;
    expect(await new FlyApi({ app: "muster-desks", token: "t", image: "i", pollMs: 1, fetch: failing }).run("n", "x")).toBe(-1);
  });

  test("remove deletes the Machine and, with a volume, the volume", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "desk-c-ag-1", state: "stopped" }], volumes: [{ id: "vol_9", name: "deskhome_ag_1", state: "created" }] });
    await api(f).remove("desk-c-ag_1", { volume: "deskhome-ag_1" });
    expect(f.reqs.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/machines/a?force=true", "/volumes/vol_9"]);
  });
});

describe("SandboxBackend over Fly: kill aborts a running session", () => {
  test("kill() makes a polling run return", async () => {
    const f = fakeFly({ machines: [{ id: "a", name: "desk-c-ag-1", state: "started" }] });
    f.execAnswers.push(() => ({})); // secret file
    f.execAnswers.push(() => ({})); // launch
    for (let i = 0; i < 200; i++) f.execAnswers.push(() => ({ stdout: "\n__EXIT__" }));
    const b = new SandboxBackend({ api: api(f), collective: "c", heartbeatMs: 0, idleStopMs: 60_000 });
    const child = b.exec({ name: "desk-c-ag_1", agentId: "ag_1" }, ["agent-town-desk", "run", "--session", "se_1"], { A: "b" });
    setTimeout(() => child.kill(), 30);
    expect(await child.wait()).toBe(-1);
  });
});

// keep the unused-type imports honest
void ({} as Agent); void ({} as Building);
