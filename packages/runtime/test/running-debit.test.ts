import { describe, expect, test, vi } from "vitest";
import { sessionView, type World } from "@muster-town/core";
import type { Agent, DeskActivityInput } from "@muster-town/schema";
import type { DeskBackend, DeskChild, DeskHandle } from "../src/index.ts";
import { chargeUsage } from "../src/session.ts";
import { callVerb, init, setup } from "./helpers.ts";

// 1:1 mt_x40qq8poc3 decision 2, (b) + (c): the Bank debits a session as it runs, and every token of a session counts
// however it ends. The check everywhere: what the building was debited for the session (Bank debits + allocation
// spend) equals the session row's adjusted output tokens.

const OPUS = "claude-opus-5-5";
/** One API call as the SDK streams it: an assistant message with its call's usage. */
const call = (id: string, u: { input?: number; output?: number; cacheRead?: number }) => ({
  type: "assistant", session_id: "sdk-session-1",
  message: { id, model: OPUS, content: [{ type: "text", text: `call ${id}` }], usage: { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: 0 } },
});
/** The result message: cumulative modelUsage over the query. */
const done = (u: { input: number; output: number; cacheRead: number }, costUsd = 0.5) => ({
  type: "result", subtype: "success", is_error: false, result: "done", num_turns: 3, total_cost_usd: costUsd, session_id: "sdk-session-1",
  usage: { input_tokens: u.input, output_tokens: u.output }, modelUsage: { [OPUS]: { inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: u.cacheRead, cacheCreationInputTokens: 0 } },
});
const usagePost = (input: number, output: number, cacheRead: number) => ({ counts: { input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 }, byModel: { [OPUS]: { input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 } } });

