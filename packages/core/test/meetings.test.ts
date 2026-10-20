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

  it("nobody speaks while collecting; the last summary in starts the discussion", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    expect(() => world.ops.meetingSay(admin, m.id, "Hello?")).toThrow(/collecting summaries/);
    await expect(world.verbs.meeting(by("Mei"), { meetingId: m.id, action: "speak", text: "Hi" })).rejects.toMatchObject({ code: "conflict" });
    const [last, ...rest] = m.attendeeIds;
    for (const id of rest) await world.verbs.meeting(id, { meetingId: m.id, action: "summary", text: "Did: x\nNext: y" });
    expect(world.meetings.require(m.id).phase).toBe("collecting");
    await world.verbs.meeting(last, { meetingId: m.id, action: "summary", text: "Did: x\nNext: y" });
    expect(world.meetings.require(m.id)).toMatchObject({ phase: "discussing", transcript: [] });
    world.ops.meetingSay(admin, m.id, "Now we talk.");
    expect(world.meetings.require(m.id).transcript).toHaveLength(1);
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
    world.agents.upsert({ ...by("Noor"), status: "retired" });
    expect(make([by("Mei").id, by("Noor").id])).toThrow(/Noor.*retired/);
    expect(world.meetings.count("1=1")).toBe(0);
  });

  it("stopped residents are still invited to standups and a decision assigning them resumes them", async () => {
    const { world, by, admin } = seededWorld();
    world.agents.upsert({ ...by("Noor"), status: "stopped" });
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    expect(m.attendeeIds).toContain(by("Noor").id);
    expect(m.facilitatorId).not.toBe(by("Noor").id);
    world.ops.startMeeting(admin, m.id);
    expect(by("Noor").status).toBe("stopped");
    await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "decide", decisions: [{ text: "Noor: take the rename slice", assigneeId: by("Noor").id, assignmentId: null }] });
    expect(by("Noor").status).toBe("idle");
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [by("Noor").id])).toHaveLength(1);
  });

  it("the facilitator may record decisions in the grace window after a human closes the meeting; late ones land in the notes", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.startMeeting(admin, m.id);
    world.ops.meetingSay(admin, m.id, "move the filing cabinet to the right wall");
    world.ops.endMeeting(admin, m.id); // human pressed End before any decide
    const before = world.assignments.all().length;
    const out = await world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "decide", decisions: [{ text: "Move the filing cabinet to the right wall", assigneeId: by("Noor").id, assignmentId: null }] });
    expect(out).toBeTruthy();
    expect(world.assignments.all()).toHaveLength(before + 1);
    const notes = world.docs.require(world.meetings.require(m.id).notesDocId!);
    expect(notes.body).toMatch(/Decisions recorded after close/);
    expect(notes.body).toMatch(/filing cabinet/);
  });
  it("decisions on a done or cancelled meeting are a conflict and create no assignments", async () => {
    const { world, by, admin } = seededWorld();
    const done = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.endMeeting(admin, done.id);
    world.meetings.upsert({ ...world.meetings.require(done.id), endedAt: new Date(Date.now() - 10 * 60_000).toISOString() }); // closed 10 min ago: past the grace window
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
  it("a superseding decision rewrites or cancels the earlier assignment instead of adding a second one", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.startMeeting(admin, m.id);
    const decide = (decisions: { text: string; assigneeId: string | null; supersedes?: number }[]) =>
      world.verbs.meeting(by("Moss"), { meetingId: m.id, action: "decide", decisions: decisions.map((d) => ({ assignmentId: null, ...d })) }) as Promise<{ decisions: { n: number; assignmentId: string | null; supersededBy?: number }[] }>;
    const noor = by("Noor").id, mei = by("Mei").id;
    const first = await decide([{ text: "Noor: reconcile growth rates", assigneeId: noor }, { text: "Mei: SOCAT check", assigneeId: mei }]);
    const [a1, a2] = first.decisions.map((d) => d.assignmentId!);
    // same assignee: the pending assignment is rewritten in place
    const amended = await decide([{ text: "Noor: reconcile growth rates, NOAA only", assigneeId: noor, supersedes: 1 }]);
    expect(amended.decisions[2]).toMatchObject({ n: 3, assignmentId: a1 });
    expect(amended.decisions[0].supersededBy).toBe(3);
    expect(world.assignments.require(a1)).toMatchObject({ status: "pending", title: "Noor: reconcile growth rates, NOAA only" });
    expect(world.assignments.where("agentId = ? AND status = 'pending'", [noor])).toHaveLength(1);
    // reassigned: the old one is cancelled, the new assignee gets a fresh one
    const moved = await decide([{ text: "Noor takes the SOCAT check instead", assigneeId: noor, supersedes: 2 }]);
    expect(world.assignments.require(a2).status).toBe("cancelled");
    expect(moved.decisions[3].assignmentId).not.toBe(a2);
    // dropped: a general decision cancels it outright
    await decide([{ text: "Drop the NOAA reconciliation", assigneeId: null, supersedes: 3 }]);
    expect(world.assignments.require(a1).status).toBe("cancelled");
    // can't supersede twice or a decision that doesn't exist; a bad batch changes nothing
    await expect(decide([{ text: "again", assigneeId: null, supersedes: 1 }])).rejects.toMatchObject({ code: "conflict" });
    await expect(decide([{ text: "x", assigneeId: mei }, { text: "y", assigneeId: null, supersedes: 99 }])).rejects.toMatchObject({ code: "bad_request" });
    expect(world.meetings.require(m.id).decisions).toHaveLength(5);
    // a running assignment can only be amended for the same agent
    world.assignments.upsert({ ...world.assignments.require(moved.decisions[3].assignmentId!), status: "active" });
    await expect(decide([{ text: "Mei after all", assigneeId: mei, supersedes: 4 }])).rejects.toMatchObject({ code: "conflict" });
    await decide([{ text: "Noor: SOCAT check, 2023 only", assigneeId: noor, supersedes: 4 }]);
    expect((await world.verbs.inbox(by("Noor"), {})).messages.some((x) => x.body.includes("amended"))).toBe(true);
    world.ops.endMeeting(admin, m.id);
    expect(world.docs.require(world.meetings.require(m.id).notesDocId!).body).toContain("~~Mei: SOCAT check~~ (superseded by 4)");
  });
});
