import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { intrayOf, jobThread, openManagerEntries, type World } from "@muster-town/core";
import type { RuntimeOptions } from "../src/index.ts";
import { RESUME_WINDOW_MS, resumableManage, resumePrompt } from "../src/manage.ts";
import { callVerb, deferred, init, result, setup, type FakeSession, type Script } from "./helpers.ts";

const report = (title: string) => ({ title, verdict: "stop" as const, body: "## What I did\nMeasured it.\n\n## Findings\n2.4 ± 0.1 ppm/yr.\n\n## What I need from you\nDecide whether it goes on the board.\n\nNothing else needed." });

/** Seeded lab (marked blocked already, so the blocked wake stays out of the way) with Mei as its manager agent and the seed's reports decided; `script` drives every SDK session. */
async function managed(script: Script, extra: Partial<RuntimeOptions> = {}) {
  const env = setup(script, extra);
  const admin = env.world.ops.ensureAvatar(env.seed.admin.id);
  for (const d of intrayOf(env.world, env.lab.id)) await env.world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
  // a lab with no key results is blocked, which wakes the manager with work of its own once per transition: start it
  // out blocked, so setting the manager doesn't fire that wake (the test below covers it)
  env.world.buildings.patch(env.lab.id, { blockedAt: new Date().toISOString() });
  env.world.ops.updateBuilding(admin, env.lab.id, { managerAgentId: env.by("Mei").id });
  return env;
}
const manageSessions = (s: FakeSession[], mei: string) => s.filter((x) => x.agentId === mei);

