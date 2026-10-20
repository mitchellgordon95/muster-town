import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

describe("meetings", () => {
  it("collecting → discussing → decide → end writes notes and creates assignments", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    expect(m.phase).toBe("collecting");
    expect(m.attendeeIds).toHaveLength(6);
    expect(m.facilitatorId).toBe(by("Moss").id);
    expect((await world.verbs.inbox(by("Mei"), {})).messages.some((x) => x.kind === "meeting" && x.meetingId === m.id)).toBe(true);
    await world.verbs.meeting(by("Mei"), { meetingId: m.id, action: "summary", text: "Ocean sink 3.4 ± 0.4\nNext: SOCAT\nBlocked: none" });
    world.ops.startMeeting(admin, m.id);
    expect(world.agents.require(by("Mei").id).status).toBe("in-meeting");
    world.ops.meetingSay(admin, m.id, "Please focus on the 2024 imbalance.");
    await world.verbs.meeting(by("Noor"), { meetingId: m.id, action: "speak", text: "On it." });
    const heard = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen" });
    expect(heard).toMatchObject({ utterances: [{ speaker: "Mitchell", speakerKind: "user" }, { speaker: "Noor", speakerKind: "agent" }] });
    expect(await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen" })).toMatchObject({ utterances: [] });
    await expect(world.verbs.meeting(by("Noor"), { meetingId: m.id, action: "decide", decisions: [{ text: "x", assigneeId: null, assignmentId: null }] })).rejects.toMatchObject({ code: "forbidden" });
    const d = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "decide", decisions: [{ text: "Noor: reconcile GRESO vs NOAA growth rate", assigneeId: by("Noor").id, assignmentId: null }] });
    const decision = (d as { decisions: { assignmentId: string | null }[] }).decisions[0];
    expect(world.assignments.require(decision.assignmentId!)).toMatchObject({ agentId: by("Noor").id, fromMeetingId: m.id });
    const end = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "end" });
    const notesId = (end as { notesDocId: string }).notesDocId;
    const notes = world.docs.require(notesId);
    expect(notes).toMatchObject({ type: "meeting-notes", state: "building", buildingId: "carbon-cycle" });
    expect(notes.body).toContain("reconcile GRESO");
    expect(notes.body).toContain("Ocean sink 3.4");
    expect(world.meetings.require(m.id).phase).toBe("done");
    expect(world.agents.require(by("Mei").id).status).toBe("idle");
  });

  it("town-hall meetings put notes in the library", () => {
    const { world } = seededWorld();
    const m = world.ops.createMeeting(null, { kind: "town-hall", buildingId: null, startNow: true });
    expect(m.attendeeIds).toContain(world.agents.first("name = 'Moss'")!.id);
    world.ops.endMeeting(null, m.id);
    const notes = world.docs.require(world.meetings.require(m.id).notesDocId!);
    expect(notes.state).toBe("library");
  });
  it("decisions on a done or cancelled meeting are a conflict and create no assignments", async () => {
    const { world, by, admin } = seededWorld();
    const done = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.endMeeting(admin, done.id);
    const cancelled = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.setMeetingPhase(cancelled.id, "cancelled");
    const before = world.assignments.all().length;
    for (const m of [done, cancelled]) {
      await expect(world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "decide", decisions: [{ text: "late", assigneeId: by("Noor").id, assignmentId: null }] })).rejects.toMatchObject({ code: "conflict" });
      expect(world.meetings.require(m.id).decisions).toEqual([]);
    }
    expect(world.assignments.all()).toHaveLength(before);
  });
});
