import { describe, expect, test } from "vitest";
import { callVerb, init, result, setup, type FakeSession } from "./helpers.ts";

async function* work(s: FakeSession) {
  yield init();
  yield* callVerb(s, "submit_report", { title: "Done", verdict: "continue", body: "## Summary\nOk.\n\n## Proposal for next session\nNothing.\n" });
  yield result(100, 0.01);
}

describe("session slots (desks.maxRunning)", () => {
  test("the scheduler never runs more sessions than the cap; held agents start on a later pass, with one notice each way", async () => {
    const { world, runtime, by } = setup(work);
    world.setDesksConfig({ maxRunning: 1 });
    const mei = by("Mei"), noor = by("Noor");
    world.ops.createWork(null, mei.id, { title: "A" });
    world.ops.createWork(null, noor.id, { title: "B" });
    expect(world.host.slots?.()).toEqual({ running: 0, max: 1 });
    await runtime.tickOnce();
    await runtime.whenIdle();
    // one pass: the first agent in creation order took the only slot, the other was held
    const first = world.sessions.where("purpose = 'work'").map((s) => s.agentId);
    expect(first).toHaveLength(1);
    const heldAgent = first[0] === mei.id ? noor : mei;
    const full = world.events.recent({ limit: 50 }).find((e) => (e.payload as { alert?: string }).alert === "slots-full")!;
    expect(full.text).toBe(`All 1 session slots are in use: holding queued work for ${heldAgent.name}`);
    expect(full.payload).toMatchObject({ running: 0, max: 1, held: [heldAgent.id] });
    expect(world.snapshot().health).toEqual({ docker: true, slots: { running: 0, max: 1 } });
    // next pass: the slot is free, the held agent runs; the notice says so once
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(world.sessions.where("purpose = 'work'", [], "ORDER BY startedAt, rowid").map((s) => s.agentId)).toEqual([first[0], heldAgent.id]);
    const evs = world.events.recent({ limit: 50 });
    expect(evs.filter((e) => (e.payload as { alert?: string }).alert === "slots-full")).toHaveLength(1);
    expect(evs.filter((e) => (e.payload as { alert?: string }).alert === "slots-free")).toHaveLength(1);
    // a live change to the cap is read on the next pass
    world.setDesksConfig({ maxRunning: 3 });
    expect(world.host.slots?.()).toEqual({ running: 0, max: 3 });
  });
});

describe("scheduler queue order", () => {
  test("the scheduler starts the pending assignment with the lowest position, not the oldest", async () => {
    const { world, runtime, by } = setup(work);
    const mei = by("Mei");
    const a = world.ops.createWork(null, mei.id, { title: "Oldest" });
    world.ops.createWork(null, mei.id, { title: "Middle" });
    const c = world.ops.createWork(null, mei.id, { title: "Newest" });
    world.ops.reorderQueue(null, mei.id, [c.id]);
    await runtime.tickOnce();
    await runtime.whenIdle();
    const s = world.sessions.first("agentId = ? AND purpose = 'work'", [mei.id], "ORDER BY startedAt")!;
    expect(s.assignmentId).toBe(c.id);
    expect(world.assignments.require(a.id).status).toBe("pending");
  });
});

describe("the scheduler and the gate (Budget.canStart)", () => {
  test("a tick never starts an assignment that canStart refuses: a lane-held one stays pending with its reason and starts once the gate opens", async () => {
    const { world, runtime, by, seed, lab } = setup(work);
    const admin = world.ops.ensureAvatar(seed.admin.id);
    const noor = by("Noor");
    const kr = world.grantDesk.createKeyResult(admin, lab.id, { text: "A visitor can see today's spend", howToCheck: "Open the banner" });
    const g = world.grantDesk.propose(admin, world.grantDesk.create(admin, lab.id, { keyResultId: kr.id, objective: "o", stopCondition: "s", askTokens: 1_000_000 }).id);
    const a = world.ops.createWork(admin, noor.id, { title: "grant work", lane: "grant", grantId: g.id });
    expect(world.budget.canStart(noor.id, world.assignments.require(a.id))).toBe(false);
    for (let i = 0; i < 3; i++) { await runtime.tickOnce(); await runtime.whenIdle(); }
    expect(world.sessions.where("agentId = ? AND purpose = 'work'", [noor.id])).toHaveLength(0);
    expect(world.assignments.require(a.id)).toMatchObject({ status: "pending", heldReason: "held: grant not funded yet" });
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    await runtime.tickOnce(); await runtime.whenIdle();
    expect(world.sessions.where("agentId = ? AND purpose = 'work'", [noor.id]).map((s) => s.assignmentId)).toEqual([a.id]);
  });
});
