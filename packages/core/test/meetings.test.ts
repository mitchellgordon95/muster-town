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
});
