import { afterEach, describe, expect, test, vi } from "vitest";
import type { Agent, Building } from "@muster-town/schema";
import { SandboxBackend, type DeskBackend, type DeskChild, type DeskHandle, type SandboxApi } from "../src/index.ts";
import { killPattern, type SandboxInfo } from "../src/desk/sandbox.ts";
import { result, setup } from "./helpers.ts";

const agent = { id: "ag_abc123" } as Agent;
const building = { id: "bl_x" } as Building;

function fakeApi(opts: { found?: SandboxInfo | null; exit?: number; lines?: [("stdout" | "stderr"), string][]; fail?: string } = {}) {
  const calls: string[] = [];
  const files: { name: string; path: string; content: string }[] = [];
  const commands: string[] = [];
  const created: Parameters<SandboxApi["create"]>[0][] = [];
  const quick: string[] = [];
  let release: (() => void) | null = null;
  const api: SandboxApi = {
    async available() { calls.push("available"); return true; },
    async find(name) { calls.push(`find ${name}`); return opts.found === undefined ? null : opts.found; },
    async create(spec) { calls.push("create"); created.push(spec); return { id: "sb1", name: spec.name, state: "started" }; },
    async start(name) { calls.push(`start ${name}`); },
    async stop(name) { calls.push(`stop ${name}`); },
    async writeSecretFile(name, path, content) { calls.push("write"); files.push({ name, path, content }); },
    async run(_name, command, onLine) {
      calls.push("run"); commands.push(command);
      if (opts.fail) throw new Error(opts.fail);
      for (const [s, l] of opts.lines ?? []) onLine?.(s, l);
      if (release === null && opts.exit === undefined) await new Promise<void>((r) => { release = r; });
      return opts.exit ?? 0;
    },
    async quick(_name, command) { quick.push(command); },
    async remove(name, o) { calls.push(`remove ${name} ${o.volume ?? "-"}`); },
  };
  return { api, calls, files, commands, created, quick, finish: () => release?.() };
}

