/**
 * Build step 6 of docs/legible-delegation.md (§7.3): a grant's steps carry a size (S, M or L, no XL), a per-collective
 * table prices them, a proposal's ask is their sum (computed, never the caller's), migration 098 back-fills older steps
 * with M, and `stepCalibration` reports what steps of each size really cost over the last 30 days.
 */
import Database from "better-sqlite3";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, newId, nowIso, retireFork, stepCalibration, updateBuilding } from "../src/index.ts";
import { migrate } from "../src/db.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const step = <S extends string>(size: S, title = `A ${size} step`) => ({ size, title, description: "Do it" });

function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Sized", headcount: 3 }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  return { ...s, b, pix: world.agents.require(pix.id) };
}

describe("step sizes: S, M or L, required, priced by the table", () => {
  it("propose_grant requires a size on every step and refuses XL with the split rule", async () => {
    const { world, pix } = lab();
    const plan = (steps: unknown[]) => ({ keyResults: [KR], objective: "o", stopCondition: "s", steps } as never);
    await expect(world.verbs.propose_grant(pix, plan([{ title: "t", description: "d" }]))).rejects.toThrow(/S, M or L/);
    await expect(world.verbs.propose_grant(pix, plan([step("M"), step("XL")]))).rejects.toThrow(/larger than L must be split into two steps/);
    expect(world.grants.count("1 = 1")).toBe(0);
    // core refuses it too, whoever calls it
    expect(() => world.grantDesk.create(null, world.agents.require(pix.id).homeBuildingId!, plan([step("XL")]))).toThrow(/split/);
  });

  it("the ask is the sum of the steps' sizes from the table at propose time; a caller's askTokens is ignored", async () => {
    const { world, pix, admin } = lab();
    const r = await world.verbs.propose_grant(pix, { title: "A test grant proposal", keyResults: [KR], objective: "o", stopCondition: "s", steps: [step("S"), step("M"), step("L")], askTokens: 7 } as never);
    expect(world.grants.require(r.grantId)).toMatchObject({ askTokens: 600_000, steps: [{ size: "S" }, { size: "M" }, { size: "L" }] });
    // an admin edits the table; a re-proposal after a counter is priced at the new table
    world.setGrantPricing({ stepSizes: { S: 60_000, M: 200_000, L: 500_000 } }, admin.id);
    world.grantDesk.decide(admin, r.grantId, { action: "counter", note: "cut the L step" });
    await world.verbs.propose_grant(pix, { title: "A test grant proposal", keyResults: [KR], objective: "o", stopCondition: "s", steps: [step("S"), step("M")], askTokens: 9_000_000, grantId: r.grantId } as never);
    expect(world.grants.require(r.grantId)).toMatchObject({ status: "proposed", askTokens: 260_000 });
  });

  it("the table and oversell are seeded, shown on the town view and saved by an admin's pricing change (logged)", () => {
    const { world, admin } = lab();
    expect(world.townView()).toMatchObject({ stepSizes: { S: 50_000, M: 150_000, L: 400_000 }, oversell: 0 });
    expect(world.setGrantPricing({ oversell: 0.5 }, admin.id)).toEqual({ stepSizes: { S: 50_000, M: 150_000, L: 400_000 }, oversell: 0.5 });
    expect(world.townView()).toMatchObject({ oversell: 0.5 });
    expect(world.events.list({ types: ["system"] }).at(-1)!.text).toMatch(/Grant pricing saved: .*oversell 50% \(was 0%\)/);
  });
});

describe("calibration: spent over size per size, collective-wide and per building", () => {
  it("over the steps completed in the last 30 days: the median of spent ÷ size with the sample count", async () => {
    const { world, b, admin } = lab();
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "o", stopCondition: "s", steps: [step("M", "one"), step("M", "two"), step("M", "three"), step("L", "four")] }).id).id, { action: "fund" });
    for (const tokens of [150_000, 300_000, 450_000]) {
      const a = buildingQueue(world, b.id)[0]!;
      const { fork } = forkManager(world, b.id, a.id);
      world.assignments.patch(a.id, { status: "active" });
      world.sessions.upsert({ id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m", sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id } as never);
      await world.verbs.submit_report(fork, { title: "r", body: REPORT, verdict: "continue" });
      retireFork(world, fork.id);
    }
    const c = stepCalibration(world);
    expect(c.sizes).toEqual({ S: { ratio: null, sample: 0 }, M: { ratio: 2, sample: 3 }, L: { ratio: null, sample: 0 } });
    expect(c.buildings[b.id]!.M).toEqual({ ratio: 2, sample: 3 });
    expect(c.lines).toContain("M: 2.0× over 3 steps");
    // the next forecast prices the L step left at the table (no L sample), its spend so far at 900k over 3 M steps
    expect(world.grantDesk.get(g.id).forecast).toMatchObject({ stepsDone: 3, spent: 900_000, spentOverSize: 2, projected: 1_300_000 });
    // 31 days on, nothing is recent enough to count
    expect(stepCalibration(world, new Date(Date.now() + 31 * 86_400_000)).sizes.M).toEqual({ ratio: null, sample: 0 });
  });
});

describe("migration 098: the steps of unfunded proposals get a size", () => {
  it("back-fills the steps of draft, proposed and countered grants with size M; funded, checkpoint and closed grants keep unsized steps", () => {
    const MIGRATIONS = join(fileURLToPath(import.meta.url), "..", "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    for (const f of readdirSync(dir)) if (f >= "098") rmSync(join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const ins = db.prepare(`INSERT INTO grants (id, buildingId, objective, approach, testingPlan, stopCondition, askTokens, status, findingsDocIds, checkpointsDone, history, proposedBy, createdAt, updatedAt, steps)
      VALUES (?, 'b', 'o', '', '[]', 's', 1, ?, '[]', '[]', '[]', 'ag', '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', ?)`);
    const two = [{ title: "one", description: "d" }, { title: "two", description: "d", model: "claude-haiku-5-5" }];
    for (const status of ["draft", "proposed", "countered", "funded", "checkpoint", "closed"]) ins.run(`gr_${status}`, status, JSON.stringify(two));
    ins.run("gr_none", "proposed", "[]");
    cpSync(join(MIGRATIONS, "098_step_sizes.sql"), join(dir, "098_step_sizes.sql"));
    migrate(db, dir);
    const steps = (id: string) => JSON.parse((db.prepare("SELECT steps FROM grants WHERE id = ?").get(id) as { steps: string }).steps);
    for (const status of ["draft", "proposed", "countered"]) {
      expect(steps(`gr_${status}`)).toEqual([{ title: "one", description: "d", size: "M" }, { title: "two", description: "d", model: "claude-haiku-5-5", size: "M" }]);
    }
    for (const status of ["funded", "checkpoint", "closed"]) expect(steps(`gr_${status}`)).toEqual(two);
    expect(steps("gr_none")).toEqual([]);
  });
});
