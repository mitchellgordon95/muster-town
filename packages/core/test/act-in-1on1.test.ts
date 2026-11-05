/**
 * act_in_1on1 (gr_kdlogzzo5s step 1, design dc_8gbluwrdgi §3): in a 1:1 its agent does what the human just said, as that
 * human. Only the 1:1's own human's recent words count; the human's own gate applies; the history entry is the human's,
 * "via" the agent; stop and Bank inputs are refused.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, grantDirect, townRoleId } from "../src/index.ts";
import { actForHuman } from "../src/act-in-1on1.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [{ text: "A visitor can see today's spend", howToCheck: "Open the lab banner" }];

function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
  const proposal = () => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: KRS, objective: "Visitors can tell what the lab is for", approach: "a banner", stopCondition: "two tries", askTokens: 500_000 }).id);
  /** a human says a line in the 1:1; returns its `at` */
  const say = (human: typeof admin, meetingId: string, text: string) => {
    world.ops.meetingSay(human, meetingId, text);
    return world.meetings.require(meetingId).transcript.at(-1)!.at;
  };
  return { ...s, mei, proposal, say };
}

describe("act_in_1on1", () => {
  it("funds a proposal as the human: the human's history entry, via the agent, quoting them; an event and a line in the 1:1", async () => {
    const { world, admin, mei, proposal, say } = setup();
    const g = proposal();
    const m = world.ops.openOneOnOne(admin, LAB);
    const at = say(admin, m.id, `Fund ${g.id} at 600k please`);
    const r = await world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "fund", targetId: g.id, tokens: 600_000 });
    expect(r).toMatchObject({ targetId: g.id, status: "funded" });
    const after = world.grants.require(g.id);
    expect(after).toMatchObject({ status: "funded", grantTokens: 600_000, fundedBy: world.holderOf(admin).id });
    const h = after.history.at(-1)!;
    expect(h).toMatchObject({ action: "fund", byId: world.holderOf(admin).id, byKind: "user", viaAgentId: mei.id, viaMeetingId: m.id, tokens: 600_000 });
    expect(h.note).toBe(`by ${admin.name} via Mei in ${m.id}: "Fund ${g.id} at 600k please"`);
    const ev = world.events.list({ types: ["grant.decided-via"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ meetingId: m.id, agentId: mei.id, utteranceAt: at, grantId: g.id, action: "fund" });
    expect(world.meetings.require(m.id).transcript.at(-1)).toMatchObject({ speakerKind: "system" });
    expect(world.meetings.require(m.id).transcript.at(-1)!.text).toMatch(/Mei did this for/);
  });

  it("only the 1:1's own human's recent words count; only its agent acts; only while it is open", async () => {
    const { world, admin, by, mei, proposal, say } = setup();
    const g = proposal();
    const m = world.ops.openOneOnOne(admin, LAB);
    const at = say(admin, m.id, "Reject it");
    await world.verbs.meeting(mei, { meetingId: m.id, action: "speak", text: "Shall I fund it?" });
    // Mei's line a second later (same-ms timestamps would make the citation ambiguous)
    const cur = world.meetings.require(m.id);
    const meiAt = new Date(Date.parse(at) + 1000).toISOString();
    world.meetings.upsert({ ...cur, transcript: cur.transcript.map((u, i) => i === cur.transcript.length - 1 ? { ...u, at: meiAt } : u) });
    const act = (agent = mei, utteranceAt = at, extra = {}) => world.verbs.act_in_1on1(agent, { meetingId: m.id, utteranceAt, action: "fund", targetId: g.id, ...extra });
    // the agent's own line is not the human's word (a line at another time is not found)
    await expect(act(mei, meiAt)).rejects.toMatchObject({ code: "forbidden" });
    await expect(act(mei, "2020-01-01T00:00:00.000Z")).rejects.toMatchObject({ code: "not_found" });
    // another agent can't act on this 1:1
    await expect(act(by("Noor"))).rejects.toMatchObject({ code: "forbidden" });
    // an old line: more than 30 min ago
    expect(() => actForHuman(world, mei, { meetingId: m.id, utteranceAt: at, action: "fund", targetId: g.id, note: "" }, new Date(Date.parse(at) + 31 * 60_000))).toThrow(/last 30 min/);
    // a meeting that isn't a 1:1, or a 1:1 that ended
    world.ops.endMeeting(admin, m.id);
    await expect(act()).rejects.toMatchObject({ code: "bad_request" });
    expect(world.grants.require(g.id).status).toBe("proposed");
  });

  it("the human's own gate applies: a member without building.fund is refused exactly as the button refuses them", async () => {
    const { world, admin, mei, proposal, say } = setup();
    const g = proposal();
    const { user } = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    const ana = world.ops.ensureAvatar(user.id);
    grantDirect(world, admin, user.id, world.goalTree.attachmentOf(LAB));
    const m = world.ops.openOneOnOne(ana, LAB);
    const at = say(ana, m.id, `Fund ${g.id}`);
    expect(() => world.grantDesk.decide(ana, g.id, { action: "fund" })).toThrow(expect.objectContaining({ code: "forbidden" }));
    await expect(world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "fund", targetId: g.id })).rejects.toMatchObject({ code: "forbidden" });
    expect(world.grants.require(g.id).status).toBe("proposed");
    expect(world.events.list({ types: ["grant.decided-via"] })).toHaveLength(0);
  });

  it("refuses stop and Bank inputs, and actions that don't fit the target", async () => {
    const { world, admin, mei, proposal, say } = setup();
    const g = proposal();
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    const m = world.ops.openOneOnOne(admin, LAB);
    const at = say(admin, m.id, "Stop that grant, and move my Bank input");
    const act = (action: "stop" | "fund" | "approve", targetId: string) => world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action, targetId });
    await expect(act("stop", g.id)).rejects.toThrow(/button/);
    await expect(act("fund", "bi_abc123")).rejects.toThrow(/Bank inputs/);
    await expect(act("approve", g.id)).rejects.toMatchObject({ code: "bad_request" });
    await expect(act("fund", "dc_abc123")).rejects.toMatchObject({ code: "bad_request" });
    expect(world.grants.require(g.id).status).toBe("funded");
  });

  it("declines an outbox request as the human: the request records them via the agent and 1:1, the author hears why; their gate applies", async () => {
    const { world, admin, by, mei, say } = setup();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { title: "Run the drill v1", body: "x" });
    // a member without town.approve_request is refused as the button refuses them
    const ana = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: ana.user.id }, townRoleId("member"));
    grantDirect(world, admin, ana.user.id, world.goalTree.attachmentOf(LAB));
    const anaAvatar = world.ops.ensureAvatar(ana.user.id);
    const am = world.ops.openOneOnOne(anaAvatar, LAB);
    const anaAt = say(anaAvatar, am.id, `decline ${id}`);
    await expect(world.verbs.act_in_1on1(mei, { meetingId: am.id, utteranceAt: anaAt, action: "decline", targetId: id })).rejects.toMatchObject({ code: "forbidden" });
    expect(world.docs.require(id).requestStatus).toBe("open");
    // the admin's word does it; only decline fits a request
    const m = world.ops.openOneOnOne(admin, LAB);
    const at = say(admin, m.id, `decline ${id}, it was replaced`);
    await expect(world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "reject", targetId: id })).rejects.toMatchObject({ code: "bad_request" });
    const r = await world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "decline", targetId: id, note: "Superseded by v2." });
    expect(r).toMatchObject({ targetId: id, status: "declined" });
    const d = world.docs.require(id);
    expect(d).toMatchObject({ requestStatus: "declined", requestDecidedById: world.holderOf(admin).id, requestViaAgentId: mei.id, requestViaMeetingId: m.id });
    expect(d.requestNote).toBe(`by ${admin.name} via Mei in ${m.id}: "decline ${id}, it was replaced"\nSuperseded by v2.`);
    expect(world.ops.outbox()).toHaveLength(0);
    expect((await world.verbs.inbox(ingrid, {})).messages.some((x) => x.body.includes(`via Mei in ${m.id} declined your outbox request`))).toBe(true);
    expect(world.events.list({ types: ["grant.decided-via"] })[0]!.payload).toMatchObject({ docId: id, action: "decline", meetingId: m.id });
    expect(world.meetings.require(m.id).transcript.at(-1)!.text).toMatch(/Mei did this for .*decline the request/);
    await expect(world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "decline", targetId: id })).rejects.toThrow(/declined/);
  });

  it("approves a retainer as the human", async () => {
    const { world, admin, mei, say } = setup();
    creditBank(world, 1_000_000);
    const t0 = Date.now();
    const { scheduleId } = (await world.verbs.schedule(mei, { title: "Sweep", description: "d", runsAt: new Date(t0 + 3_600_000).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * 3_600_000).toISOString() }, tokensPerRun: 3_000 })) as { scheduleId: string };
    const m = world.ops.openOneOnOne(admin, LAB);
    const at = say(admin, m.id, "Approve the sweep retainer");
    const r = await world.verbs.act_in_1on1(mei, { meetingId: m.id, utteranceAt: at, action: "approve", targetId: scheduleId });
    expect(r).toMatchObject({ targetId: scheduleId, status: "funded" });
    const s = world.schedules.require(scheduleId);
    expect(s).toMatchObject({ retainer: "funded", retainerDecidedBy: world.holderOf(admin).id });
    expect(s.retainerNote).toContain(`via Mei in ${m.id}`);
    expect(world.events.list({ types: ["grant.decided-via"] })[0]!.payload).toMatchObject({ scheduleId, action: "approve" });
  });
});