/** Adjusted output tokens debited to the building so far: Bank debits plus allocation spend. */
function debited(world: World, buildingId: string): number {
  const bank = (world.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM bank_debits WHERE buildingId = ?").get(buildingId) as { t: number }).t;
  return bank + world.allocations.where("buildingId = ?", [buildingId]).reduce((s, a) => s + a.spentTokens, 0);
}
const adjusted = (world: World, sessionId: string) => sessionView(world.sessions.require(sessionId)).adjustedOutputTokens;

class FakeDesk implements DeskBackend {
  readonly kind = "docker" as const;
  execs: { argv: string[]; exit(code: number): void; killed: boolean }[] = [];
  async available() { return true; }
  async ensure(a: Agent) { return { name: `desk-test-${a.id}`, agentId: a.id }; }
  exec(_h: DeskHandle, argv: string[]): DeskChild {
    let exit!: (c: number) => void;
    const p = new Promise<number>((r) => { exit = r; });
    const rec = { argv, exit, killed: false };
    this.execs.push(rec);
    return { wait: () => p, kill: () => { rec.killed = true; exit(137); } };
  }
}

describe("host sessions are debited as they run (b)", () => {
  test("each new call is booked at once; the result trues up; debits = the session's usage; a repeated block counts once", async () => {
    const seen: { rowTokens: number; debited: number }[] = [];
    let base = 0;
    const s = setup(async function* (f) {
      const bid = f.world.agents.require(f.agentId!).homeBuildingId!;
      const sid = () => f.world.sessions.first("agentId = ? AND status = 'running'", [f.agentId!])!.id;
      yield init();
      yield call("msg_1", { input: 100, output: 2000, cacheRead: 50_000 });
      seen.push({ rowTokens: f.world.sessions.require(sid()).tokens, debited: debited(f.world, bid) - base });
      yield call("msg_1", { input: 100, output: 2000, cacheRead: 50_000 }); // the same call's second block
      yield call("msg_2", { input: 50, output: 1000, cacheRead: 60_000 });
      seen.push({ rowTokens: f.world.sessions.require(sid()).tokens, debited: debited(f.world, bid) - base });
      yield* callVerb(f, "submit_report", { title: "Done", verdict: "stop", body: "## What I did\nx\n\n## Findings\ny\n\n## What I need from you\nNothing needed." });
      // the result also counts a call the stream never showed (a compaction): it covers the meter, so it wins whole
      yield done({ input: 170, output: 3100, cacheRead: 115_000 });
    }, { usageBookMs: 0 });
    const noor = s.by("Noor");
    const bid = noor.homeBuildingId!;
    base = debited(s.world, bid);
    const asg = s.world.ops.createWork(null, noor.id, { title: "Measure" });
    const ended = await s.runtime.runWorkSession(noor.id, asg.id);
    expect(seen[0]).toEqual({ rowTokens: 52_100, debited: expect.any(Number) });
    expect(seen[0].debited).toBeGreaterThan(0);
    expect(seen[1].rowTokens).toBe(52_100 + 61_050);
    expect(seen[1].debited).toBeGreaterThan(seen[0].debited);
    expect(ended).toMatchObject({ status: "done", input: 170, output: 3100, cacheRead: 115_000 });
    expect(debited(s.world, bid) - base).toBe(adjusted(s.world, ended.id));
  });

  test("a session that crashes mid-turn (no result) still counts and debits every call it made", async () => {
    let base = 0;
    const s = setup(async function* () {
      yield init();
      yield call("msg_1", { input: 10, output: 500, cacheRead: 20_000 });
      yield call("msg_2", { input: 10, output: 700, cacheRead: 30_000 });
      throw new Error("Claude Code process exited with code 1");
    }, { usageBookMs: 60_000 }); // nothing booked while running: all of it at the end
    const mei = s.by("Mei");
    const bid = mei.homeBuildingId!;
    base = debited(s.world, bid);
    const asg = s.world.ops.createWork(null, mei.id, {});
    const ended = await s.runtime.runWorkSession(mei.id, asg.id);
    expect(ended).toMatchObject({ status: "error", input: 20, output: 1200, cacheRead: 50_000 });
    expect(adjusted(s.world, ended.id)).toBeGreaterThan(0);
    expect(debited(s.world, bid) - base).toBe(adjusted(s.world, ended.id));
    expect(s.world.docs.require(ended.reportId!).title).toMatch(/without a report|ended/i);
  });
});

describe("desk sessions post usage as they run, and every exit path books it (c)", () => {
  function deskRun(name: string) {
    const desk = new FakeDesk();
    const s = setup(async function* () { yield done({ input: 1, output: 0, cacheRead: 0 }); }, { deskBackend: desk, killGraceMs: 0, deskOptions: { ghToken: () => "gho_test" } });
    const agent = s.by(name);
    const bid = agent.homeBuildingId!;
    const base = debited(s.world, bid);
    const asg = s.world.ops.createWork(null, agent.id, { title: "Desk work" });
    const running = s.runtime.runWorkSession(agent.id, asg.id);
    const started = vi.waitFor(() => expect(desk.execs).toHaveLength(1)).then(() => desk.execs[0].argv[3]);
    const post = (sid: string, usage: DeskActivityInput["usage"]) => s.runtime.onDeskActivity(agent.id, { session: sid, kind: "usage", usage });
    const paid = () => debited(s.world, bid) - base;
    return { ...s, desk, agent, asg, running, started, post, paid };
  }

  test("posts are booked at once and are cumulative (a repeat books nothing); session-end trues up to the desk's figure", async () => {
    const r = deskRun("Noor");
    const sid = await r.started;
    r.post(sid, usagePost(100, 1000, 40_000));
    const first = r.paid();
    expect(first).toBe(adjusted(r.world, sid));
    expect(first).toBeGreaterThan(0);
    r.post(sid, usagePost(100, 1000, 40_000));
    expect(r.paid()).toBe(first);
    expect(r.world.agents.require(r.agent.id).status).toBe("working"); // no out-of-budget check mid-session
    await r.world.verbs.submit_report(r.agent.id, { title: "x", verdict: "stop", body: "## What I did\nx\n\n## Findings\ny\n\n## What I need from you\nNothing needed." });
    await r.runtime.finishWorkSession(sid, { counts: usagePost(150, 1500, 70_000).counts, byModel: usagePost(150, 1500, 70_000).byModel, costUsd: 1.2, turns: 9, reportSubmitted: true });
    r.desk.execs[0].exit(0);
    const ended = await r.running;
    expect(ended).toMatchObject({ status: "done", input: 150, output: 1500, cacheRead: 70_000, costUsd: 1.2 });
    expect(r.paid()).toBe(adjusted(r.world, sid));
  });

  test("a lost desk (exits with no session-end) keeps what its posts booked", async () => {
    const r = deskRun("Mei");
    const sid = await r.started;
    r.post(sid, usagePost(10, 800, 30_000));
    r.desk.execs[0].exit(1);
    const ended = await r.running;
    expect(ended).toMatchObject({ status: "error", error: "desk exited 1", output: 800, cacheRead: 30_000 });
    expect(r.paid()).toBe(adjusted(r.world, sid));
    expect(r.paid()).toBeGreaterThan(0);
  });

  test("a spend-limit death with a smaller (or no) figure than was posted never books less than the posts", async () => {
    const r = deskRun("Tomas");
    const sid = await r.started;
    r.post(sid, usagePost(10, 900, 30_000));
    const posted = r.paid();
    // an older desk: a bare raw total smaller than what was posted
    await r.runtime.finishWorkSession(sid, { tokens: 100, error: "You've hit your usage limit", spendLimit: "You've hit your usage limit", reportSubmitted: false });
    r.desk.execs[0].exit(1);
    const ended = await r.running;
    expect(ended).toMatchObject({ status: "error", output: 900, cacheRead: 30_000 });
    expect(r.paid()).toBe(posted);
    expect(r.paid()).toBe(adjusted(r.world, sid));
    expect(r.world.docs.require(ended.reportId!).decision).toBe("pending"); // the fallback report
  });

  test("a stopped (killed) desk is booked like any other", async () => {
    const r = deskRun("Ravi");
    r.world.setStatus(r.agent.id, "idle");
    const sid = await r.started;
    r.post(sid, usagePost(5, 400, 10_000));
    r.world.ops.stopAgent(null, r.agent.id);
    const ended = await r.running;
    expect(r.desk.execs[0].killed).toBe(true);
    expect(ended).toMatchObject({ status: "interrupted", output: 400 });
    expect(r.paid()).toBe(adjusted(r.world, sid));
  });

  test("a restart orphans the session: its row keeps what was booked and the debits still match", async () => {
    const r = deskRun("Noor");
    const sid = await r.started;
    r.post(sid, usagePost(20, 600, 25_000));
    r.world.ops.reconcile([]);
    expect(r.world.sessions.require(sid)).toMatchObject({ status: "error", error: "orphaned at restart", output: 600, cacheRead: 25_000 });
    expect(r.paid()).toBe(adjusted(r.world, sid));
    r.desk.execs[0].exit(1);
    await r.running;
    expect(r.paid()).toBe(adjusted(r.world, sid)); // the late exit doesn't book it twice
  });

  test("a building with nothing left is still debited (overshoot), so the Spending tab's Not funded doesn't grow", async () => {
    const r = deskRun("Mei");
    const sid = await r.started;
    const bid = r.agent.homeBuildingId!;
    for (const a of r.world.allocations.where("buildingId = ?", [bid])) r.world.allocations.upsert({ ...a, spentTokens: a.tokens });
    expect(r.world.budget.remaining(bid)).toBeLessThanOrEqual(0);
    const notFunded = r.world.bank.spend().notFunded;
    const before = debited(r.world, bid);
    r.post(sid, usagePost(10, 700, 20_000));
    await r.runtime.finishWorkSession(sid, { counts: usagePost(10, 900, 20_000).counts, byModel: usagePost(10, 900, 20_000).byModel, costUsd: 0.4, turns: 3 });
    r.desk.execs[0].exit(0);
    await r.running;
    expect(debited(r.world, bid) - before).toBe(adjusted(r.world, sid));
    expect(r.world.bank.spend().notFunded).toBe(notFunded);
  });
});

describe("the Town Hall draws nothing from the Bank", () => {
  test("its usage with nothing of its own left is recorded alone: no Bank debit, no budget.exhausted, nobody flipped out-of-budget", () => {
    const s = setup(async function* () { yield init(); });
    const th = s.world.buildings.first("kind = 'town-hall'")!;
    const noor = s.by("Noor");
    s.world.agents.patch(noor.id, { homeBuildingId: th.id, buildingId: th.id });
    expect(s.world.budget.remaining(th.id)).toBeLessThanOrEqual(0);
    const events = s.world.events.list({ types: ["budget.exhausted"] }).length;
    const before = s.world.agents.require(noor.id).spentTokensTotal;
    chargeUsage(s.world, noor.id, { tokens: 0, counts: { input: 10, output: 500, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: 0.05 }, null, OPUS);
    expect(s.world.agents.require(noor.id).spentTokensTotal).toBeGreaterThan(before);
    expect(debited(s.world, th.id)).toBe(0);
    expect(s.world.events.list({ types: ["budget.exhausted"] }).length).toBe(events);
    expect(s.world.agents.require(noor.id).status).not.toBe("out-of-budget");
  });
});
