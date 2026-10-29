import { describe, expect, it } from "vitest";
import { meetingNotice } from "../src/meetings.ts";
import { oneOnOnePrompt } from "../src/prompts.ts";
import { buildingRoleId } from "../src/index.ts";
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

  it("with agentId and docId: a 1:1 with the report's author, the report presented first; a fork or gone author reaches the manager", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor"), ravi = by("Ravi");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const { id } = await world.verbs.submit_report(noor, { title: "Ocean sink", body: "## Findings\n2.9 GtC/yr", verdict: "continue" });
    const m = world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: noor.id, docId: id });
    expect(m).toMatchObject({ facilitatorId: noor.id, attendeeIds: [noor.id], title: expect.stringContaining("Noor") });
    expect(m.transcript[0]).toMatchObject({ speakerKind: "user", attachment: { kind: "doc", ref: id } });
    expect(oneOnOnePrompt(m, world.nameOf.bind(world))).toContain(id);
    // only Noor and the human speak in it; the manager's 1:1 is a separate meeting
    await world.verbs.meeting(noor, { meetingId: m.id, action: "speak", text: "Happy to explain." });
    await expect(world.verbs.meeting(mei, { meetingId: m.id, action: "speak", text: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    expect(world.ops.openOneOnOne(admin, "carbon-cycle").facilitatorId).toBe(mei.id);
    // the same 1:1 about a second report presents it once more, not a new meeting
    const r2 = await world.verbs.submit_report(noor, { title: "Land sink", body: "x", verdict: "continue" });
    const again = world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: noor.id, docId: r2.id });
    expect(again.id).toBe(m.id);
    expect(again.transcript.filter((u) => u.attachment?.kind === "doc").map((u) => u.attachment!.ref)).toEqual([id, r2.id]);
    // a fork (live or retired) reaches the manager it forks from; a retired resident reaches the building's manager
    world.agents.patch(ravi.id, { forkOf: mei.id });
    expect(world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: ravi.id }).facilitatorId).toBe(mei.id);
    world.agents.patch(ravi.id, { forkOf: null, status: "retired" });
    expect(world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: ravi.id }).facilitatorId).toBe(mei.id);
    // a resident can't open one
    expect(() => world.ops.openOneOnOne(noor, "carbon-cycle", { agentId: mei.id })).toThrow();
  });

  it("any agent-authored doc type opens a 1:1 with its author; a human's doc has no author to talk to; a grant reaches its proposer with its key result (1:1 mt_u6euky43hg)", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId("carbon-cycle", "manager"));
    const art = await world.verbs.write(noor, { title: "Ocean sink primer", body: "2.9 GtC/yr", type: "article", state: "building" });
    const m = world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: noor.id, docId: art.id });
    expect(m.facilitatorId).toBe(noor.id);
    expect(m.transcript[0]).toMatchObject({ attachment: { kind: "doc", ref: art.id }, text: expect.stringContaining('your article "Ocean sink primer"') });
    // a human author: nobody to resolve to
    const human = world.agents.require(world.ops.ensureAvatar(world.holderOf(admin).id).id);
    expect(() => world.ops.openOneOnOne(admin, "carbon-cycle", { agentId: human.id })).toThrow(/can't take a 1:1/);
    // a grant: its proposer (the manager) answers; the first line presents the grant and names its key result
    const notes = world.docs.upsert({ ...world.docs.first("1 = 1")!, id: "dc_notes1", type: "meeting-notes", state: "building", buildingId: "carbon-cycle", title: "1:1 notes", body: "KR" });
    const kr = (await world.verbs.set_key_result(mei, { text: "Sink numbers on the banner", howToCheck: "Open the banner", sourceDocIds: [notes.id] })).keyResult;
    const { grantId } = await world.verbs.propose_grant(mei, { keyResultId: kr.id, objective: "Ship the sink banner", stopCondition: "s", askTokens: 1000 });
    const g = world.ops.openOneOnOne(admin, "carbon-cycle", { grantId });
    expect(g.facilitatorId).toBe(mei.id);
    expect(g.transcript[0]).toMatchObject({ speakerKind: "user", attachment: { kind: "page", ref: `grant:${grantId}` } });
    expect(g.transcript[0]!.text).toContain(grantId);
    expect(g.transcript[0]!.text).toContain(kr.id);
    expect(oneOnOnePrompt(g, world.nameOf.bind(world))).toContain("Sink numbers on the banner");
    // presented once; a grant of another building is refused; an unknown grant is not found
    expect(world.ops.openOneOnOne(admin, "carbon-cycle", { grantId }).transcript).toHaveLength(1);
    const other = world.buildings.first("id != ? AND kind != 'town-hall'", ["carbon-cycle"]);
    if (other) expect(() => world.ops.openOneOnOne(admin, other.id, { grantId })).toThrow(/another building/);
    expect(() => world.ops.openOneOnOne(admin, "carbon-cycle", { grantId: "gr_nope" })).toThrow(/not found|No grant|Grant/);
  });
});
