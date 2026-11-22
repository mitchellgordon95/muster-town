/**
 * The Secretary (gr_kdlogzzo5s step 2, design dc_8gbluwrdgi §1-2; legible delegation step 5): a Town Hall resident on
 * Fable that takes its own daily ranking schedule (`takerId`), skips the run when nothing changed since its last
 * ranking, and runs once more when a human presses "Rank now". The ranking itself is secretary-rank.test.ts.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createOneOnOne, createResident, createSchedule, fireSchedules, grantHistoryLine } from "../src/index.ts";
import { decideRetainer, runCapOf, watchRunCaps } from "../src/retainers.ts";
import { jobOf } from "../src/jobs.ts";
import { newId, nowIso } from "../src/util.ts";
import { ruleBlock } from "../src/lanes.ts";
import { applyRank, pressRank, RANK_TOKENS_PER_RUN, rankNothingNew, rankRunView, SECRETARY_MODEL } from "../src/secretary.ts";
import { askAt, creditBank, legacyRankSchedule, seededWorld, renderNeeds } from "./helpers.ts";

const LAB = "carbon-cycle";
const H = 3_600_000;

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const th = world.buildings.first("kind = 'town-hall'")!;
  const propose = (objective: string, askTokens: number) => askAt(world, world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective, approach: "a banner line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens,
  }).id), askTokens);
  // the manager renders each proposal's need as its ask (1:1 mt_t65exni4et)
  const proposal = (objective: string, askTokens: number) => { const g = propose(objective, askTokens); renderNeeds(world, manager.id); return g; };
  return { ...s, world, manager, sec, th, proposal };
}

describe("the Secretary", () => {
  it("is the Town Hall's manager (1:1 mt_db6itzy2br): it may assign and schedule there, never fund; the Planner doesn't take the seat back", () => {
    const { world, sec, th } = setup();
    expect(world.buildings.require(th.id).managerAgentId).toBe(sec.id);
    expect(world.permissions.can(sec, "building.assign", th.id)).toBe(true);
    expect(world.permissions.can(sec, "building.fund", th.id)).toBe(false);
    const planner = world.reorgs.ensurePlanner();
    expect(planner.id).not.toBe(sec.id);
    expect(world.buildings.require(th.id).managerAgentId).toBe(sec.id);
    expect(world.permissions.can(planner, "building.assign", th.id)).toBe(false);
    // a Town Hall schedule taken by the Secretary
    expect(createSchedule(world, th.id, world.holderOf(sec), { title: "x", description: "d", runsAt: new Date(Date.now() + H).toISOString(), takerId: sec.id }).takerId).toBe(sec.id);
  });

  it("is a Town Hall resident beside the Planner, made once, on Fable; a human opens a 1:1 with it at the Town Hall", () => {
    const { world, sec, th, admin, proposal } = setup();
    expect(sec).toMatchObject({ kind: "resident", title: "Secretary", homeBuildingId: th.id, model: SECRETARY_MODEL });
    expect(SECRETARY_MODEL).toBe("claude-fable-5-1");
    // an existing Secretary on another model moves to Fable
    world.agents.patch(sec.id, { model: th.cheapModel });
    expect(world.secretary.ensure()!).toMatchObject({ id: sec.id, model: SECRETARY_MODEL });
    expect(world.buildings.require(th.id).managerAgentId).toBe(sec.id);
    proposal("Banner shows Usage", 350_000);
    const m = createOneOnOne(world, admin, th.id, { agentId: sec.id });
    expect(m).toMatchObject({ kind: "one-on-one", facilitatorId: sec.id });
    expect(world.secretary.brief(m)).toMatch(/act_in_1on1` if available/);
    expect(world.secretary.brief(m)).toMatch(new RegExp(`Open asks now, in rank order:\\n- ak_\\w+ \\(money, #1\\): Fund "Banner shows Usage" at `));
    // the human's recent lines carry their exact ISO `at` (act_in_1on1 cites one by it)
    const said = world.meetings.patch(m.id, { transcript: [...m.transcript, { speakerId: world.holderOf(admin).id, speakerKind: "user", text: "fund gr_x at 600k", at: new Date().toISOString() } as never] });
    expect(world.secretary.brief(said)).toMatch(new RegExp(`at ${said.transcript.at(-1)!.at.replace(/[.]/g, "\\.")}: "fund gr_x at 600k"`));
    // without agentId the Town Hall still opens the Planner
    expect(createOneOnOne(world, admin, th.id).facilitatorId).toBe(world.reorgs.planner()!.id);
  });

  it("takerId: a Town Hall schedule needs a resident taker; the ranking schedule asks its retainer, runs on Fable, and fires to the Secretary's own queue", () => {
    const { world, sec, th, admin, proposal } = setup();
    expect(() => createSchedule(world, th.id, world.holderOf(admin), { title: "x", description: "d", runsAt: new Date(Date.now() + H).toISOString() })).toThrow(/takerId/);
    const other = createResident(world, { buildingId: LAB, name: "Ivy" });
    expect(() => createSchedule(world, th.id, world.holderOf(admin), { title: "x", description: "d", runsAt: new Date(Date.now() + H).toISOString(), takerId: other.id })).toThrow(/isn't a resident of/);
    const t0 = new Date("2030-01-01T06:00:00.000Z");
    // the town makes no ranking schedule any more (grant gr_mcuj10tupi); a live old one is kept in step until it ends
    expect(world.secretary.ensureRankSchedule(t0)).toBeNull();
    expect(world.schedules.count("takerId = ? AND title = 'Daily ask ranking'", [sec.id])).toBe(0);
    const s = legacyRankSchedule(world, t0);
    expect(s).toMatchObject({ buildingId: th.id, takerId: sec.id, title: "Daily ask ranking", lane: "retainer", retainer: "asked", tokensPerRun: RANK_TOKENS_PER_RUN, model: SECRETARY_MODEL, dailyAt: ["07:00"] });
    expect(s.description).toMatch(/^Rank the humans' open asks/);
    expect(s.description).toMatch(/You never fund, continue, cut, approve or decide anything yourself/);
    expect(world.secretary.ensureRankSchedule(t0)!.id).toBe(s.id);
    // the live schedule (the old daily digest) follows the code at boot: title, the run's instructions, the model
    world.schedules.patch(s.id, { title: "Daily in-tray digest", description: "old prompt", model: th.cheapModel });
    expect(world.secretary.ensureRankSchedule(t0)!).toMatchObject({ id: s.id, title: "Daily ask ranking", description: s.description, model: SECRETARY_MODEL });
    // the weekly pattern schedule is a second one, made once
    const w = world.secretary.ensurePatternSchedule(t0)!;
    expect(w).toMatchObject({ takerId: sec.id, title: "Weekly pattern note", everyMinutes: 7 * 24 * 60, model: SECRETARY_MODEL, retainer: "asked" });
    expect(world.secretary.ensurePatternSchedule(t0)!.id).toBe(w.id);
    expect(world.secretary.ensureRankSchedule(t0)!.id).toBe(s.id);
    proposal("Banner shows Usage", 350_000);
    const { fired } = fireSchedules(world, new Date("2030-01-01T07:00:30.000Z"));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ agentId: sec.id, queue: "agent", lane: "retainer", sourceId: s.id, model: SECRETARY_MODEL });
    expect(world.budget.sessionModel(sec.id, fired[0])).toBe(SECRETARY_MODEL);
  });

  it("a live ranking schedule below RANK_TOKENS_PER_RUN is raised at boot and its retainer asked again; a human approves the new total", () => {
    const { world, admin } = setup();
    const t0 = new Date("2030-01-01T06:00:00.000Z");
    const s = legacyRankSchedule(world, t0);
    decideRetainer(world, admin, s.id, { action: "approve", note: "" });
    // the schedule as prod has it: funded at the old 10,000 per run
    world.schedules.patch(s.id, { tokensPerRun: 10_000 });
    expect(world.schedules.require(s.id).retainer).toBe("funded");
    const asksBefore = world.asks.count("targetKind = 'retainer' AND targetId = ? AND status = 'open'", [s.id]);
    const raised = world.secretary.ensureRankSchedule(t0)!;
    expect(raised).toMatchObject({ id: s.id, tokensPerRun: RANK_TOKENS_PER_RUN, retainer: "asked" });
    renderNeeds(world); // the retainer's need, rendered as its manager would (decision 7)
    expect(world.asks.count("targetKind = 'retainer' AND targetId = ? AND status = 'open'", [s.id])).toBe(asksBefore + 1);
    const ev = world.events.list({ types: ["schedule.edited"] }).at(-1)!;
    expect(ev.text).toMatch(/raised schedule "Daily ask ranking" from 10,000 to 40,000 tokens per run.*asked again/);
    expect(world.events.list({ types: ["retainer.asked"] }).at(-1)!.text).toMatch(/per-run amount raised/);
    // at the constant already: nothing changes and nothing is asked
    decideRetainer(world, admin, s.id, { action: "approve", note: "" });
    expect(world.secretary.ensureRankSchedule(t0)!).toMatchObject({ tokensPerRun: RANK_TOKENS_PER_RUN, retainer: "funded" });
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

  it("skips the run (no session) when there is no open ask, or nothing arrived since the last ranking", () => {
    const { world, sec, proposal } = setup();
    const t0 = new Date("2030-01-01T06:00:00.000Z");
    const s = legacyRankSchedule(world, t0);
    // the schedule's own retainer ask is open: rank it away first so the town has no open ask
    for (const a of world.asks.where("status = 'open'")) world.asks.upsert({ ...a, status: "retired" });
    expect(rankNothingNew(world)).toBe("no open asks");
    const { fired } = fireSchedules(world, new Date("2030-01-01T07:00:30.000Z"));
    expect(fired).toHaveLength(0);
    expect(world.events.list({ types: ["schedule.skipped"] }).at(-1)?.text).toMatch(/no open asks/);
    expect(world.schedules.require(s.id).nextRunAt).toBe("2030-01-02T07:00:00.000Z");
    proposal("Banner shows Usage", 350_000);
    expect(rankNothingNew(world)).toBeNull();
    applyRank(world, sec, { order: world.asks.where("status = 'open'").map((a) => a.id) });
    expect(rankNothingNew(world)).toMatch(/no ask arrived or changed since the last ranking/);
    proposal("A second banner", 200_000);
    expect(rankNothingNew(world)).toBeNull();
  });

  it("the decision queue's Rank now button: a human who can fund the Town Hall runs one capped ranking of its own job, with no schedule or retainer; a live run or nothing new holds it", () => {
    const { world, sec, admin, manager, proposal } = setup();
    expect(world.secretary.ensureRankSchedule()).toBeNull();
    expect(rankRunView(world, manager)).toBeNull(); // an agent never sees the button
    expect(() => pressRank(world, manager)).toThrow(/Only a human/);
    applyRank(world, sec, { order: world.asks.where("status IN ('open', 'deferred')").map((a) => a.id) });
    expect(rankRunView(world, admin)).toMatchObject({ scheduleId: null, runningId: null, refused: expect.stringMatching(/no open asks/) });
    expect(() => pressRank(world, admin)).toThrow(/Nothing to rank: no open asks/);
    proposal("Banner shows Usage", 350_000);
    expect(rankRunView(world, admin)!.refused).toBeNull();
    const a = pressRank(world, admin);
    expect(a).toMatchObject({ agentId: sec.id, buildingId: "town-hall", queue: "agent", lane: "directed", sourceId: null, model: SECRETARY_MODEL, runCapTokens: RANK_TOKENS_PER_RUN, origin: { userId: world.holderOf(admin).id } });
    expect(jobOf(a)).toMatchObject({ id: "jb_town-hall", rule: "building" });
    // the run reads the queue-health numbers after its instructions (gr_pdja05z2f1 KR kr_nsghrfza2i)
    expect(a.description).toMatch(/^Rank the humans' open asks[\s\S]*\n\n## Queue health, last 14 days/);
    expect(ruleBlock(world, a)).toBeNull(); // the Town Hall's own job is never held
    expect(world.schedules.count("takerId = ? AND title != 'Weekly pattern note'", [sec.id])).toBe(0);
    expect(rankRunView(world, admin)).toMatchObject({ runningId: a.id, refused: expect.stringMatching(/under way/) });
    expect(() => pressRank(world, admin)).toThrow(/already under way/);
  });

  it("a capped run past its runCapTokens is asked once to file, as a retainer run past its tokensPerRun", () => {
    const { world, sec, admin, proposal } = setup();
    proposal("Banner shows Usage", 350_000);
    const a = world.assignments.patch(pressRank(world, admin).id, { status: "active" });
    expect(runCapOf(a, null)).toBe(RANK_TOKENS_PER_RUN);
    expect(runCapOf({ runCapTokens: null }, 10_000)).toBe(10_000);
    expect(runCapOf({ runCapTokens: null }, null)).toBe(0);
    const capped = () => world.events.list({ types: ["system"] }).filter((e) => (e.payload as { retainerCeiling?: string }).retainerCeiling === a.id);
    const spend = (output: number) => world.sessions.upsert({
      id: newId("se"), agentId: sec.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "claude-opus-5-5", bankModel: "claude-opus-5-5",
      sdkSessionId: null, output, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "directed", grantId: null,
    });
    spend(1_000);
    watchRunCaps(world);
    expect(capped()).toHaveLength(0);
    spend(RANK_TOKENS_PER_RUN);
    watchRunCaps(world);
    watchRunCaps(world);
    expect(capped()).toHaveLength(1);
    expect(capped()[0]!.text).toMatch(/reached the cap per run of "Rank the open asks"/);
  });

  it("a decision made in a 1:1 reads \"<Human> via Secretary in mt_…\" on the deck's history line, with the human's words", () => {
    const { world, sec, admin } = setup();
    const human = world.holderOf(admin);
    const at = new Date(Date.now() - 60_000).toISOString();
    const g = { history: [{ at, byId: human.id, byKind: "user", action: "fund", tokens: 600_000, note: `by ${world.nameOf(human.id)} via Secretary in mt_abc: "fund it at 600k"`, viaAgentId: sec.id, viaMeetingId: "mt_abc" }] } as never;
    expect(grantHistoryLine(world, g, new Date())).toBe(`${world.nameOf(human.id)} via Secretary in mt_abc funded 1 min ago: "fund it at 600k"`);
  });
});
