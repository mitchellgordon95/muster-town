import { describe, expect, test } from "vitest";
import { intrayOf, managerIntrayRow } from "@muster-town/core";
import { callVerb, deferred, init, result, setup, type FakeSession, type Script } from "./helpers.ts";

const report = (title: string) => ({ title, verdict: "stop" as const, body: "## What I did\nMeasured it.\n\n## Findings\n2.4 ± 0.1 ppm/yr.\n\n## What I need from you\nNothing needed." });

/** Seeded lab (marked blocked already, so the blocked wake stays out of the way) with Mei as its manager agent and the seed's reports decided; `script` drives every SDK session. */
async function managed(script: Script) {
  const env = setup(script);
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
      yield result(300, 0.05, "Both decided; no rollup due.");
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
    expect(s.options.tools).toEqual([]); // no web, no code tools
    expect(s.options.systemPrompt).toMatchObject({ append: expect.stringContaining("## Your in-tray") });
    expect(world.docs.require(r1.id).decision).toBe("approve");
    expect(world.docs.require(r2.id).decision).toBe("approve");
    expect(intrayOf(world, lab.id)).toHaveLength(0);
    const ended = world.sessions.require(live.id);
    expect(ended).toMatchObject({ status: "done", purpose: "manage", reportId: null, tokens: 300 });
    // no fallback report: the event log says what happened
    expect(world.docs.count("authorId = ? AND type = 'report'", [mei.id])).toBe(0);
    expect(world.events.list({ agentId: mei.id, limit: 500 }).some((e) => e.type === "system" && /in-tray session ended .*decided 2 reports, no rollup/.test(e.text))).toBe(true);
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  test("a human's grant or key-result decision writes one town row in the in-tray and wakes the manager once; a replay or the manager's own edit doesn't", async () => {
    const env = await managed(async function* (s) {
      yield init();
      for (const id of new Set(s.received[0].match(/dc_[a-z0-9]+/g) ?? [])) yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield result(100, 0.01, "Acknowledged.");
    });
    const { world, runtime, by, lab } = env;
    const mei = by("Mei"), admin = world.ops.ensureAvatar(env.seed.admin.id);
    const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); await runtime.whenIdle(); };
    const rows = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report'", [lab.id]);
    const manages = () => world.sessions.where("agentId = ? AND purpose = 'manage'", [mei.id]);
    const kr = world.grantDesk.createKeyResult(admin, lab.id, { text: "Visitors can read the goal", howToCheck: "Open the board" });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(manages()).toHaveLength(1);
    expect(world.docs.require(rows()[0]!.id).decision).toBe("approve");
    // funding wakes the manager with its own assignment (Grants.decisionAssignment): no row; continuing at the checkpoint writes one
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(mei, world.grantDesk.create(mei, lab.id, { keyResultId: kr.id, objective: "Goal on the board", approach: "a line", stopCondition: "two tries", askTokens: 10_000_000, testingPlan: [] }).id).id, { action: "fund" });
    await settle();
    expect(rows()).toHaveLength(1);
    world.grants.patch(g.id, { status: "checkpoint", checkpointsDone: [0.5] });
    world.grantDesk.decide(admin, g.id, { action: "continue" });
    await settle();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]!.title).toBe(`Grant ${g.id} continued: 10,000,000 tokens`);
    expect(manages()).toHaveLength(2);
    // the same event delivered again writes nothing and wakes no one
    const e = world.events.list({ buildingId: lab.id, types: ["grant.funded"], limit: 100 }).at(-1)!;
    expect(managerIntrayRow(world, e)).toBeNull();
    // the manager marking its own key result is not a human event
    world.grantDesk.updateKeyResult(mei, kr.id, { status: "on-track" });
    await settle();
    expect(rows()).toHaveLength(2);
    expect(manages()).toHaveLength(2);
  });

  test("a goal-directed building with no key results and no funded grant is blocked: the tick wakes its manager once", async () => {
    const env = await managed(async function* () { yield init(); yield result(100, 0.01, "Drafting key results."); });
    const { world, runtime, by, lab } = env;
    const mei = by("Mei");
    world.setStatus(mei.id, "working"); // keep the scheduler from starting the wake: only its creation is under test
    world.buildings.patch(lab.id, { blockedAt: null });
    world.ops.updateBuilding(env.world.ops.ensureAvatar(env.seed.admin.id), lab.id, { rules: "Re-check." }); // a settings change re-checks the blocked state
    for (let i = 0; i < 3; i++) { await runtime.tickOnce(); await runtime.whenIdle(); }
    const wakes = world.assignments.where("agentId = ? AND title LIKE 'Get human decisions%'", [mei.id]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.description).toContain("rollup: true");
    expect(world.buildings.require(lab.id).blockedAt).not.toBeNull();
  });

  test("a rollup goes to the Town Hall and doesn't wake the manager again", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const id = s.received[0].match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield* callVerb(s, "submit_report", { title: "Rollup: carbon lab", body: `## Shipped\nNothing new.\n\n## Decided\n- ${id} → approved\n\n## Key results\nnone funded\n\n## Needs from Mitchell\nNothing needed.`, verdict: "continue" as const, rollup: true, provenance: { sourceIds: [id] } });
      yield result(200, 0.03);
    });
    const { world, runtime, sdk, by } = env;
    const mei = by("Mei");
    await world.verbs.submit_report(by("Noor").id, report("Growth rate"));
    await runtime.whenIdle();
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(1);
    const rollup = world.docs.first("authorId = ? AND type = 'report'", [mei.id])!;
    expect(rollup.tags).toContain("rollup");
    const th = world.buildings.first("kind = 'town-hall'")!;
    expect(intrayOf(world, th.id).map((d) => d.id)).toContain(rollup.id);
    expect(world.sessions.first("agentId = ? AND purpose = 'manage'", [mei.id])).toMatchObject({ status: "done", reportId: rollup.id });
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
