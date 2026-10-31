/** Redeploy without draining (docs/architecture.md "Redeploy"): desk work sessions keep running through the restart and the next server adopts them. */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Agent } from "@muster-town/schema";
import { adoptPath, ADOPT_MAX_AGE_MS, startRuntime, takeAdoptable, type CmdResult, type CommandRunner, type DeskBackend, type DeskChild, type DeskHandle, type Runtime } from "../src/index.ts";
import { dockerSafe } from "../src/desk/backend.ts";
import { result, setup } from "./helpers.ts";

class FakeDesk implements DeskBackend {
  readonly kind = "docker" as const;
  execs: { argv: string[]; exit(code: number): void }[] = [];
  async available() { return true; }
  async ensure(a: Agent) { return { name: `desk-test-${a.id}`, agentId: a.id }; }
  exec(_h: DeskHandle, argv: string[]): DeskChild {
    let exit!: (c: number) => void;
    const done = new Promise<number>((r) => { exit = r; });
    this.execs.push({ argv, exit });
    return { wait: () => done, kill: () => exit(137) };
  }
}

const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
const run: CommandRunner = async (cmd, args) => ok(cmd === "git" && args[0] === "rev-parse" ? "abc123\n" : cmd === "git" && args[0] === "rev-list" ? "1\n" : "");

vi.setConfig({ testTimeout: 30_000 });

const later: Runtime[] = [];
afterEach(async () => { while (later.length) await later.pop()!.stop(); });

/** A runtime with a desk session running for Noor, on a repo dir the redeploy writes its hand-over file into. */
async function running() {
  const repoRoot = mkdtempSync(join(tmpdir(), "adopt-"));
  const exit = vi.fn();
  const desk = new FakeDesk();
  const s = setup(async function* () { yield result(1, 0); }, { deskBackend: desk, killGraceMs: 0, repoRoot, collective: "climate",
    redeploy: { run, exit, exitDelayMs: 1, drainPollMs: 1 } });
  const noor = s.by("Noor");
  s.world.agents.where("kind = 'resident' AND id != ?", [noor.id]).forEach((a) => s.world.agents.patch(a.id, { status: "stopped" }));
  s.world.setStatus(noor.id, "idle");
  const asg = s.world.ops.createWork(null, noor.id, { title: "Long build" });
  await s.runtime.tickOnce();
  await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
  const session = s.world.sessions.first("agentId = ? AND purpose = 'work'", [noor.id])!;
  return { ...s, repoRoot, exit, desk, noor, asg, session };
}
/** The server after the restart: same world and repo dir, a fresh runtime. */
function restart(s: Awaited<ReturnType<typeof running>>, extra: Record<string, unknown> = {}) {
  const r = startRuntime({ world: s.world, mcpUrl: "http://127.0.0.1:4321/mcp", intervalMs: 0, exportDir: false, deskBackend: new FakeDesk(), repoRoot: s.repoRoot, collective: "climate", now: () => new Date(s.clock.t), ...extra });
  later.push(r);
  return r;
}

