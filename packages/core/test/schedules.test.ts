/** Building schedules (Mitchell, 1:1 mt_w7z9k1z112): a timed job lives on its building; whoever is around when it fires takes it. */
import { describe, expect, it } from "vitest";
import { createBuilding, createResident, fireSchedules, nextOccurrence, teamBlock, updateBuilding } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const H = 3_600_000;

/** A lab with a manager Pix and a resident Ann (forks off unless `forks: true`). */
function lab(opts: { forks?: boolean } = {}) {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Clockwork", headcount: 3, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  world.grantDesk.createKeyResult(s.admin, b.id, { text: "Schedules work", howToCheck: "Run the tests" });
  const pix = createResident(world, { buildingId: b.id, name: "Pix", sprite: 5 });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  world.buildings.upsert({ ...world.buildings.require(b.id), explorationTokensPerDay: 10_000_000 });
  if (opts.forks) world.ops.updateBuilding(null, b.id, { forks: true });
  const me = () => world.agents.require(pix.id);
  const made = (bid = b.id) => world.assignments.where("buildingId = ?", [bid]);
  return { ...s, b, pix: me(), ann, me, made };
}

describe("schedules", () => {
  it("nextOccurrence: interval steps from its anchor; daily times wrap to tomorrow; one-shot has none", () => {
    const at = new Date("2026-10-29T21:30:00Z");
    expect(nextOccurrence({ everyMinutes: 360, dailyAt: null }, at, new Date("2026-10-29T08:00:00Z"))?.toISOString()).toBe("2026-10-30T02:00:00.000Z");
    expect(nextOccurrence({ everyMinutes: null, dailyAt: ["08:00", "20:00"] }, at)?.toISOString()).toBe("2026-10-30T08:00:00.000Z");
    expect(nextOccurrence({ everyMinutes: null, dailyAt: ["22:00"] }, at)?.toISOString()).toBe("2026-10-29T22:00:00.000Z");
    expect(nextOccurrence({ everyMinutes: null, dailyAt: null }, at)).toBeNull();
  });

  it("forks on: nothing exists before it fires; then one assignment on the building queue with the lane and pages; a one-shot ends", async () => {
    const { world, b, pix, me, made } = lab({ forks: true });
    const runsAt = new Date(Date.now() + 2 * H).toISOString();
    const r = await world.verbs.schedule(me(), { title: "Check the rollup", description: "look at it", runsAt, gap: "rollup check" });
    expect(r).toMatchObject({ nextRunAt: runsAt, repeat: "once", lane: "exploration" });
    expect(made()).toEqual([]);
    expect(fireSchedules(world, new Date(Date.now() + H)).fired).toEqual([]);
    const { fired } = fireSchedules(world, new Date(Date.now() + 3 * H));
    expect(fired.map((a) => [a.title, a.agentId, a.queue, a.lane, a.gap, a.createdBy])).toEqual([["Check the rollup", pix.id, "building", "exploration", "rollup check", r.scheduleId]]);
    expect(world.schedules.require(r.scheduleId)).toMatchObject({ status: "ended", endedReason: "ran", runs: 1, lastAssignmentId: fired[0]!.id, nextRunAt: null });
    expect(fireSchedules(world, new Date(Date.now() + 5 * H)).fired).toEqual([]);
    expect(made(b.id)).toHaveLength(1);
  });

  it("forks off: an idle resident takes it, else the manager", async () => {
    const { world, pix, ann, me } = lab();
    await world.verbs.schedule(me(), { title: "A", description: "d", runsAt: new Date(Date.now() + H).toISOString(), gap: "g" });
    expect(fireSchedules(world, new Date(Date.now() + 2 * H)).fired.map((a) => [a.agentId, a.queue])).toEqual([[ann.id, "agent"]]);
    world.agents.upsert({ ...world.agents.require(ann.id), status: "working" });
    await world.verbs.schedule(me(), { title: "B", description: "d", runsAt: new Date(Date.now() + H).toISOString(), gap: "g" });
    expect(fireSchedules(world, new Date(Date.now() + 2 * H)).fired.map((a) => a.agentId)).toEqual([pix.id]);
  });

  it("a repeat: next run after each fire, missed runs collapse into one, skipped while the last is queued, ends past its end", async () => {
    const { world, me, made } = lab({ forks: true });
    const t0 = Date.now();
    const r = await world.verbs.schedule(me(), { title: "Every 6 h", description: "d", runsAt: new Date(t0 + H).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * H).toISOString() }, gap: "g" });
    expect(r.repeat).toBe("every 6 h");
    // down for 14 h: one fire, the next run is the next step after now
    const f1 = fireSchedules(world, new Date(t0 + 15 * H)).fired;
    expect(f1).toHaveLength(1);
    expect(world.schedules.require(r.scheduleId).nextRunAt).toBe(new Date(t0 + 19 * H).toISOString());
    // its assignment is still queued: the next run is skipped, not piled up
    expect(fireSchedules(world, new Date(t0 + 19.5 * H)).fired).toEqual([]);
    expect(world.schedules.require(r.scheduleId)).toMatchObject({ runs: 1, nextRunAt: new Date(t0 + 25 * H).toISOString() });
    world.assignments.patch(f1[0]!.id, { status: "done" });
    expect(fireSchedules(world, new Date(t0 + 25 * H)).fired).toHaveLength(1);
    // next would be t0+31h, past `until`: it ends
    expect(world.schedules.require(r.scheduleId)).toMatchObject({ status: "ended", endedReason: "past its end", runs: 2 });
    expect(made()).toHaveLength(2);
  });

  it("validation: assign waitFor {after} points to schedule; cancel scheduleId stops it; the team block lists active ones", async () => {
    const { world, b, me, made } = lab({ forks: true });
    await expect(world.verbs.assign(me(), { title: "x", description: "d", gap: "g", waitFor: { after: new Date(Date.now() + H).toISOString() } })).rejects.toThrow(/use `schedule`/);
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", gap: "g" })).rejects.toThrow(/runsAt/);
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", gap: "g", runsAt: new Date(Date.now() + 100 * 24 * H).toISOString() })).rejects.toThrow(/90 days/);
    await expect(world.verbs.schedule(me(), { title: "x", description: "d", gap: "g", repeat: { everyHours: 2, dailyAt: ["08:00"] } })).rejects.toThrow(/not both/);
    const r = await world.verbs.schedule(me(), { title: "Nightly check", description: "d", gap: "g", repeat: { dailyAt: ["20:00"] } });
    expect(world.schedules.require(r.scheduleId).endsAt).toBeTruthy();
    expect(teamBlock(world, world.buildings.require(b.id), me().id)).toContain(`${r.scheduleId} "Nightly check"`);
    await expect(world.verbs.cancel(me(), { scheduleId: r.scheduleId })).resolves.toMatchObject({ status: "ended" });
    expect(world.schedules.require(r.scheduleId).endedReason).toBe("cancelled by Pix");
    expect(fireSchedules(world, new Date(Date.now() + 48 * H)).fired).toEqual([]);
    expect(made(b.id)).toEqual([]);
  });

  it("a lane that no longer holds ends the schedule with a town-written report in the in-tray", async () => {
    const { world, b, me, made } = lab({ forks: true });
    const kr = world.keyResults.first("buildingId = ?", [b.id])!;
    const r = await world.verbs.schedule(me(), { title: "Explore it", description: "d", keyResultId: kr.id, runsAt: new Date(Date.now() + H).toISOString() });
    world.keyResults.upsert({ ...kr, buildingId: "elsewhere" });
    expect(fireSchedules(world, new Date(Date.now() + 2 * H)).fired).toEqual([]);
    expect(world.schedules.require(r.scheduleId).endedReason).toMatch(/lane no longer holds/);
    expect(world.docs.first("type = 'report' AND buildingId = ? AND tags LIKE '%schedule-ended%'", [b.id])?.title).toBe("Schedule ended: Explore it");
    expect(made()).toEqual([]);
  });
});
