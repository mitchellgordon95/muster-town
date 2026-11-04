/**
 * The Secretary (gr_kdlogzzo5s step 2, design dc_8gbluwrdgi §1-2): a Town Hall resident that takes its own daily digest
 * schedule (`takerId`), the digest builder's yes/no "Decisions needed" lines from the deck's data, the skip when no new
 * rollup arrived, and filing the card (doc type digest, covered rollups in provenance, the ones that ask nothing archived).
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createDoc, createOneOnOne, createResident, createSchedule, fireSchedules, nowIso } from "../src/index.ts";
import { DIGEST_TOKENS_PER_RUN, digestDecisions, digestIdleReason, digestInputs, fileDigest } from "../src/secretary.ts";
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

  it("Decisions needed: yes/no lines from the deck's data (checkpoint with top-up, proposal at its ask, retainer ask, rollup call), outbox as Asked of you", () => {
    const { world, admin, proposal, rollup, manager } = setup();
    const p = proposal("Banner shows Usage", 350_000);
    const held = proposal("Stop a grant cleanly", 600_000);
    world.grantDesk.decide(admin, held.id, { action: "fund", tokens: 600_000 });
    world.grants.patch(held.id, { status: "checkpoint", spentTokens: 410_000, topUpTokens: 200_000, whatTopUpBuys: "the web step" } as never);
    world.secretary.ensureDigestSchedule();
    rollup(["Merge PR #12?", "None"]);
    createDoc(world, { type: "request", title: "Photograph the sign", body: "x", authorId: manager.id, authorKind: "agent", state: "building", requestStatus: "open" });
    const { decisions, askedOfYou } = digestDecisions(world);
    expect(decisions[0]).toMatch(new RegExp(`^Continue ${held.id} \\(Carbon.*"Stop a grant cleanly"\\) with a 200k top-up \\(spent \\d+k? of 600k; a top-up buys: the web step\\)\\?$`));
    expect(decisions).toContain(`Fund ${p.id} (${world.buildings.require(LAB).name}: "Banner shows Usage") at its 350k ask?`);
    expect(decisions.some((l) => /^Approve Town Hall's retainer "Daily in-tray digest" \(sc_\w+\): 10k per run, \d+k in all\?$/.test(l))).toBe(true);
    expect(decisions.some((l) => /asks \(dc_\w+, "Item 1"\): Merge PR #12\?$/.test(l))).toBe(true);
    expect(decisions.some((l) => /Item 2/.test(l))).toBe(false); // a None call is no decision
    expect(askedOfYou).toBe('Asked of you: 1 outbox request ("Photograph the sign").');
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
    const doc = fileDigest(world, sec, [
      { rollupId: quiet.id, line: "The banner shows today's spend", picture: "/api/media/mf_x0.png" },
      { rollupId: asks.id, line: "Stopping a grant returns its rest to the Bank" },
    ]);
    expect(doc).toMatchObject({ type: "digest", buildingId: "town-hall", state: "building", authorId: sec.id, tags: ["digest"] });
    expect(doc.provenance.sourceIds).toEqual([quiet.id, asks.id]);
    expect(doc.body).toMatch(/^## Decisions needed\n\n- .*Merge PR #12\?/);
    expect(doc.body).toMatch(/## Shipped since last digest\n\n- The banner shows today's spend !\[\]\(\/api\/media\/mf_x0\.png\) \(dc_/);
    expect(world.docs.require(quiet.id).decision).toBe("approve");
    expect(world.docs.require(asks.id).decision).toBe("pending");
    // the next run has nothing new
    expect(digestInputs(world, new Date(Date.now() + 25 * H)).idle).toMatch(/no new rollup/);
  });
});
