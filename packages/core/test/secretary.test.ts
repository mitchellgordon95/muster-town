/**
 * The Secretary (gr_kdlogzzo5s step 2, design dc_8gbluwrdgi §1-2): a Town Hall resident that takes its own daily digest
 * schedule (`takerId`), the digest builder's yes/no "Decisions needed" lines from the deck's data, the skip when no new
 * rollup arrived, and filing the card (doc type digest, covered rollups in provenance, the ones that ask nothing archived).
 * Both sections grouped (Mitchell, 1:1 mt_i50xwu4z2t): decisions by kind of yes/no (overtaken asks retired), Shipped by theme.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createDoc, createOneOnOne, createResident, createSchedule, digestCard, fireSchedules, grantHistoryLine, nowIso, reviewDeck, townHallIntray } from "../src/index.ts";
import { DIGEST_TOKENS_PER_RUN, digestDecisions, digestIdleReason, digestInputs, fileDigest, groupsText, overtakenReason, stillAsks } from "../src/secretary.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const H = 3_600_000;
const rollupBody = (calls: string[]) => `## Shipped\n${calls.map((c, i) => `**${i + 1}. Item ${i + 1}**\n**What it is:** thing ${i + 1}\n**What you'd see:** the board\n![shot](/api/media/mf_x${i}.png)\n**Your call:** ${c}\n`).join("\n")}\n## Decided\n- none\n## Key results\n(none)\n## Needs from Mitchell\nNothing needed.`;

function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const th = world.buildings.first("kind = 'town-hall'")!;
  const rollup = (calls: string[], createdAt = nowIso()) => createDoc(world, {
    type: "report", title: `Rollup ${createdAt}`, body: rollupBody(calls), authorId: manager.id, authorKind: "agent", buildingId: LAB, state: "building",
    tags: ["rollup"], decision: "pending", createdAt,
  });
  const proposal = (objective: string, askTokens: number) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective, approach: "a banner line", stopCondition: "two failed tries", askTokens,
  }).id);
  return { ...s, world, admin, manager, sec, th, rollup, proposal };
}

describe("the Secretary", () => {
  it("is a Town Hall resident beside the Planner (who stays manager), made once; a human opens a 1:1 with it at the Town Hall", () => {
    const { world, sec, th, admin } = setup();
    expect(sec).toMatchObject({ kind: "resident", title: "Secretary", homeBuildingId: th.id });
    expect(world.secretary.ensure()!.id).toBe(sec.id);
    expect(world.buildings.require(th.id).managerAgentId).not.toBe(sec.id);
    const human = admin;
    const m = createOneOnOne(world, human, th.id, { agentId: sec.id });
    expect(m).toMatchObject({ kind: "one-on-one", facilitatorId: sec.id });
    expect(world.secretary.brief(m)).toMatch(/act_in_1on1` if available/);
    // the human's recent lines carry their exact ISO `at` (act_in_1on1 cites one by it)
    const said = world.meetings.patch(m.id, { transcript: [...m.transcript, { speakerId: world.holderOf(human).id, speakerKind: "user", text: "fund gr_x at 600k", at: new Date().toISOString() } as never] });
    expect(world.secretary.brief(said)).toMatch(new RegExp(`at ${said.transcript.at(-1)!.at.replace(/[.]/g, "\\.")}: "fund gr_x at 600k"`));
    // without agentId the Town Hall still opens the Planner
    expect(createOneOnOne(world, human, th.id).facilitatorId).toBe(world.reorgs.planner()!.id);
  });

  it("takerId: a Town Hall schedule needs a resident taker; the digest schedule asks its retainer, runs on the cheapModel, and fires to the Secretary's own queue", () => {
    const { world, sec, th, admin, rollup } = setup();
    expect(() => createSchedule(world, th.id, world.holderOf(admin), { title: "x", description: "d", runsAt: new Date(Date.now() + H).toISOString() })).toThrow(/takerId/);
    const other = createResident(world, { buildingId: LAB, name: "Ivy" });
    expect(() => createSchedule(world, th.id, world.holderOf(admin), { title: "x", description: "d", runsAt: new Date(Date.now() + H).toISOString(), takerId: other.id })).toThrow(/isn't a resident of/);
    const t0 = new Date("2030-01-01T06:00:00.000Z");
    const s = world.secretary.ensureDigestSchedule(t0)!;
    expect(s).toMatchObject({ buildingId: th.id, takerId: sec.id, lane: "retainer", retainer: "asked", tokensPerRun: DIGEST_TOKENS_PER_RUN, model: th.cheapModel, dailyAt: ["07:00"] });
    expect(world.secretary.ensureDigestSchedule(t0)!.id).toBe(s.id);
    // the run's instructions on the schedule follow the code (the live schedule was made before the themed form)
    world.schedules.patch(s.id, { description: "old prompt" });
    expect(world.secretary.ensureDigestSchedule(t0)!.description).toBe(s.description);
    rollup(["None"], "2030-01-01T06:30:00.000Z");
    const { fired } = fireSchedules(world, new Date("2030-01-01T07:00:30.000Z"));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ agentId: sec.id, queue: "agent", lane: "retainer", sourceId: s.id, model: th.cheapModel });
    expect(world.budget.sessionModel(sec.id, fired[0])).toBe(th.cheapModel);
  });

  it("a lab schedule with takerId goes to that resident's own queue, not the building queue", () => {
    const { world, admin } = setup();
    const ivy = createResident(world, { buildingId: LAB, name: "Ivy" });
    const t0 = Date.now();
    const s = createSchedule(world, LAB, world.holderOf(admin), { title: "once", description: "d", runsAt: new Date(t0 + H).toISOString(), takerId: ivy.id });
    expect(s.takerId).toBe(ivy.id);
    const a = fireSchedules(world, new Date(t0 + 2 * H)).fired[0]!;
    expect(a).toMatchObject({ agentId: ivy.id, queue: "agent" });
  });

  it("skips the run (no session) when no rollup arrived since the last digest, or a digest was filed today", () => {
    const { world, sec, rollup } = setup();
    const t0 = new Date("2030-01-01T06:00:00.000Z");
    const s = world.secretary.ensureDigestSchedule(t0)!;
    expect(digestIdleReason(world, t0)).toMatch(/no new rollup/);
    const { fired } = fireSchedules(world, new Date("2030-01-01T07:00:30.000Z"));
    expect(fired).toHaveLength(0);
    expect(world.events.list({ types: ["schedule.skipped"] }).at(-1)?.text).toMatch(/no new rollup/);
    expect(world.schedules.require(s.id).nextRunAt).toBe("2030-01-02T07:00:00.000Z");
    rollup(["None"], "2030-01-01T08:00:00.000Z");
    expect(digestIdleReason(world, new Date("2030-01-01T09:00:00.000Z"))).toBeNull();
    fileDigest(world, sec, [], new Date("2030-01-01T09:00:00.000Z"));
    expect(digestIdleReason(world, new Date("2030-01-01T10:00:00.000Z"))).toMatch(/already filed today/);
  });

  it("Decisions needed, grouped by kind: Money (checkpoint with top-up, proposal at its ask, retainer ask, a rollup call about one of them), Questions in words (a rollup call), Errands (outbox)", () => {
    const { world, admin, proposal, rollup, manager } = setup();
    const p = proposal("Banner shows Usage", 350_000);
    const held = proposal("Stop a grant cleanly", 600_000);
    world.grantDesk.decide(admin, held.id, { action: "fund", tokens: 600_000 });
    world.grants.patch(held.id, { status: "checkpoint", spentTokens: 410_000, topUpTokens: 200_000, whatTopUpBuys: "the web step" } as never);
    world.secretary.ensureDigestSchedule();
    rollup(["Merge PR #12?", "None", `Continue ${held.id} with the top-up: the web step is half built.`]);
    createDoc(world, { type: "request", title: "Photograph the sign", body: "x", authorId: manager.id, authorKind: "agent", state: "building", requestStatus: "open" });
    const { decisions, count } = digestDecisions(world);
    expect(decisions.map((g) => g.heading)).toEqual(["Money (4)", "Questions in words (1)", "Errands (1)"]);
    const money = decisions[0]!.lines;
    expect(money[0]).toMatch(new RegExp(`^Continue ${held.id} \\(Carbon.*"Stop a grant cleanly"\\) with a 200k top-up \\(spent \\d+k? of 600k; a top-up buys: the web step\\)\\?$`));
    expect(money).toContain(`Fund ${p.id} (${world.buildings.require(LAB).name}: "Banner shows Usage") at its 350k ask?`);
    expect(money.some((l) => /^Approve Town Hall's retainer "Daily in-tray digest" \(sc_\w+\): 10k per run, \d+k in all\?$/.test(l))).toBe(true);
    // a rollup's call naming an item that waits on its own row sits under Money with it
    expect(money.some((l) => new RegExp(`asks \\(dc_\\w+, "Item 3"\\): Continue ${held.id} with the top-up`).test(l))).toBe(true);
    expect(decisions[1]!.lines).toEqual([expect.stringMatching(/asks \(dc_\w+, "Item 1"\): Merge PR #12\?$/)]);
    expect(JSON.stringify(decisions)).not.toMatch(/Item 2/); // a None call is no decision
    expect(decisions[2]).toMatchObject({ note: "1 open outbox request: do or decline when you have time.", lines: [expect.stringMatching(/^"Photograph the sign" \(dc_\w+\)$/)] });
    expect(count).toBe(5); // errands aside
    expect(groupsText(decisions)).toMatch(/^\*\*Money \(4\)\*\*\n\n- Continue/);
  });

  it("Already overtaken: a call naming a key result since met, a grant since closed or funded, or a retainer since approved; one Approve-all; filing archives such a rollup", () => {
    const { world, admin, sec, proposal, rollup } = setup();
    const g = proposal("Banner shows Usage", 350_000);
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 350_000 });
    const kr = world.keyResults.first("buildingId = ?", [LAB])!;
    world.keyResults.patch(kr.id, { status: "met" } as never);
    const askFund = rollup([`Fund ${g.id} at its ask.`], new Date(Date.now() - 2 * H).toISOString());
    const askMet = rollup([`Mark ${kr.id} met on the grant if the live check satisfies you.`]);
    const live = rollup(["Should guests see the in-tray as a list or as cards?", `Mark ${kr.id} met.`]);
    const goNoGo = rollup(["All four steps are live: go / no-go on the rest?"]);
    const { decisions, overtakenIds } = digestDecisions(world);
    expect(decisions.map((x) => x.heading)).toEqual(["Go / no-go (1)", "Questions in words (1)", "Already overtaken (2)"]);
    expect(decisions[0]!.lines[0]).toMatch(/go \/ no-go on the rest\?$/);
    expect(decisions[1]!.lines[0]).toMatch(/list or as cards\?$/); // its other call (the met KR) is overtaken and left out
    const over = decisions[2]!;
    expect(over).toMatchObject({ note: "Approve these 2 and they drop out; nothing to decide.", docIds: [askFund.id, askMet.id] });
    expect(over.lines[0]).toContain(`${g.id} was funded after this ask`);
    expect(over.lines[1]).toContain(`${kr.id} is already met`);
    expect(overtakenIds).toEqual([askFund.id, askMet.id]);
    // a retainer since approved
    const s = world.secretary.ensureDigestSchedule()!;
    world.schedules.patch(s.id, { retainer: "funded" } as never);
    const askRetainer = rollup([`Approve the retainer ${s.id} and the first digest lands tomorrow.`]);
    expect(stillAsks(world, world.docs.require(askRetainer.id))).toBe(false);
    expect(stillAsks(world, world.docs.require(live.id))).toBe(true);
    // a "mark met" on a grant closed as done (closing marks its key results met)
    world.grants.patch(g.id, { status: "closed", outcome: "done" } as never);
    const askClosed = rollup([`${g.id} closed as done: mark the key results met from the in-tray.`]);
    expect(overtakenReason(world, { title: "x", whatItIs: "", yourCall: `${g.id} closed: mark its key results met.` }, askClosed)).toBe(`${g.id} closed as done: its key results are set`);
    // filing the card archives the overtaken rollups too; the live ones stay
    const doc = fileDigest(world, sec, []);
    expect(doc.provenance.sourceIds).toEqual([askFund.id, askMet.id, live.id, goNoGo.id, askRetainer.id, askClosed.id]);
    for (const id of [askFund.id, askMet.id, askRetainer.id, askClosed.id]) expect(world.docs.require(id).decision).toBe("approve");
    for (const id of [live.id, goNoGo.id]) expect(world.docs.require(id).decision).toBe("pending");
    expect(townHallIntray(world).reports.map((d) => d.id)).toEqual(expect.arrayContaining([live.id, goNoGo.id]));
  });

  it("files the card: doc type digest in the Town Hall, covered rollups in provenance; the ones that ask nothing are archived, a real call stays pending", () => {
    const { world, sec, manager, rollup } = setup();
    const quiet = rollup(["None"]);
    const asks = rollup(["Merge PR #12?"]);
    const x = digestInputs(world);
    expect(x.idle).toBeNull();
    expect(x.items.map((i) => [i.rollupId, i.title, i.picture])).toEqual([[quiet.id, "Item 1", "/api/media/mf_x0.png"], [asks.id, "Item 1", "/api/media/mf_x0.png"]]);
    expect(() => fileDigest(world, manager, [])).toThrow(/Only the Town Hall's Secretary/);
    expect(() => fileDigest(world, sec, [{ rollupId: "dc_nope", line: "x" }])).toThrow(/isn't a rollup filed since/);
    expect(() => fileDigest(world, sec, Array.from({ length: 9 }, (_, i) => ({ rollupId: quiet.id, line: "x", theme: `Theme ${i}` })))).toThrow(/At most 8 theme headings/);
    const doc = fileDigest(world, sec, [
      { rollupId: quiet.id, line: "The banner shows today's spend", picture: "/api/media/mf_x0.png", theme: "Bank and speed" },
      { rollupId: asks.id, line: "Stopping a grant returns its rest to the Bank", theme: "Bank and speed" },
      { rollupId: asks.id, line: "The in-tray is a one-line list" },
    ]);
    expect(doc).toMatchObject({ type: "digest", buildingId: "town-hall", state: "building", authorId: sec.id, tags: ["digest"], title: "Digest " + new Date().toISOString().slice(0, 10) + ": 1 decision, 2 rollups" });
    expect(doc.provenance.sourceIds).toEqual([quiet.id, asks.id]);
    expect(doc.body).toMatch(/^## Decisions needed\n\n\*\*Questions in words \(1\)\*\*\n\n- .*Merge PR #12\?/);
    // Shipped lines grouped under the run's themes in first-use order, unthemed ones last under Other
    expect(doc.body).toMatch(/## Shipped since last digest\n\n\*\*Bank and speed\*\*\n\n- The banner shows today's spend !\[\]\(\/api\/media\/mf_x0\.png\) \(dc_\w+\)\n- Stopping a grant returns its rest to the Bank \(dc_\w+\)\n\n\*\*Other\*\*\n\n- The in-tray is a one-line list \(dc_/);
    expect(world.docs.require(quiet.id).decision).toBe("approve");
    expect(world.docs.require(asks.id).decision).toBe("pending");
    // the next run has nothing new
    expect(digestInputs(world, new Date(Date.now() + 25 * H)).idle).toMatch(/no new rollup/);
  });
});

describe("the digest card in the in-tray and the deck (step 3)", () => {
  it("digestCard: the latest card, its decisions read live, its Shipped lines, the covered rollups with which still ask a call; slide 2 of the deck", () => {
    const { world, sec, rollup, proposal } = setup();
    expect(digestCard(world)).toBeNull();
    expect(reviewDeck(world).slides.some((s) => s.kind === "digest")).toBe(false);
    const quiet = rollup(["None"]);
    const asks = rollup(["Merge PR #12?"]);
    const doc = fileDigest(world, sec, [{ rollupId: quiet.id, line: "The banner shows today's spend", picture: "/api/media/mf_x0.png" }]);
    const g = proposal("A banner with today's spend", 300_000);
    const c = digestCard(world)!;
    expect(c.doc.id).toBe(doc.id);
    // filed before the proposal, read live: the proposal is a decision line now
    expect(c.decisions[0]).toMatchObject({ heading: "Money (1)", lines: [expect.stringMatching(new RegExp(`^Fund ${g.id} `))] });
    expect(c.shipped).toBe(`- The banner shows today's spend ![](/api/media/mf_x0.png) (${quiet.id})`);
    expect(c.covered.map((r) => [r.id, r.pending])).toEqual([[quiet.id, false], [asks.id, true]]);
    // the archived rollup left the in-tray's reports; the one with a real call stays
    const ids = townHallIntray(world).reports.map((d) => d.id);
    expect(ids).not.toContain(quiet.id);
    expect(ids).toContain(asks.id);
    const slides = reviewDeck(world).slides;
    expect(slides.map((s) => s.kind).slice(0, 2)).toEqual(["town", "digest"]);
    expect(slides[1]).toMatchObject({ key: `digest:${doc.id}`, itemId: null, pictures: [{ alt: "", src: "/api/media/mf_x0.png" }] });
    expect(slides[1]!.text).toMatch(/### Decisions needed\n\n\*\*Money \(1\)\*\*\n\n- Fund gr_\w+ .*\n\n\*\*Questions in words \(1\)\*\*\n\n- .*Merge PR #12\?/);
    expect(slides[1]!.text).toContain(`still asks a call`);
  });

  it("a decision made in a 1:1 reads \"<Human> via Secretary in mt_…\" on the deck's history line, with the human's words", () => {
    const { world, sec, admin } = setup();
    const human = world.holderOf(admin);
    const at = new Date(Date.now() - 60_000).toISOString();
    const g = { history: [{ at, byId: human.id, byKind: "user", action: "fund", tokens: 600_000, note: `by ${world.nameOf(human.id)} via Secretary in mt_abc: "fund it at 600k"`, viaAgentId: sec.id, viaMeetingId: "mt_abc" }] } as never;
    expect(grantHistoryLine(world, g, new Date())).toBe(`${world.nameOf(human.id)} via Secretary in mt_abc funded 1 min ago: "fund it at 600k"`);
  });
});
