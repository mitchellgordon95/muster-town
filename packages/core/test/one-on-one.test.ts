import { describe, expect, it } from "vitest";
import { meetingNotice } from "../src/meetings.ts";
import { oneOnOnePrompt } from "../src/prompts.ts";
import { seededWorld } from "./helpers.ts";

describe("the manager's 1:1", () => {
  it("opens in discussing with the manager only; the human and manager speak; decisions → assignments; the human ends it", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    // no manager agent: send a message instead
    expect(() => world.ops.openOneOnOne(admin, "carbon-cycle")).toThrow(/no manager agent/);
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const m = world.ops.openOneOnOne(admin, "carbon-cycle");
    expect(m).toMatchObject({ kind: "one-on-one", phase: "discussing", facilitatorId: mei.id, attendeeIds: [mei.id], withUserId: world.holderOf(admin).id, summaries: {} });
    expect(m.startedAt).not.toBeNull();
    // the manager doesn't go in-meeting (its manage session answers) and isn't sent a standup invite
    expect(world.agents.require(mei.id).status).not.toBe("in-meeting");
    expect((await world.verbs.inbox(mei, {})).messages.some((x) => x.meetingId === m.id)).toBe(false);
    // opening again returns the same open 1:1
    expect(world.ops.openOneOnOne(admin, "carbon-cycle").id).toBe(m.id);
    // a resident can't open one, nor speak in it
    expect(() => world.ops.openOneOnOne(by("Noor"), "carbon-cycle")).toThrow();
    world.ops.meetingSay(admin, m.id, "What's blocking the ocean sink work?");
    await world.verbs.meeting(mei, { meetingId: m.id, action: "speak", text: "Noor needs SOCAT 2025; I'll assign it." });
    await expect(world.verbs.meeting(by("Noor"), { meetingId: m.id, action: "speak", text: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    const d = await world.verbs.meeting(mei, { meetingId: m.id, action: "decide", decisions: [{ text: "Noor: pull SOCAT 2025", assigneeId: by("Noor").id, assignmentId: null }] });
    const a = (d as { decisions: { assignmentId: string | null }[] }).decisions[0].assignmentId!;
    expect(world.assignments.require(a)).toMatchObject({ agentId: by("Noor").id, fromMeetingId: m.id });
    // the manager never ends a 1:1
    await expect(world.verbs.meeting(mei, { meetingId: m.id, action: "end" })).rejects.toMatchObject({ code: "conflict" });
    const ended = world.ops.endMeeting(admin, m.id);
    expect(ended.phase).toBe("done");
    const notes = world.docs.require(world.meetings.require(m.id).notesDocId!);
    expect(notes).toMatchObject({ type: "meeting-notes", state: "building", buildingId: "carbon-cycle" });
    expect(notes.body).toContain("SOCAT 2025");
    // a new 1:1 after the old one ended
    expect(world.ops.openOneOnOne(admin, "carbon-cycle").id).not.toBe(m.id);
  });

  it("can't be created as a regular meeting kind", () => {
    const { world, admin } = seededWorld();
    expect(() => world.ops.createMeeting(admin, { kind: "one-on-one" as "standup", buildingId: "carbon-cycle", startNow: true })).toThrow();
  });

  it("a town notice is a system line (no speaker checks); the pick-up prompt lists only the human's lines after the manager's last reply", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const m = world.ops.openOneOnOne(admin, "carbon-cycle");
    const nameOf = world.nameOf.bind(world);
    expect(oneOnOnePrompt(m, nameOf)).toContain("greet them");
    world.ops.meetingSay(admin, m.id, "First question?");
    await world.verbs.meeting(mei, { meetingId: m.id, action: "speak", text: "First answer." });
    expect(oneOnOnePrompt(world.meetings.require(m.id), nameOf)).not.toContain("unanswered"); // answered: no pick-up
    world.ops.meetingSay(admin, m.id, "Second question?");
    meetingNotice(world, m.id, "Mei's reply is waiting on a redeploy (commit abc1234); the server is restarting and the meeting resumes after the restart.");
    world.ops.meetingSay(admin, m.id, "hello?");
    const after = world.meetings.require(m.id);
    expect(after.transcript.at(-2)).toMatchObject({ speakerId: "system", speakerKind: "system" });
    const p = oneOnOnePrompt(after, nameOf);
    expect(p).toContain("- Town: Mei's reply is waiting on a redeploy");
    const missed = p.split("these 2 lines after your last reply are still unanswered:\n")[1];
    expect(missed).toMatch(/^- .+: Second question\?\n- .+: hello\?\nAnswer them now/);
    expect(missed).not.toContain("First question?");
    world.ops.endMeeting(admin, m.id);
    expect(meetingNotice(world, m.id, "late")).toBeNull(); // a closed meeting is left alone
  });
});
