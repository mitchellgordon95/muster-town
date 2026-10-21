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
