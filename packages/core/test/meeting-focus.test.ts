/**
 * The item open on a 1:1's human's screen (Mitchell 2026-11-09: "i think the secretary should know what's open please"):
 * the decision queue sets the Secretary 1:1's `focus`; only that human may; the same item twice writes nothing; the
 * agent's listen (and the runtime's turn input) carries the open item rebuilt from live data; act_in_1on1 with no
 * target acts on it, still citing the human's words.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createOneOnOne, decideAsk, focusBlock, focusTarget, setMeetingFocus, townRoleId } from "../src/index.ts";
import { retireAsks } from "../src/asks.ts";
import { screenViews, VIEW_CAP_MS } from "../src/screen-views.ts";
import { endMeeting } from "../src/meetings.ts";
import { askAt, creditBank, seededWorld, renderNeeds, seedAsk } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const th = world.buildings.first("kind = 'town-hall'")!;
  const propose = () => askAt(world, world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective: "Banner shows Usage", approach: "a banner line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 350_000,
  }).id), 350_000);
  // the manager renders each proposal's need as its ask (1:1 mt_t65exni4et)
  const proposal = () => { const g = propose(); renderNeeds(world, manager.id); return g; };
  const m = createOneOnOne(world, admin, th.id, { agentId: sec.id });
  const askOf = (grantId: string) => world.asks.first("targetKind = 'grant' AND targetId = ?", [grantId])!;
  return { ...s, world, manager, sec, th, proposal, m, askOf };
}

describe("the 1:1's open item (focus)", () => {
  it("only the 1:1's human may set it: another human, an agent, a guest are refused", async () => {
    const { world, admin, sec, m, proposal, askOf } = setup();
    const a = askOf(proposal().id);
    const set = setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id });
    expect(set.focus).toMatchObject({ kind: "ask", id: a.id });
    const { user } = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("admin"));
    const ana = world.ops.ensureAvatar(user.id);
    expect(() => setMeetingFocus(world, ana, m.id, null)).toThrow(/Only .* whose 1:1 this is/);
    expect(() => setMeetingFocus(world, sec, m.id, { kind: "ask", id: "ak_x" })).toThrow(/Only .* whose 1:1 this is/);
    expect(world.meetings.require(m.id).focus).toMatchObject({ id: a.id });
    // a meeting that isn't a 1:1
    const mt = world.ops.createMeeting(admin, { kind: "standup", buildingId: LAB, title: "Standup", scheduledAt: new Date().toISOString() } as never);
    expect(() => setMeetingFocus(world, admin, mt.id, { kind: "ask", id: a.id })).toThrow(/not a 1:1/);
    // null clears it
    expect(setMeetingFocus(world, admin, m.id, null).focus).toBeNull();
  });

  it("the same focus twice writes nothing and logs no event", () => {
    const { world, admin, m, proposal, askOf } = setup();
    const a = askOf(proposal().id);
    let writes = 0;
    world.changes.subscribe((c) => { if (c.type === "meeting" && c.meeting.id === m.id) writes++; });
    const events = world.events.list({}).length;
    const first = setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, "2030-01-01T00:00:00.000Z");
    const again = setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, "2030-01-01T00:05:00.000Z");
    expect(writes).toBe(1);
    expect(again.focus!.at).toBe(first.focus!.at);
    setMeetingFocus(world, admin, m.id, null);
    setMeetingFocus(world, admin, m.id, null);
    expect(writes).toBe(2);
    expect(world.events.list({}).length).toBe(events);
  });

  it("listen carries the open item from live data: the ask's card, branches, status and target, then 'retired since it was opened'", async () => {
    const { world, admin, sec, m, proposal, askOf } = setup();
    const g = proposal();
    const a = askOf(g.id);
    setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id });
    world.ops.meetingSay(admin, m.id, "what's this about?");
    const heard = await world.verbs.meeting(sec, { meetingId: m.id, action: "listen" }) as { openOnScreen?: string };
    expect(heard.openOnScreen).toMatch(new RegExp(`^## Open on ${admin.name}'s screen\\n`));
    expect(heard.openOnScreen).toContain(`Ask ${a.id} (money): "${a.title}"`);
    expect(heard.openOnScreen).toMatch(/Branches: Fund \/ /);
    expect(heard.openOnScreen).toContain("Status: open");
    expect(heard.openOnScreen).toContain(`About: grant ${g.id} "Banner shows Usage" (proposed; asks 350,000 tokens)`);
    expect(heard.openOnScreen!.split(/\s+/).length).toBeLessThan(250);
    // funded on the button meanwhile: the ask retired after it was opened, said plainly
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    const block = focusBlock(world, world.meetings.require(m.id));
    expect(block).toMatch(/Status: RETIRED since it was opened/);
    expect(block).toContain(`About: grant ${g.id} "Banner shows Usage" (funded;`);
  });

  it("says when the ask was decided since it was opened, and reports a gone id as gone", () => {
    const { world, admin, th, m } = setup();
    const { ask } = seedAsk(world, { type: "policy", buildingId: th.id, sourceDocId: null, title: "Should reviews wait for CI?", line: "Should reviews wait for CI?", body: "Two labs disagree.", branches: [{ label: "Yes" }, { label: "No" }] });
    setMeetingFocus(world, admin, m.id, { kind: "ask", id: ask.id });
    expect(focusBlock(world, world.meetings.require(m.id))).toContain("Status: open");
    decideAsk(world, admin, ask.id, "Yes, always");
    expect(focusBlock(world, world.meetings.require(m.id))).toMatch(new RegExp(`Status: DECIDED since it was opened by ${admin.name}: "Yes, always"`));
    setMeetingFocus(world, admin, m.id, { kind: "grant", id: "gr_gone" });
    expect(focusBlock(world, world.meetings.require(m.id))).toBe(`## Open on ${admin.name}'s screen\nThe item on screen (gr_gone) is gone.`);
    setMeetingFocus(world, admin, m.id, null);
    expect(focusBlock(world, world.meetings.require(m.id))).toBe("");
  });

  it("act_in_1on1 with 'fund it' and no target decides the focused grant as the human", async () => {
    const { world, admin, sec, m, proposal, askOf } = setup();
    const g = proposal();
    setMeetingFocus(world, admin, m.id, { kind: "ask", id: askOf(g.id).id });
    expect(focusTarget(world, world.meetings.require(m.id))).toBe(g.id);
    world.ops.meetingSay(admin, m.id, "fund it");
    const at = world.meetings.require(m.id).transcript.at(-1)!.at;
    const r = await world.verbs.act_in_1on1(sec, { meetingId: m.id, utteranceAt: at, action: "fund" });
    expect(r).toMatchObject({ targetId: g.id, status: "funded" });
    const h = world.grants.require(g.id).history.at(-1)!;
    expect(h).toMatchObject({ action: "fund", byId: world.holderOf(admin).id, viaAgentId: sec.id, viaMeetingId: m.id });
    expect(h.note).toBe(`by ${admin.name} via ${sec.name} in ${m.id}: "fund it"`);
    // nothing decidable open: it asks for a target instead of guessing
    setMeetingFocus(world, admin, m.id, null);
    await expect(world.verbs.act_in_1on1(sec, { meetingId: m.id, utteranceAt: at, action: "fund" })).rejects.toThrow(/nothing is open/);
  });

  describe("screen views (queue health, gr_pdja05z2f1 step 1)", () => {
    const T0 = Date.parse("2030-01-01T00:00:00.000Z");
    const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
    const views = (world: Parameters<typeof screenViews>[0], nowMin = 120) => screenViews(world, at(-1), new Date(T0 + nowMin * 60_000));

    it("focus A, then B, then null writes two closed views with their minutes; the same item twice writes one", () => {
      const { world, admin, m, proposal, askOf } = setup();
      const a = askOf(proposal().id), b = askOf(proposal().id);
      setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, at(0));
      setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, at(1));
      setMeetingFocus(world, admin, m.id, { kind: "ask", id: b.id }, at(3));
      setMeetingFocus(world, admin, m.id, null, at(4));
      setMeetingFocus(world, admin, m.id, null, at(5));
      const v = views(world);
      expect(v.map((x) => [x.itemId, x.openedAt, x.closedAt, x.ms / 60_000])).toEqual([[a.id, at(0), at(3), 3], [b.id, at(3), at(4), 1]]);
      expect(v.every((x) => x.userId === admin.ownerUserId && x.meetingId === m.id && x.kind === "ask" && !x.open)).toBe(true);
    });

    it("records the view while the 1:1 is not discussing (the focus itself stays unset), and the 1:1's end closes it", () => {
      const { world, admin, m, proposal, askOf } = setup();
      const a = askOf(proposal().id);
      world.meetings.upsert({ ...world.meetings.require(m.id), phase: "collecting" });
      expect(setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, at(0)).focus ?? null).toBeNull();
      setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, at(2)); // the focus stays null, but the open view is the same item: no second row
      expect(views(world)).toHaveLength(1);
      expect(views(world)[0]!.open).toBe(true);
      endMeeting(world, admin, m.id);
      const [v] = views(world);
      expect(v!.open).toBe(false);
      expect(v!.closedAt).not.toBeNull();
    });

    it("a view left open (no null reached the server) counts at most 30 minutes, and the row is not rewritten", () => {
      const { world, admin, m, proposal, askOf } = setup();
      const a = askOf(proposal().id);
      setMeetingFocus(world, admin, m.id, { kind: "ask", id: a.id }, at(0));
      expect(views(world, 10)[0]).toMatchObject({ open: true, ms: 10 * 60_000 });
      expect(views(world, 600)[0]).toMatchObject({ open: true, ms: VIEW_CAP_MS, closedAt: null });
    });

    it("a fund retires the grant's money ask with by = the funder; a moot retire stays by system", () => {
      const { world, admin, proposal, askOf } = setup();
      const g = proposal();
      world.grantDesk.decide(admin, g.id, { action: "fund" });
      const retire = askOf(g.id).history.find((h) => h.action === "retire")!;
      expect(askOf(g.id).status).toBe("retired");
      expect(retire.by).toBe(admin.ownerUserId);
      const g2 = proposal();
      retireAsks(world, "grant", g2.id, "moot: the plan changed");
      expect(askOf(g2.id).history.find((h) => h.action === "retire")!.by).toBe("system");
    });
  });
});