describe("SandboxBackend", () => {
  afterEach(() => vi.useRealTimers());

  test("ensure creates a missing desk with labels, home volume and mount", async () => {
    const f = fakeApi();
    const h = await new SandboxBackend({ api: f.api, collective: "Workshop Collective" }).ensure(agent, building);
    expect(h).toEqual({ name: "desk-workshop-collective-ag_abc123", agentId: "ag_abc123" });
    expect(f.created).toEqual([{
      name: "desk-workshop-collective-ag_abc123", volume: "deskhome-ag_abc123", mountPath: "/home/agent",
      labels: { "muster-town.desk": "1", "muster-town.agent": "ag_abc123", "muster-town.collective": "workshop-collective" },
    }]);
  });

  test("ensure starts a stopped desk, leaves a started one alone, replaces one in error (home volume kept)", async () => {
    const stopped = fakeApi({ found: { id: "s", name: "n", state: "stopped" } });
    await new SandboxBackend({ api: stopped.api, collective: "c" }).ensure(agent, building);
    expect(stopped.calls).toEqual(["find desk-c-ag_abc123", "start desk-c-ag_abc123"]);
    const started = fakeApi({ found: { id: "s", name: "n", state: "started" } });
    await new SandboxBackend({ api: started.api, collective: "c" }).ensure(agent, building);
    expect(started.calls).toEqual(["find desk-c-ag_abc123"]);
    const bad = fakeApi({ found: { id: "s", name: "n", state: "error" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new SandboxBackend({ api: bad.api, collective: "c" }).ensure(agent, building);
    warn.mockRestore();
    expect(bad.calls).toEqual(["find desk-c-ag_abc123", "remove desk-c-ag_abc123 -", "create"]);
  });

  test("exec sources the env from a 0600 file, so secret values are never in the command; streams lines; returns the exit code", async () => {
    const f = fakeApi({ exit: 3, lines: [["stdout", "hello"], ["stderr", "warn"]] });
    const b = new SandboxBackend({ api: f.api, collective: "c", idleStopMs: 10_000 });
    const h: DeskHandle = { name: "desk-c-ag_abc123", agentId: "ag_abc123" };
    const lines: string[] = [];
    const child = b.exec(h, ["agent-town-desk", "run", "--session", "se_1"], { TOKEN: "s3cret", QUOTE: "it's", GH_TOKEN: "gho_x" }, (s, l) => lines.push(`${s}:${l}`));
    expect(await child.wait()).toBe(3);
    expect(lines).toEqual(["stdout:hello", "stderr:warn"]);
    expect(f.files).toHaveLength(1);
    const file = f.files[0];
    expect(file.content).toContain("export TOKEN='s3cret'");
    expect(file.content).toContain(`export QUOTE='it'\\''s'`);
    const cmd = f.commands[0];
    expect(cmd).toBe(`( . ${file.path}; rm -f ${file.path}; 'agent-town-desk' 'run' '--session' 'se_1' )`);
    expect(cmd).not.toMatch(/s3cret|gho_x/);
    expect(f.quick).toContain(`rm -f ${file.path}`);
  });

  test("exec resolves -1 and reports on stderr when the provider fails", async () => {
    const f = fakeApi({ fail: "boom" });
    const lines: string[] = [];
    const child = new SandboxBackend({ api: f.api, collective: "c", idleStopMs: 10_000 }).exec({ name: "n", agentId: "a" }, ["x"], {}, (s, l) => lines.push(`${s}:${l}`));
    expect(await child.wait()).toBe(-1);
    expect(lines).toEqual(["stderr:sandbox exec failed: boom"]);
  });

  test("the sandbox is stopped after its last session ends, unless a new session starts first", async () => {
    vi.useFakeTimers();
    const f = fakeApi({ exit: 0 });
    const b = new SandboxBackend({ api: f.api, collective: "c", idleStopMs: 1000 });
    const h: DeskHandle = { name: "desk-c-a", agentId: "a" };
    await b.exec(h, ["x"], {}).wait();
    await vi.advanceTimersByTimeAsync(500);
    await b.ensure({ id: "a" } as Agent, building); // next session arrives: cancels the stop
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls).not.toContain("stop desk-c-a");
    await b.exec(h, ["x"], {}).wait();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.calls).toContain("stop desk-c-a");
  });

  test("a heartbeat pings the sandbox while a session runs", async () => {
    vi.useFakeTimers();
    const f = fakeApi(); // run() blocks until finish()
    const b = new SandboxBackend({ api: f.api, collective: "c", heartbeatMs: 1000, idleStopMs: 60_000 });
    const child = b.exec({ name: "n", agentId: "a" }, ["x"], {});
    await vi.advanceTimersByTimeAsync(3500);
    expect(f.quick.filter((c) => c === "true").length).toBe(3);
    f.finish();
    await child.wait();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.quick.filter((c) => c === "true").length).toBe(3);
  });

  test("killExec / killOrphan pkill the node process by its arguments; orphans only in a started sandbox", async () => {
    expect(killPattern(["agent-town-desk", "run", "--session", "se_1"])).toBe("[r]un --session se_1");
    const f = fakeApi({ found: { id: "s", name: "n", state: "started" } });
    const b = new SandboxBackend({ api: f.api, collective: "c" });
    await b.killOrphan("ag_1", "se_1");
    expect(f.quick).toEqual([`pkill -TERM -f '[r]un --session se_1' || true`]);
    const stopped = fakeApi({ found: { id: "s", name: "n", state: "stopped" } });
    await new SandboxBackend({ api: stopped.api, collective: "c" }).killOrphan("ag_1", "se_1");
    expect(stopped.quick).toEqual([]);
    const gone = fakeApi({ found: null });
    await new SandboxBackend({ api: gone.api, collective: "c" }).killOrphan("ag_1", "se_1");
    expect(gone.quick).toEqual([]);
  });

  test("remove deletes the sandbox; purge also its home volume", async () => {
    const f = fakeApi();
    const b = new SandboxBackend({ api: f.api, collective: "c" });
    await b.remove("ag_1");
    await b.remove("ag_1", { purge: true });
    expect(f.calls).toEqual(["remove desk-c-ag_1 -", "remove desk-c-ag_1 deskhome-ag_1"]);
  });

  test("available() is false when the provider throws", async () => {
    const api = { ...fakeApi().api, available: async () => { throw new Error("down"); } };
    expect(await new SandboxBackend({ api, collective: "c" }).available()).toBe(false);
  });
});

describe("sandbox desks reach the town at desks.townUrl", () => {
  class FakeSandboxDesk implements DeskBackend {
    readonly kind = "docker" as const;
    execs: { env: Record<string, string> }[] = [];
    async available() { return true; }
    async ensure(a: Agent): Promise<DeskHandle> { return { name: `desk-${a.id}`, agentId: a.id }; }
    exec(_h: DeskHandle, _argv: string[], env: Record<string, string>): DeskChild {
      this.execs.push({ env });
      let done!: (code: number) => void;
      const exited = new Promise<number>((r) => { done = r; });
      return { wait: () => exited, kill: () => done(143) };
    }
  }
  test("MUSTER_TOWN_URL is the public URL (trailing slash trimmed), not host.docker.internal", async () => {
    const desk = new FakeSandboxDesk();
    const { world, runtime, by } = setup(async function* () { yield result(1, 0); }, { deskBackend: desk, desks: { backend: "fly", townUrl: "https://muster.town/" } });
    const noor = by("Noor");
    world.agents.where("kind = 'resident' AND id != ?", [noor.id]).forEach((a) => world.agents.patch(a.id, { status: "stopped" }));
    world.setStatus(noor.id, "idle");
    world.ops.createWork(null, noor.id, { title: "Measure" });
    await runtime.tickOnce();
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    expect(desk.execs[0].env).toMatchObject({ MUSTER_TOWN_URL: "https://muster.town", AGENT_TOWN_URL: "https://muster.town" });
  });
});
