/**
 * Retainers (1:1 mt_cyd2t5ioob decision 2): a recurring scheduled job runs on standing money a human approves in the Town
 * Hall in-tray, claimed in the Bank; never on a grant. Claim math, asks and re-asks, held runs, booking against the
 * schedule, the per-run wrap-up, release on end, the lane refusals and the operating-reserve 409.
 */
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, decideRetainer, fireSchedules, freeTokens, intrayCount, intrayRoutes, reviewDeck, scheduleView, townHallIntray, updateBuilding } from "../src/index.ts";
import { laneHold } from "../src/lanes.ts";
import { runsLeft } from "../src/retainers.ts";
import { newId, nowIso } from "../src/util.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const H = 3_600_000;

function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Clockwork", headcount: 3, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix", sprite: 5 });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world, 1_000_000);
  const me = () => world.agents.require(pix.id);
  const th = world.buildings.first("kind = 'town-hall'")!;
  /** an every-6-h job for 30 h from t0 + 1 h: runs at +1, +7, +13, +19, +25 h = 5 runs */
  const sixHourly = async (t0: number, tokensPerRun = 3_000) => (await world.verbs.schedule(me(), { title: "Sweep", description: "d", runsAt: new Date(t0 + H).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * H).toISOString() }, tokensPerRun })).scheduleId as string;
  /** book `output` Opus output tokens (= Bank tokens) on an assignment's session */
  const spend = (assignmentId: string, output: number) => world.sessions.upsert({
    id: newId("se"), agentId: pix.id, assignmentId, meetingId: null, purpose: "work", backend: "host", status: "done", model: "claude-opus-5-5", bankModel: "claude-opus-5-5",
    sdkSessionId: null, output, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "retainer", grantId: null,
  });
  return { ...s, b, pix, me, th, sixHourly, spend };
}

