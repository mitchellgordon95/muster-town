import { describe, expect, test } from "vitest";
import { intrayOf } from "@muster-town/core";
import { callVerb, deferred, init, result, setup, type FakeSession, type Script } from "./helpers.ts";

const report = (title: string) => ({ title, verdict: "stop" as const, body: "## What I did\nMeasured it.\n\n## Findings\n2.4 ± 0.1 ppm/yr.\n\n## What I need from you\nNothing needed." });

/** Seeded lab with Mei as its manager agent and the seed's reports decided; `script` drives every SDK session. */
async function managed(script: Script) {
  const env = setup(script);
  const admin = env.world.ops.ensureAvatar(env.seed.admin.id);
  for (const d of intrayOf(env.world, env.lab.id)) await env.world.verbs.review(admin.id, { docId: d.id, decision: "approve" });
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

  test("a rollup goes to the Town Hall and doesn't wake the manager again", async () => {
    const env = await managed(async function* (s) {
      yield init();
      const id = s.received[0].match(/(dc_[a-z0-9]+)/)![1];
      yield* callVerb(s, "review", { docId: id, decision: "approve" });
      yield* callVerb(s, "submit_report", { ...report("Rollup: carbon lab"), verdict: "continue" as const, rollup: true, provenance: { sourceIds: [id] } });
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
    // out of budget: still nothing
    world.setStatus(mei.id, "idle");
    world.agents.patch(mei.id, { spentTokensToday: env.lab.dailyTokensPerAgent });
    expect(world.budget.canStart(mei.id)).toBe(false);
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(0);
    world.agents.patch(mei.id, { spentTokensToday: 0 });
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
