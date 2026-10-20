import { describe, expect, test } from "vitest";
import { callVerb, init, result, setup, type FakeSession } from "./helpers.ts";

async function* work(s: FakeSession) {
  yield init();
  yield* callVerb(s, "submit_report", { title: "Done", verdict: "continue", body: "## Summary\nOk.\n\n## Proposal for next session\nNothing.\n" });
  yield result(100, 0.01);
}

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