describe("retainers", () => {
  it("runs left: an interval counts its steps to the end, daily times count per day, `times` caps it, a one-shot is 1, ended 0", () => {
    const base = { status: "active" as const, nextRunAt: "2026-11-01T01:00:00.000Z", endsAt: "2026-11-02T06:00:00.000Z", maxRuns: null, runs: 0, paused: false };
    expect(runsLeft({ ...base, everyMinutes: 360, dailyAt: null })).toBe(5); // 01, 07, 13, 19, 01 next day
    expect(runsLeft({ ...base, everyMinutes: null, dailyAt: ["01:00", "19:00"] })).toBe(3); // 01, 19, 01
    expect(runsLeft({ ...base, everyMinutes: 360, dailyAt: null, maxRuns: 4, runs: 2 })).toBe(2);
    expect(runsLeft({ ...base, everyMinutes: null, dailyAt: null, endsAt: null })).toBe(1);
    expect(runsLeft({ ...base, everyMinutes: 360, dailyAt: null, status: "ended" })).toBe(0);
  });

  it("asks on creation: a Town Hall in-tray row and its own deck slide; runs are held until a human approves", async () => {
    const { world, sixHourly, th, admin } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    const v = scheduleView(world, world.schedules.require(id));
    expect(v).toMatchObject({ lane: "retainer", retainer: "asked", tokensPerRun: 3_000, runsLeft: 5, askTokens: 15_000, drawnTokens: 0, claimTokens: 0 });
    const intray = townHallIntray(world);
    expect(intray.retainers.map((x) => x.id)).toEqual([id]);
    expect(intrayCount(world, th.id)).toBeGreaterThanOrEqual(1);
    expect(intrayRoutes(world, admin, intray).routes[id]).toMatchObject({ canDecide: true });
    const slide = reviewDeck(world).slides.find((s) => s.kind === "retainer");
    expect(slide?.title).toMatch(/Retainer: Clockwork asks/);
    expect(slide?.text).toMatch(/3,000 tokens × 5 runs/);
    expect(world.events.list({ types: ["retainer.asked"] })).toHaveLength(1);
    // the fire creates the run in lane retainer with the schedule as its source, held while asked
    const a = fireSchedules(world, new Date(t0 + 2 * H)).fired[0]!;
    expect(a).toMatchObject({ lane: "retainer", sourceId: id, grantId: null });
    expect(laneHold(world, a)).toMatch(/retainer not approved/);
    // asked retainers don't claim the Bank
    expect(freeTokens(world, "gl_town")).toMatchObject({ retainerTokens: 0, retainerJobs: 0 });
  });

  it("approve: claimed in the Bank (tokensPerRun × runs left), runs start, sessions book against the schedule, held past the total", async () => {
    const { world, sixHourly, admin, pix, spend } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    const before = freeTokens(world, "gl_town").freeTokens;
    const v = decideRetainer(world, admin, id, { action: "approve", note: "" }, new Date(t0));
    expect(v).toMatchObject({ retainer: "funded", retainerTokens: 15_000, claimTokens: 15_000 });
    expect(freeTokens(world, "gl_town")).toMatchObject({ retainerTokens: 15_000, retainerJobs: 1, freeTokens: before - 15_000 });
    // the manager hears back in their inbox
    expect(world.messages.where("toId = ?", [pix.id]).some((m) => /approved the retainer/.test(m.body))).toBe(true);
    const a = fireSchedules(world, new Date(t0 + 2 * H)).fired[0]!;
    expect(laneHold(world, a)).toBeNull();
    // a run books against the schedule (drawn), never a grant
    spend(a.id, 2_500);
    world.assignments.patch(a.id, { status: "done" });
    const after = scheduleView(world, world.schedules.require(id), new Date(t0 + 2 * H));
    expect(after).toMatchObject({ drawnTokens: 2_500, runsLeft: 4 });
    expect(after.claimTokens).toBe(12_000); // min(3,000 × 4, 15,000 − 2,500)
    // a big overspend: the next run would pass the approved total, so it is held
    spend(a.id, 10_000);
    const b = fireSchedules(world, new Date(t0 + 8 * H)).fired[0]!;
    expect(laneHold(world, b)).toMatch(/retainer spent/);
  });

  it("a run that reaches tokensPerRun is asked once to wrap up", async () => {
    const { world, sixHourly, admin, spend } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    decideRetainer(world, admin, id, { action: "approve", note: "" }, new Date(t0));
    const a = fireSchedules(world, new Date(t0 + 2 * H)).fired[0]!;
    world.assignments.patch(a.id, { status: "active" });
    spend(a.id, 3_100);
    fireSchedules(world, new Date(t0 + 3 * H));
    fireSchedules(world, new Date(t0 + 4 * H));
    const asked = world.events.list({ types: ["system"] }).filter((e) => (e.payload as { retainerCeiling?: string }).retainerCeiling === a.id);
    expect(asked).toHaveLength(1);
  });

  it("cancelling releases the unspent claim (event); the last run ends it too", async () => {
    const { world, sixHourly, admin, me } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    decideRetainer(world, admin, id, { action: "approve", note: "" }, new Date(t0));
    await world.verbs.cancel(me(), { scheduleId: id });
    expect(world.schedules.require(id)).toMatchObject({ status: "ended", retainer: "ended" });
    expect(world.events.list({ types: ["retainer.released"] })[0]?.payload).toMatchObject({ scheduleId: id, releasedTokens: 15_000 });
    expect(freeTokens(world, "gl_town").retainerTokens).toBe(0);
    // a one-shot retainer ends after its run
    const one = (await world.verbs.schedule(me(), { title: "Once", description: "d", runsAt: new Date(t0 + H).toISOString(), tokensPerRun: 1_000 })).scheduleId as string;
    decideRetainer(world, admin, one, { action: "approve", note: "" }, new Date(t0));
    fireSchedules(world, new Date(t0 + 2 * H));
    expect(world.schedules.require(one)).toMatchObject({ status: "ended", retainer: "ended" });
  });

  it("raising tokensPerRun or extending the end asks again; lowering or shortening keeps it funded", async () => {
    const { world, sixHourly, admin, me } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    decideRetainer(world, admin, id, { action: "approve", note: "" });
    await world.verbs.schedule(me(), { scheduleId: id, tokensPerRun: 2_000 });
    expect(world.schedules.require(id).retainer).toBe("funded");
    await world.verbs.schedule(me(), { scheduleId: id, tokensPerRun: 4_000 });
    expect(world.schedules.require(id).retainer).toBe("asked");
    decideRetainer(world, admin, id, { action: "approve", note: "" });
    await world.verbs.schedule(me(), { scheduleId: id, repeat: { everyHours: 6, until: new Date(t0 + 60 * H).toISOString() } });
    expect(world.schedules.require(id).retainer).toBe("asked");
    expect(world.events.list({ types: ["retainer.asked"] })).toHaveLength(3);
  });

  it("counter waits on the manager, whose edit asks again; reject holds the runs", async () => {
    const { world, sixHourly, admin, me, pix } = lab();
    const t0 = Date.now();
    const id = await sixHourly(t0);
    expect(() => decideRetainer(world, admin, id, { action: "counter", note: "" })).toThrow(/says what to change/);
    decideRetainer(world, admin, id, { action: "counter", note: "too much", tokensPerRun: 1_500 });
    expect(world.schedules.require(id)).toMatchObject({ retainer: "countered", retainerNote: "Counter: 1,500 tokens per run. too much" });
    expect(world.messages.where("toId = ?", [pix.id]).some((m) => /countered the retainer/.test(m.body))).toBe(true);
    expect(() => decideRetainer(world, admin, id, { action: "approve", note: "" })).toThrow(/waits on the manager/);
    await world.verbs.schedule(me(), { scheduleId: id, tokensPerRun: 1_500 });
    expect(world.schedules.require(id).retainer).toBe("asked");
    decideRetainer(world, admin, id, { action: "reject", note: "not now" });
    expect(world.schedules.require(id).retainer).toBe("rejected");
    // only a human decides
    expect(() => decideRetainer(world, me(), id, { action: "approve", note: "" })).toThrow();
  });

  it("approving refuses (409) when the ask would dip into the operating reserve", async () => {
    const { world, sixHourly, admin } = lab();
    const id = await sixHourly(Date.now(), 100_000); // 500,000 asked
    world.town.set({ operatingReserveTokens: 600_000 });
    expect(() => decideRetainer(world, admin, id, { action: "approve", note: "" })).toThrow(/operating reserve/);
    world.town.set({ operatingReserveTokens: 0 });
    expect(decideRetainer(world, admin, id, { action: "approve", note: "" }).retainer).toBe("funded");
  });

  it("lanes: a schedule is never lane grant; an agent's repeating job needs tokensPerRun; nobody assigns lane retainer by hand", async () => {
    const { world, me, b, admin } = lab();
    const g = world.grantDesk.propose(admin, world.grantDesk.create(admin, b.id, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", stopCondition: "s", askTokens: 1000 }).id);
    const repeat = { everyHours: 6 };
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", lane: "grant", grantId: g.id, repeat })).rejects.toThrow(/can't draw on a grant/);
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", gap: "g", repeat })).rejects.toThrow(/retainer a human approves/);
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", gap: "g", repeat, tokensPerRun: 10, lane: "exploration" })).rejects.toThrow(/makes the schedule a retainer/);
    await expect(world.verbs.assign(me(), { title: "x", description: "d", lane: "retainer", sourceId: "sc_x" })).rejects.toThrow(/belongs to a schedule's runs/);
  });
});