describe("manager team-lead session", () => {
  test("a resident's report wakes the manager; a later report streams into the same session; no report → no fallback", async () => {
    const gate = deferred();
    const env = await managed(async function* (s) {
      yield init();
      const first = s.received[0].match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: first, decision: "approve" });
      await gate.promise;
      const next = await s.next(); // the second report, streamed in
      const second = next!.match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: second, decision: "approve" });
      yield result(300, 0.05, "Both decided.");
    });
    const { world, runtime, sdk, by, lab } = env;
    const mei = by("Mei"), noor = by("Noor");
    const r1 = await world.verbs.submit_report(noor.id, report("Growth rate"));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(runtime.isWorking(mei.id)).toBe(true);
    expect(world.agents.require(mei.id).status).toBe("working");
    const live = world.sessions.first("agentId = ? AND status = 'running'", [mei.id])!;
    expect(live.purpose).toBe("manage");
    const r2 = await world.verbs.submit_report(by("Moss").id, report("Isotopes"));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    gate.resolve();
    await runtime.whenIdle();

    expect(manageSessions(sdk.sessions, mei.id)).toHaveLength(1);
    const s = sdk.sessions[0];
    expect(s.received[0]).toContain(r1.id);
    expect(s.received[1]).toContain(r2.id);
    expect(s.options.tools).toEqual([]); // a team-lead session (not the Secretary's): no web, no code tools
    // the cached prefix: a plain string (no Claude Code preset) with the in-tray rules but nothing live (docs/prompt-caching.md);
    // the live state opens the first message, before the task
    expect(typeof s.options.systemPrompt).toBe("string");
    expect(s.options.systemPrompt).toContain("Working the in-tray.");
    expect(s.options.systemPrompt).not.toMatch(/Clock: it is|## Your in-tray \(you work it|## Your team \(|## Your wiki \(/);
    expect(s.received[0]).toMatch(/^Clock: it is .* as this starts/);
    expect(s.received[0].indexOf("## Your in-tray")).toBeLessThan(s.received[0].indexOf("This is a team-lead session"));
    expect(world.docs.require(r1.id).decision).toBe("approve");
    expect(world.docs.require(r2.id).decision).toBe("approve");
    expect(intrayOf(world, lab.id)).toHaveLength(0);
    const ended = world.sessions.require(live.id);
    expect(ended).toMatchObject({ status: "done", purpose: "manage", reportId: null, tokens: 300 });
    // no fallback report: the event log says what happened
    expect(world.docs.count("authorId = ? AND type = 'report'", [mei.id])).toBe(0);
    expect(world.events.list({ agentId: mei.id, limit: 500 }).some((e) => e.type === "system" && /in-tray session ended .*decided 2 reports$/.test(e.text))).toBe(true);
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  test("a human's decision that needs a move (a counter) is an entry that wakes the manager once; one that needs none (a key-result edit, a continue) is a record and wakes nobody", async () => {
    const env = await managed(async function* (s) {
      yield init();
      // the entry is in the in-tray block of the first message; the manager answers it like a report
      for (const id of new Set(s.received[0].match(/en_[a-z0-9_]+/g) ?? [])) yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield result(100, 0.01, "Acknowledged.");
    });
    const { world, runtime, by, lab } = env;
    const mei = by("Mei"), admin = world.ops.ensureAvatar(env.seed.admin.id);
    const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); await runtime.whenIdle(); };
    const townRows = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report'", [lab.id]);
    const manages = () => world.sessions.where("agentId = ? AND purpose = 'manage'", [mei.id]);
    const draft = world.grantDesk.create(mei, lab.id, { keyResults: [{ text: "Visitors can read the goal", howToCheck: "Open the board" }], objective: "Goal on the board", approach: "a line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 10_000_000 });
    const kr = world.keyResults.require(draft.keyResultId!);
    // a human edits the key result: a record on the thread (the waker's durable rule writes it), nobody is woken
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Visitors can read the goal at a glance" });
    await settle();
    expect(manages()).toHaveLength(0);
    // (the grant is still a draft, so it has no job yet: the record is on the building's own thread)
    const record = jobThread(world, lab.id)!.entries.find((e) => e.moved.keyResultId === kr.id)!;
    expect(record).toMatchObject({ authorKind: "human", level: "none", moved: { action: "edited" } });
    // a counter is the manager's move: one entry, one team-lead session, which answers it
    const g = world.grantDesk.propose(mei, draft.id);
    world.grantDesk.decide(admin, g.id, { action: "counter", note: "half the tokens" });
    await settle();
    expect(manages()).toHaveLength(1);
    expect(env.sdk.sessions.at(-1)!.received[0]).toMatch(/en_[a-z0-9_]+ COUNTER by .* on jb_gr_[a-z0-9]+: half the tokens/);
    expect(openManagerEntries(world, lab.id)).toEqual([]);
    // re-proposed and funded, then continued at its checkpoint: records, no wake
    world.grantDesk.decide(admin, world.grantDesk.propose(mei, g.id).id, { action: "fund", tokens: 10_000_000 });
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5] });
    world.grantDesk.decide(admin, g.id, { action: "continue" });
    await settle();
    expect(manages()).toHaveLength(1);
    // the manager marking its own key result is not a human event
    world.grantDesk.updateKeyResult(mei, kr.id, { status: "on-track" });
    await settle();
    expect(manages()).toHaveLength(1);
    // the town wrote no report doc for any of it (kr_o8dbx2axii)
    expect(townRows()).toHaveLength(0);
  });

  test("what only a human can settle is an ask on the thread, not a rollup: it reaches the decision queue and doesn't wake the manager again; the session ends with no report", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const id = s.received[0].match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield* callVerb(s, "ask", { type: "meeting", title: "Should the lab publish its growth rates weekly?", body: "Question: should the lab publish its growth rates every week?", branches: [{ label: "Weekly" }, { label: "Only on request" }], recommendation: "Weekly: the numbers are already measured." });
      yield result(200, 0.03);
    });
    const { world, runtime, sdk, by, lab } = env;
    const mei = by("Mei");
    await world.verbs.submit_report(by("Noor").id, report("Growth rate"));
    await runtime.whenIdle();
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(1);
    const ask = world.asks.first("buildingId = ? AND type = 'meeting'", [lab.id])!;
    expect(ask).toMatchObject({ status: "open", title: "Should the lab publish its growth rates weekly?" });
    const raised = jobThread(world, lab.id)!.entries.find((e) => e.moved.kind === "ask")!;
    expect(raised).toMatchObject({ authorKind: "manager", authorId: mei.id, level: "human" });
    expect(ask.sourceEntryId).toBe(raised.id);
    // no report of the manager's, nothing in its own queue, and no rollup anywhere
    expect(world.docs.count("authorId = ? AND type = 'report'", [mei.id])).toBe(0);
    expect(openManagerEntries(world, lab.id)).toEqual([]);
    expect(world.sessions.first("agentId = ? AND purpose = 'manage'", [mei.id])).toMatchObject({ status: "done", reportId: null });
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  test("startup: a pending in-tray starts one session; undecided reports don't loop; a busy or broke manager waits", async () => {
    const env = await managed(async function* () { yield init(); yield result(100, 0.01, "Waiting for more reports."); });
    const { world, runtime, sdk, by } = env;
    const mei = by("Mei");
    // the report landed while the manager was in a work session: nothing starts
    world.setStatus(mei.id, "working");
    await world.verbs.submit_report(by("Noor").id, report("Growth rate"));
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(0);
    // the building is out of budget: still nothing
    world.setStatus(mei.id, "idle");
    const allocs = world.allocations.where("buildingId = ?", [env.lab.id]);
    for (const a of allocs) world.allocations.upsert({ ...a, spentTokens: a.tokens });
    expect(world.budget.canStart(mei.id)).toBe(false);
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(0);
    for (const a of allocs) world.allocations.upsert(a);
    world.setStatus(mei.id, "idle");
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(manageSessions(sdk.sessions, mei.id)).toHaveLength(1);
    // left undecided: later ticks don't start it again
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(manageSessions(sdk.sessions, mei.id)).toHaveLength(1);
  });

  test("the manager's own work report (not a rollup) wakes its manage session, which decides it (town hall 2026-10-25, decision 6)", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const id = s.received[0].match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield result(100, 0.01);
    });
    const { world, runtime, sdk, by, lab } = env;
    const mei = by("Mei");
    const own = await world.verbs.submit_report(mei.id, report("My own work"));
    expect(own).toMatchObject({ intray: lab.id, workedBy: "manager" });
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(manageSessions(sdk.sessions, mei.id)).toHaveLength(1);
    expect(sdk.sessions[0].received[0]).toContain(own.id);
    expect(world.docs.require(own.id)).toMatchObject({ decision: "approve", decidedBy: mei.id });
    expect(intrayOf(world, lab.id)).toHaveLength(0);
  });
});

