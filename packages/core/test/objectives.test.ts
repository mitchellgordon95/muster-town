import { describe, expect, it } from "vitest";
import { buildingRoleId, keyResultsBlock, quarterOf } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KR = { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" };

/** Mei manages the lab (goal-directed); a published meeting-notes doc is what objectives and KRs come from. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const notes = world.docs.upsert({ ...world.docs.first("1 = 1")!, id: "dc_notes1", type: "meeting-notes", state: "building", buildingId: LAB, title: "1:1 notes", body: "objectives" });
  return { ...s, mei, noor, notes };
}

describe("objectives (1:1 mt_akz25kqo2q)", () => {
  it("the manager writes up to 3 objectives naming a KPI; KRs hang off one (at most 4); existing KRs stay Unsorted", async () => {
    const { world, mei, noor, admin, notes } = setup();
    const grant = (krs: { text: string; howToCheck: string }[], goalId?: string) => world.grantDesk.create(mei, LAB, { goalId, keyResults: krs, objective: "o", stopCondition: "s", askTokens: 1000 });
    const old = world.keyResults.require(grant([KR]).keyResultId!);
    expect(old.objectiveId).toBeNull();
    const r = await world.verbs.set_objective(mei, { text: "Funders see what every token bought", kpi: "trust", sourceDocIds: [notes.id] });
    expect(r.objective).toMatchObject({ kpi: "trust", kpiName: "Trust", horizon: quarterOf(), createdBy: mei.id, keyResults: [] });
    expect(r.unsorted).toEqual([old.id]);
    await expect(world.verbs.set_objective(mei, { text: "x", kpi: "fund" })).rejects.toThrow(/sourceDocIds/);
    await expect(world.verbs.set_objective(noor, { text: "x", kpi: "fund", sourceDocIds: [notes.id] })).rejects.toThrow(/manager writes its goal's objectives/);
    // move the old KR under it, then fill it to 4
    world.grantDesk.updateKeyResult(mei, old.id, { objectiveId: r.objective.id });
    const more = grant([0, 1, 2, 3].map((i) => ({ ...KR, text: `kr ${i}` }))).keyResults;
    for (const k of more.slice(0, 3)) world.grantDesk.updateKeyResult(mei, k.id, { objectiveId: r.objective.id });
    expect(() => world.grantDesk.updateKeyResult(mei, more[3]!.id, { objectiveId: r.objective.id })).toThrow(/at most 4/);
    const tree = world.grantDesk.objectiveTree(LAB);
    expect(tree.objectives[0]!.keyResults.map((k) => k.id)[0]).toBe(old.id);
    expect(tree.unsorted.map((k) => k.id)).toEqual([more[3]!.id]);
    // the move is an event a human can see; a move back to Unsorted works
    const ev = world.events.list({ types: ["kr.updated"], buildingId: LAB }).find((e) => e.payload.keyResultId === old.id)!;
    expect(ev.payload).toMatchObject({ objectiveId: r.objective.id, fromObjectiveId: null, edited: false });
    world.grantDesk.updateKeyResult(mei, old.id, { objectiveId: null });
    expect(world.keyResults.require(old.id).objectiveId).toBeNull();
    // at most 3 objectives
    await world.verbs.set_objective(mei, { text: "o2", kpi: "join", sourceDocIds: [notes.id] });
    await world.verbs.set_objective(mei, { text: "o3", kpi: "fund", sourceDocIds: [notes.id] });
    await expect(world.verbs.set_objective(mei, { text: "o4", kpi: "fund", sourceDocIds: [notes.id] })).rejects.toThrow(/at most 3/);
    // edit; delete is human-only and refused while KRs hang off it
    const ed = await world.verbs.set_objective(mei, { id: r.objective.id, kpi: "fund", horizon: "2027-Q1" });
    expect(ed.objective).toMatchObject({ kpi: "fund", horizon: "2027-Q1", editedBy: mei.id });
    expect(() => world.grantDesk.deleteObjective(mei, r.objective.id)).toThrow(/Only a human/);
    expect(() => world.grantDesk.deleteObjective(admin, r.objective.id)).toThrow(/move them first/);
  });

  it("the desk brief lists the building's subtree: each goal (objectives are goals) with its open key results", async () => {
    const { world, mei, admin, notes } = setup();
    const propose = (text: string, goalId?: string) => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { goalId, keyResults: [{ ...KR, text }], objective: `Plan: ${text}`, stopCondition: "s", askTokens: 1000 }).id);
    const loose = propose("Loose one");
    const o = world.grantDesk.createObjective(mei, LAB, { text: "Strangers can join", kpi: "join", horizon: "2026-Q4", sourceDocIds: [notes.id] });
    const g = propose(KR.text, o.id);
    const block = keyResultsBlock(world, world.buildings.require(LAB));
    expect(block).toContain("Attached to: ");
    expect(block).toMatch(new RegExp(`  Goal ${o.id}: Strangers can join\n    - grant ${g.id} [^\n]*\n        - ${g.keyResultId} \\[not-started\\] A visitor can see`));
    expect(block).toMatch(new RegExp(`Goal gl_town: [^\n]*\n  - grant ${loose.id} [^\n]*\n      - ${loose.keyResultId} \\[not-started\\] Loose one`));
  });
});
