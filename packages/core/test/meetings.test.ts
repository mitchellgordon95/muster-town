import { describe, expect, it } from "vitest";
import { HUMAN_QUIET_MS } from "../src/meetings.ts";
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
    // Mitchell spoke just now: the agent facilitator leaves ending to them
    await expect(world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "end" })).rejects.toMatchObject({ code: "conflict" });
    const quiet = world.meetings.require(m.id);
    world.meetings.upsert({ ...quiet, transcript: quiet.transcript.map((u) => ({ ...u, at: new Date(Date.now() - HUMAN_QUIET_MS - 1000).toISOString() })) });
    const end = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "end" });
    const notesId = (end as { notesDocId: string }).notesDocId;
    const notes = world.docs.require(notesId);
    expect(notes).toMatchObject({ type: "meeting-notes", state: "building", buildingId: "carbon-cycle" });
    expect(notes.body).toContain("reconcile GRESO");
    expect(notes.body).toContain("Ocean sink 3.4");
    expect(world.meetings.require(m.id).phase).toBe("done");
    expect(world.agents.require(by("Mei").id).status).toBe("idle");
  });

  it("listen with waitSeconds waits for the next utterance; a human ends the meeting", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.startMeeting(admin, m.id);
    world.ops.meetingSay(admin, m.id, "First question?");
    expect(await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen", waitSeconds: 30 })).toMatchObject({ utterances: [{ text: "First question?" }] });
    // nothing new: the facilitator waits instead of returning empty and moving on
    const waiting = world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen", waitSeconds: 30 });
    setTimeout(() => world.ops.meetingSay(admin, m.id, "Second question?"), 20);
    expect(await waiting).toMatchObject({ phase: "discussing", utterances: [{ text: "Second question?" }] });
    // the human's End button closes it and wakes a waiting listen
    const closing = world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "listen", waitSeconds: 30 });
    setTimeout(() => world.ops.endMeeting(admin, m.id), 20);
    expect(await closing).toMatchObject({ phase: "done", utterances: [] });
  });

  it("town-hall meetings put notes in the library", () => {
    const { world } = seededWorld();
    const m = world.ops.createMeeting(null, { kind: "town-hall", buildingId: null, startNow: true });
    expect(m.attendeeIds).toContain(world.agents.first("name = 'Moss'")!.id);
    world.ops.endMeeting(null, m.id);
    const notes = world.docs.require(world.meetings.require(m.id).notesDocId!);
    expect(notes.state).toBe("library");
  });

  it("invites only the chosen attendees when attendeeIds is given", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    const m = world.ops.createMeeting(admin, { kind: "planning", buildingId: "carbon-cycle", startNow: true, attendeeIds: [mei.id, noor.id, mei.id] });
    expect(m.attendeeIds).toEqual([mei.id, noor.id]);
    expect(m.facilitatorId).toBe(by("Moss").id);
    const invited = async (name: string) => (await world.verbs.inbox(by(name), {})).messages.some((x) => x.kind === "meeting" && x.meetingId === m.id);
    expect(await invited("Mei")).toBe(true);
    expect(await invited("Noor")).toBe(true);
    expect(await invited("Ravi")).toBe(false);
    // omitted → every resident, as before
    expect(world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle" }).attendeeIds).toHaveLength(6);
  });

  it("rejects attendee lists that are empty, unknown, human, or inactive", () => {
    const { world, by, admin } = seededWorld();
    const make = (attendeeIds: string[]) => () => world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", attendeeIds });
    expect(make([])).toThrow();
    expect(make(["ag_nobody"])).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(make([admin.id])).toThrow(expect.objectContaining({ code: "bad_request" }));
    world.agents.upsert({ ...by("Noor"), status: "stopped" });
    expect(make([by("Mei").id, by("Noor").id])).toThrow(/Noor.*stopped/);
    expect(world.meetings.count("1=1")).toBe(0);
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
  it("ending a cancelled meeting is a conflict and writes no notes", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.setMeetingPhase(m.id, "cancelled");
    await expect(world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "end" })).rejects.toMatchObject({ code: "conflict" });
    expect(() => world.ops.endMeeting(null, m.id)).toThrow(/cancelled/);
    expect(world.docs.where("type = 'meeting-notes'")).toEqual([]);
    expect(world.meetings.require(m.id)).toMatchObject({ phase: "cancelled", notesDocId: null });
  });
});