/** A team-lead session of `agentId` that a restart cut (as reconcile ends it), with SDK session `sdk`; `jsonl` writes its transcript under `claudeDir`. */
function cutManageSession(world: World, agentId: string, sdk: string, claudeDir: string, jsonl = true, error = "cut by restart") {
  const s = world.ops.startSession(agentId, { purpose: "manage", model: "claude-opus-5-5" });
  world.sessions.patch(s.id, { sdkSessionId: sdk });
  world.ops.endSession(s.id, { status: "interrupted", error });
  world.setStatus(agentId, "idle");
  if (jsonl) {
    mkdirSync(join(claudeDir, "projects", "-repo"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-repo", `${sdk}.jsonl`), "{}\n");
  }
  return world.sessions.require(s.id);
}

describe("a team-lead session cut by a restart resumes (gr_w9ue1k1p0c step 2)", () => {
  test("resumableManage: interrupted by a restart + sdkSessionId + transcript → resume; no transcript, an error, a 1:1 or too old → fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    const env = await managed(async function* () { yield init(); yield result(1, 0); });
    const { world, by } = env;
    const mei = by("Mei").id;
    const now = () => new Date(Date.now() + 1000);
    const cut = cutManageSession(world, mei, "sdk-cut-1", dir);
    expect(resumableManage(world, mei, dir, now())).toEqual({ sessionId: cut.id, sdkSessionId: "sdk-cut-1" });
    // the drain's stuck drop counts as a restart cut too
    const dropped = cutManageSession(world, mei, "sdk-cut-2", dir, true, "cut by redeploy: drain found it stuck");
    expect(resumableManage(world, mei, dir, now())).toEqual({ sessionId: dropped.id, sdkSessionId: "sdk-cut-2" });
    expect(resumableManage(world, mei, dir, new Date(Date.now() + RESUME_WINDOW_MS + 60_000))).toBeNull();
    cutManageSession(world, mei, "sdk-gone", dir, false);
    expect(resumableManage(world, mei, dir, now())).toBeNull(); // transcript gone: fresh
    const failed = cutManageSession(world, mei, "sdk-cut-3", dir);
    world.sessions.patch(failed.id, { status: "error", error: "boom" });
    expect(resumableManage(world, mei, dir, now())).toBeNull();
    const s = world.ops.startSession(mei, { purpose: "manage", model: "m", meetingId: "mt_x" });
    world.sessions.patch(s.id, { sdkSessionId: "sdk-cut-1" });
    world.ops.endSession(s.id, { status: "interrupted", error: "cut by restart" });
    expect(resumableManage(world, mei, dir, now())).toBeNull(); // a 1:1 resumes from its own transcript
  });

  test("the next tick resumes the cut session with the SDK `resume` option, once; its new row records the SDK session while it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    const gate = deferred();
    const env = await managed(async function* () { yield init(); await gate.promise; yield result(200, 0.02, "Picked up where I was cut."); }, { claudeDir: dir });
    const { world, runtime, sdk, by, clock } = env;
    const mei = by("Mei").id;
    clock.t = Date.now() + 1000;
    const cut = cutManageSession(world, mei, "sdk-cut-1", dir);
    await runtime.tickOnce();
    await new Promise((r) => setImmediate(r));
    const mine = manageSessions(sdk.sessions, mei);
    expect(mine).toHaveLength(1);
    expect(mine[0].options.resume).toBe("sdk-cut-1");
    // the live state (clock, in-tray) opens the message; the resume instruction ends it
    expect(mine[0].received[0]).toMatch(/^Clock: it is/);
    expect(mine[0].received[0].endsWith(resumePrompt({ sessionId: cut.id, sdkSessionId: "sdk-cut-1" }))).toBe(true);
    const running = world.sessions.first("agentId = ? AND status = 'running'", [mei])!;
    expect(running).toMatchObject({ purpose: "manage", sdkSessionId: "sdk-session-1" });
    expect(world.events.list({ agentId: mei, limit: 200 }).some((e) => (e.payload as { resumedFrom?: string }).resumedFrom === cut.id)).toBe(true);
    gate.resolve();
    await runtime.whenIdle();
    expect(world.sessions.require(running.id)).toMatchObject({ status: "done", tokens: 200 });
    // resumed once: the next tick starts nothing (the in-tray is empty)
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(manageSessions(sdk.sessions, mei)).toHaveLength(1);
  });

  test("no transcript: a fresh team-lead session works the in-tray (no resume)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    const env = await managed(async function* () { yield init(); yield result(100, 0.01, "Decided."); }, { claudeDir: dir });
    const { world, runtime, sdk, by, clock } = env;
    const mei = by("Mei").id;
    clock.t = Date.now() + 1000;
    cutManageSession(world, mei, "sdk-gone", dir, false);
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(manageSessions(sdk.sessions, mei)).toHaveLength(0); // nothing to resume, nothing in the in-tray
    const r = await world.verbs.submit_report(by("Noor").id, report("Growth rate"));
    await runtime.whenIdle();
    const mine = manageSessions(sdk.sessions, mei);
    expect(mine).toHaveLength(1);
    expect(mine[0].options.resume).toBeUndefined();
    expect(mine[0].received[0]).toContain(r.id);
  });
});
