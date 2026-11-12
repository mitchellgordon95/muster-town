import { describe, it, expect } from "vitest";
import { jobThread, World } from "../src/index.ts";

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

  it("each decision is an entry on a thread: on the job of the work it made, or the building's own when it names nobody; the superseded report's answer is there too (plan dc_uwx045472m step 5b)", () => {
    const world = World.open(":memory:");
    world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
    const ravi = world.agents.first("name = ?", ["Ravi"])!;
    const pending = world.docs.first("authorId = ? AND type = 'report' AND decision = 'pending'", [ravi.id])!;
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: "carbon-cycle", title: "s", startNow: true });
    const after = world.ops.meetingDecide(null, m.id, [
      { text: "Ravi: land-use change methods", assigneeId: ravi.id, assignmentId: null },
      { text: "Record only: no posting until the queue is fixed", assigneeId: null, assignmentId: null },
    ]);
    const work = jobThread(world, after.decisions[0]!.assignmentId!)!;
    const made = work.entries.find((e) => e.moved.kind === "meeting-decision")!;
    expect(made).toMatchObject({ level: "none", note: "Ravi: land-use change methods", assignmentId: after.decisions[0]!.assignmentId, moved: { meetingId: m.id } });
    const own = jobThread(world, "carbon-cycle")!.entries;
    expect(own.find((e) => e.note.startsWith("Record only"))).toMatchObject({ level: "none", jobId: "jb_carbon-cycle", assignmentId: null });
    // the report the decision superseded is answered on its thread, live
    expect(own.find((e) => e.answers === `en_${pending.id}`)).toMatchObject({ moved: { decision: "approve" } });
    // no town-written report doc for any of it
    expect(world.docs.count("authorId = 'system' AND type = 'report'")).toBe(0);
    world.close();
  });
});