describe("redeploy without draining", () => {
  test("the redeploy doesn't wait for a desk session: it restarts at once and hands the session to the next server", async () => {
    const s = await running();
    expect(s.runtime.redeploy({ image: false, requestedBy: "Noor" })).toEqual({ started: true });
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(75), { timeout: 15_000 });
    const texts = s.world.events.recent({ limit: 200 }).map((e) => e.text);
    expect(texts.some((t) => t.startsWith("Redeploy: draining"))).toBe(false);
    expect(texts).toContain("Redeploy: restarting server; 1 desk session(s) keep running and are adopted after it");
    expect(JSON.parse(readFileSync(adoptPath(s.repoRoot, dockerSafe("climate")), "utf8")).sessions).toEqual([s.session.id]);
    // nothing told the session to wrap up
    expect(s.world.ops.pendingInterrupts(s.noor.id, s.session.id)).toHaveLength(0);
    expect(s.desk.execs).toHaveLength(1);
  });

  test("the next server adopts it (not orphaned, still the agent's live session) and its desk's session-end books it once", async () => {
    const s = await running();
    s.runtime.redeploy({ image: false, requestedBy: "Noor" });
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(75), { timeout: 15_000 });
    const next = restart(s);
    expect(next.adopted).toEqual([s.session.id]);
    expect(next.reconciled).toEqual({ orphanedSessions: [], requeuedAssignments: [] });
    expect(existsSync(adoptPath(s.repoRoot, dockerSafe("climate")))).toBe(false);
    expect(s.world.sessions.require(s.session.id).status).toBe("running");
    expect(s.world.assignments.require(s.asg.id).status).toBe("active");
    expect(next.isWorking(s.noor.id)).toBe(true);
    // the scheduler doesn't start a second session for the agent, and the watchdog leaves a desk that polls alone
    s.clock.t += 4 * 60_000;
    next.deskSeen(s.noor.id, s.session.id);
    s.clock.t += 4 * 60_000;
    await next.tickOnce();
    expect(s.world.sessions.count("agentId = ? AND status = 'running'", [s.noor.id])).toBe(1);
    // the desk posts session-end to the new server
    const ended = await next.finishWorkSession(s.session.id, { counts: { input: 10, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, turns: 4 });
    expect(ended).toMatchObject({ status: "done", error: null });
    expect(next.isWorking(s.noor.id)).toBe(false);
    // a second session-end (the desk resending after a cut answer) books nothing more
    const again = await next.finishWorkSession(s.session.id, { counts: { input: 10, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, turns: 4 });
    expect(again.tokens).toBe(ended.tokens);
    expect(s.world.events.recent({ limit: 50 }).filter((e) => e.type === "session.ended" && (e.payload as { sessionId?: string }).sessionId === s.session.id)).toHaveLength(1);
  });

  test("a desk an image redeploy kept busy (stale_desks) is removed once its adopted session ends, never while it runs", async () => {
    const s = await running();
    s.runtime.redeploy({ image: false, requestedBy: "Noor" });
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(75), { timeout: 15_000 });
    // what the image redeploy's recreateDesks records for a resident whose session it found running
    s.world.db.prepare("INSERT INTO stale_desks (key, buildingId, n, at) VALUES (?, NULL, NULL, ?)").run(s.noor.id, new Date().toISOString());
    const desk = new FakeDesk();
    const removed: string[] = [];
    Object.assign(desk, { remove: async (agentId: string) => { removed.push(agentId); } });
    const next = restart(s, { deskBackend: desk });
    expect(next.adopted).toEqual([s.session.id]);
    await next.tickOnce();
    expect(removed).toEqual([]);
    await next.finishWorkSession(s.session.id, { counts: { input: 10, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, turns: 4 });
    await next.tickOnce();
    await vi.waitFor(() => expect(removed).toEqual([s.noor.id]));
    expect(s.world.db.prepare("SELECT COUNT(*) AS c FROM stale_desks").get()).toEqual({ c: 0 });
    await vi.waitFor(() => expect(s.world.events.recent({ limit: 50 }).some((e) => (e.payload as { staleDesk?: string }).staleDesk === s.noor.id)).toBe(true));
    // drained once: later passes don't remove it again
    await next.tickOnce();
    expect(removed).toHaveLength(1);
  });

  test("an adopted desk that goes silent is ended as lost and its assignment re-queued", async () => {
    const s = await running();
    s.runtime.redeploy({ image: false, requestedBy: "Noor" });
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(75), { timeout: 15_000 });
    const next = restart(s, { adoptedSilentMs: 60_000 });
    expect(next.adopted).toEqual([s.session.id]);
    s.clock.t += 61_000;
    await next.tickOnce();
    expect(s.world.sessions.require(s.session.id)).toMatchObject({ status: "error", error: "desk lost after restart" });
    expect(s.world.assignments.require(s.asg.id).status).not.toBe("active");
    expect(s.world.events.recent({ limit: 50 }).some((e) => (e.payload as { adoptedLost?: boolean }).adoptedLost)).toBe(true);
  });

  test("a server that starts without a hand-over (a crash) still orphans running desk sessions; a stale hand-over file is ignored", async () => {
    const s = await running();
    const next = restart(s);
    expect(next.adopted).toEqual([]);
    expect(next.reconciled.orphanedSessions).toEqual([s.session.id]);
    const dir = mkdtempSync(join(tmpdir(), "adopt-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(adoptPath(dir, "c"), JSON.stringify({ sessions: ["se_1"], at: new Date(Date.now() - ADOPT_MAX_AGE_MS - 1000).toISOString() }));
    expect(takeAdoptable(dir, "c")).toEqual([]);
    writeFileSync(adoptPath(dir, "c"), JSON.stringify({ sessions: ["se_1"], at: new Date().toISOString() }));
    expect(takeAdoptable(dir, "c")).toEqual(["se_1"]);
    expect(takeAdoptable(dir, "c")).toEqual([]);
  });
});
