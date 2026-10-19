import { describe, it, expect } from "vitest";
import { World } from "../src/index.ts";

describe("meeting decisions supersede pending reports", () => {
  it("approves Ravi's pending report when a meeting assigns him new work", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const ravi = world.agents.first("name = ?", ["Ravi"])!;
    const pending = world.docs.first("authorId = ? AND type = 'report' AND decision = 'pending'", [ravi.id]);
    expect(pending).toBeTruthy();
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: "carbon-cycle", title: "s", startNow: true });
    world.ops.meetingDecide(null, m.id, [{ text: "Ravi: land-use change methods", assigneeId: ravi.id, assignmentId: null }]);
    const after = world.docs.get(pending!.id)!;
    expect(after.decision).toBe("approve");
    expect(after.decisionNote).toMatch(/Superseded by a decision in meeting/);
    world.close();
  });
});
