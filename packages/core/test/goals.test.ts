import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TILE, WALKABLE } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId, createBuilding, createUser, migrate } from "../src/index.ts";
import { seededWorld, tempDir } from "./helpers.ts";

const LAB = "carbon-cycle";
const due = "2026-12-31";

/** Mei manages the lab; a published meeting-notes doc; a second lab "Other" with its own goal under the root. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const tree = world.goalTree;
  const labGoal = tree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  const otherGoal = tree.create(admin, { parentId: "gl_join", text: "A stranger finishes useful work" });
  tree.attach(admin, LAB, labGoal.id);
  const other = createBuilding(world, { name: "Other", goalId: otherGoal.id }, null);
  return { ...s, mei, tree, labGoal, otherGoal, other };
}

describe("the town goal tree (docs/goals.md, step 1)", () => {
  it("one root with Fund/Join/Trust placeholders; every building is attached, new ones at the root by default", () => {
    const { world, tree, labGoal, other, otherGoal } = setup();
    const root = tree.tree();
    expect(root.id).toBe("gl_town");
    expect(root.children.map((c) => c.id).slice(0, 3)).toEqual(["gl_fund", "gl_join", "gl_trust"]);
    expect(world.buildings.require(LAB).goalId).toBe(labGoal.id);
    expect(other.goalId).toBe(otherGoal.id);
    expect(createBuilding(world, { name: "Fresh" }, null).goalId).toBe("gl_town");
    for (const b of world.buildings.all()) expect(b.goalId).toBeTruthy();
    expect(() => createBuilding(world, { name: "Nowhere", goalId: "gl_nope" }, null)).toThrow(/not an active goal/);
  });

  it("a building is never unattached: null is refused, attach is admin/owner only and logged", () => {
    const { world, admin, mei, tree, otherGoal } = setup();
    expect(() => world.ops.updateBuilding(admin, LAB, { goalId: null as never })).toThrow();
    expect(() => tree.attach(admin, LAB, "")).toThrow(/always attached/);
    expect(() => tree.attach(mei, LAB, otherGoal.id)).toThrow(/goals.edit|Only a human/);
    world.ops.updateBuilding(admin, LAB, { goalId: otherGoal.id });
    expect(world.buildings.require(LAB).goalId).toBe(otherGoal.id);
    expect(world.events.list({ types: ["goal.attached"] }).some((e) => e.payload.goalId === otherGoal.id)).toBe(true);
  });

  it("Goals.inScope: grants and exploration name an open key result in the building's subtree", async () => {
    const { world, admin, tree, labGoal, otherGoal, other, by } = setup();
    const sub = tree.create(admin, { parentId: labGoal.id, text: "Every grant shows its sessions" });
    const mine = tree.addKeyResult(admin, sub.id, { text: "Grant panel lists sessions", howToCheck: "Open a grant", due, buildingId: LAB });
    const theirs = tree.addKeyResult(admin, otherGoal.id, { text: "First look has a brief", howToCheck: "Connect an agent", due, buildingId: other.id });
    expect(mine.due).toBe(due);
    expect(tree.inScope(LAB, mine.id)).toBe(true);
    expect(tree.inScope(LAB, theirs.id)).toBe(false);
    const plan = { objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 };
    expect(world.grantDesk.create(null, LAB, { ...plan, keyResultId: mine.id }).keyResultId).toBe(mine.id);
    expect(() => world.grantDesk.create(null, LAB, { ...plan, keyResultId: theirs.id })).toThrow(/not in Carbon Cycle Lab's subtree/);
    expect(() => world.ops.createWork(admin, by("Noor").id, { title: "x", lane: "exploration", keyResultId: theirs.id })).toThrow(/subtree/);
    // met archives it under its goal: out of scope, the goal stays
    world.grantDesk.updateKeyResult(admin, mine.id, { status: "met" });
    expect(world.keyResults.require(mine.id).archivedAt).toBeTruthy();
    expect(tree.inScope(LAB, mine.id)).toBe(false);
    expect(tree.get(sub.id)?.status).toBe("active");
    world.grantDesk.updateKeyResult(admin, mine.id, { status: "on-track" });
    expect(world.keyResults.require(mine.id).archivedAt).toBeNull();
  });

  it("owners (humans) inherit down the tree, edit and fund in their subtree only; routing ends at the owner", () => {
    const { world, admin, mei, tree, labGoal, otherGoal } = setup();
    const lena = createUser(world, "Lena").user;
    const lenaAv = world.ops.ensureAvatar(lena.id);
    expect(() => tree.update(admin, labGoal.id, { ownerId: mei.id })).toThrow(/Owners are humans/);
    tree.update(admin, labGoal.id, { ownerId: lena.id });
    const sub = tree.create(lenaAv, { parentId: labGoal.id, text: "Lena's sub-goal" });
    expect(tree.ownerOf(sub.id)).toEqual({ goalId: labGoal.id, userId: lena.id });
    expect(tree.ownerOf(otherGoal.id)).toEqual({ goalId: "gl_town", userId: null });
    expect(() => tree.create(lenaAv, { parentId: otherGoal.id, text: "no" })).toThrow(/owner of/);
    expect(() => tree.update(lenaAv, labGoal.id, { ownerId: null })).toThrow(/owner of/); // the goal above isn't hers
    // she decides and funds a grant whose key result sits in her subtree
    const kr = tree.addKeyResult(lenaAv, sub.id, { text: "k", howToCheck: "h", due, buildingId: LAB });
    const g = world.grantDesk.create(null, LAB, { keyResultId: kr.id, objective: "o", approach: "a", stopCondition: "s", askTokens: 1000 });
    world.grantDesk.propose(null, g.id);
    expect(tree.route({ grantId: g.id })).toEqual({ goalId: labGoal.id, userId: lena.id });
    expect(tree.route({ buildingId: LAB })).toEqual({ goalId: labGoal.id, userId: lena.id });
    expect(world.grantDesk.decide(lenaAv, g.id, { action: "fund" }).status).toBe("funded");
    world.grantDesk.updateKeyResult(lenaAv, kr.id, { status: "met" });
    expect(world.keyResults.require(kr.id).status).toBe("met");
  });

  it("retire moves open key results and attached buildings to a sibling, or is refused", () => {
    const { world, admin, tree, labGoal } = setup();
    const kr = tree.addKeyResult(admin, labGoal.id, { text: "k", howToCheck: "h", due, buildingId: LAB });
    expect(() => tree.retire(admin, labGoal.id)).toThrow(/orphan 1 open key result .* and 1 attached building/);
    expect(() => tree.retire(admin, labGoal.id, { moveTo: "gl_join" })).toThrow(/not a sibling/);
    const sib = tree.create(admin, { parentId: "gl_trust", text: "Sibling" });
    tree.retire(admin, labGoal.id, { moveTo: sib.id });
    expect(tree.get(labGoal.id)?.status).toBe("retired");
    expect(world.keyResults.require(kr.id).goalId).toBe(sib.id);
    expect(world.buildings.require(LAB).goalId).toBe(sib.id);
    expect(() => tree.retire(admin, "gl_town")).toThrow(/root/);
  });

  it("managers propose (propose_goal / propose_key_result); a human accepts or cuts; outside the subtree is flagged", async () => {
    const { world, admin, mei, tree, labGoal, otherGoal } = setup();
    const r = await world.verbs.propose_key_result(mei, { text: "Deck shows sessions", howToCheck: "Open the deck", due, why: "funders asked" });
    expect(r.proposal).toMatchObject({ action: "add-kr", status: "open", outsideScope: false });
    expect(() => tree.decideProposal(mei, r.proposal.id, { action: "accept" })).toThrow(/Only a human/);
    const acc = tree.decideProposal(admin, r.proposal.id, { action: "accept" });
    const kr = world.keyResults.require(acc.resultId!);
    expect(kr).toMatchObject({ goalId: labGoal.id, buildingId: LAB, due, text: "Deck shows sessions" });
    const out = await world.verbs.propose_goal(mei, { action: "add-goal", parentId: otherGoal.id, text: "x", why: "y" });
    expect(out.proposal.outsideScope).toBe(true);
    const cut = tree.decideProposal(admin, out.proposal.id, { action: "cut", note: "not ours" });
    expect(cut.status).toBe("cut");
    expect(world.messages.first("toId = ? AND body LIKE '%not ours%'", [mei.id])).toBeTruthy();
    // promote: a key result becomes a standing goal, the key result goes under it
    const p = await world.verbs.propose_goal(mei, { action: "promote", targetId: kr.id, why: "standing" });
    const g = tree.decideProposal(admin, p.proposal.id, { action: "accept" });
    expect(tree.get(g.resultId!)?.parentId).toBe(labGoal.id);
    expect(world.keyResults.require(kr.id).goalId).toBe(g.resultId);
  });

  it("the old objectives and set_key_result keep working on the tree", async () => {
    const { world, admin, labGoal } = setup();
    const o = world.grantDesk.createObjective(admin, LAB, { text: "An objective", kpi: "trust" });
    expect(world.goalTree.get(o.id)).toMatchObject({ parentId: labGoal.id, text: "An objective" });
    const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "k", howToCheck: "h", objectiveId: o.id });
    expect(kr.goalId).toBe(o.id);
    const loose = world.grantDesk.createKeyResult(admin, LAB, { text: "k2", howToCheck: "h" });
    expect(loose.goalId).toBe(labGoal.id);
    expect(world.grantDesk.keyResults(LAB).map((k) => k.id)).toEqual([kr.id, loose.id]);
  });
});

describe("the goal editor (docs/goals.md, step 3)", () => {
  it("the Town Hall's goal tree wall chart: a GOAL_CHART tile on the back wall, its place on the walkable floor below", () => {
    const { world } = setup();
    const p = world.layout.places.find((x) => x.id === "goal-tree")!;
    const g = world.layout.grid;
    expect(p.kind).toBe("goal-tree");
    expect(WALKABLE.has(g.tiles[p.pos.y * g.w + p.pos.x])).toBe(true);
    expect(g.tiles[(p.pos.y - 1) * g.w + p.pos.x]).toBe(TILE.GOAL_CHART);
  });
  it("a goal's History tab: its own edits, its key results, attachments and proposals, newest first; not its siblings'", () => {
    const { admin, tree, labGoal, otherGoal } = setup();
    tree.update(admin, labGoal.id, { text: "A funder sees every token" });
    const kr = tree.addKeyResult(admin, labGoal.id, { text: "The Bank counts every token type", howToCheck: "GET /api/health", due });
    tree.update(admin, otherGoal.id, { text: "Someone else's goal" });
    const child = tree.create(admin, { parentId: labGoal.id, text: "A child goal" });
    const types = tree.history(labGoal.id).map((e) => e.type);
    expect(types[0]).toBe("goal.created");
    expect(types).toEqual(expect.arrayContaining(["goal.edited", "kr.created", "goal.attached", "goal.created"]));
    const texts = tree.history(labGoal.id).map((e) => e.text).join("\n");
    expect(texts).not.toMatch(/Someone else's goal/);
    expect(texts).toMatch(new RegExp(kr.text));
    expect(tree.history(child.id).map((e) => e.type)).toEqual(["goal.created"]);
    expect(() => tree.history("gl_nope")).toThrow();
  });
});

describe("migration 061: lossless from per-building objectives", () => {
  it("every building gets gl_<id> (the Town Hall the root), objectives keep their ids, KRs keep id/status/grants, met ones archive", () => {
    const dir = tempDir(), migrations = join(dir, "migrations");
    mkdirSync(migrations);
    const all = join(import.meta.dirname, "..", "migrations");
    for (const f of readdirSync(all).filter((f) => f.endsWith(".sql") && Number(f.slice(0, 3)) <= 60)) copyFileSync(join(all, f), join(migrations, f));
    const db = new Database(join(dir, "town.db"));
    migrate(db, migrations);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO meta (key, value) VALUES ('town', ?)").run(JSON.stringify({ name: "T", goal: "Make it fundable" }));
    const b = db.prepare("INSERT INTO buildings (id, name, kind, goal, createdAt, headcount) VALUES (?, ?, ?, ?, ?, 6)");
    b.run("bl_th", "Town Hall", "town-hall", "", now);
    b.run("bl_a", "Lab A", "lab", "Lab A's goal", now);
    b.run("bl_b", "Lab B", "lab", "", now);
    db.prepare("INSERT INTO objectives (id, buildingId, position, text, horizon, updatedAt) VALUES ('ob_1', 'bl_a', 0, 'Objective one', '2026-Q4', ?)").run(now);
    const kr = db.prepare("INSERT INTO key_results (id, buildingId, position, text, howToCheck, status, objectiveId, updatedAt) VALUES (?, ?, ?, ?, 'h', ?, ?, ?)");
    kr.run("kr_1", "bl_a", 0, "Under the objective", "on-track", "ob_1", now);
    kr.run("kr_2", "bl_a", 1, "Unsorted", "not-started", null, now);
    kr.run("kr_3", "bl_b", 0, "Met one", "met", null, now);
    copyFileSync(join(all, "061_goal_tree.sql"), join(migrations, "061_goal_tree.sql"));
    migrate(db, migrations);
    const goals = db.prepare("SELECT id, parentId, text FROM goals ORDER BY id").all();
    expect(goals).toEqual(expect.arrayContaining([
      { id: "gl_town", parentId: null, text: "Make it fundable" }, { id: "gl_fund", parentId: "gl_town", text: "Fund" },
      { id: "gl_bl_a", parentId: "gl_town", text: "Lab A's goal" }, { id: "gl_bl_b", parentId: "gl_town", text: "Lab B" },
      { id: "ob_1", parentId: "gl_bl_a", text: "Objective one" },
    ]));
    expect(goals).toHaveLength(7);
    expect(db.prepare("SELECT id, goalId FROM buildings ORDER BY id").all()).toEqual([{ id: "bl_a", goalId: "gl_bl_a" }, { id: "bl_b", goalId: "gl_bl_b" }, { id: "bl_th", goalId: "gl_town" }]);
    expect(db.prepare("SELECT id, status, goalId, archivedAt IS NOT NULL AS archived FROM key_results ORDER BY id").all()).toEqual([
      { id: "kr_1", status: "on-track", goalId: "ob_1", archived: 0 }, { id: "kr_2", status: "not-started", goalId: "gl_bl_a", archived: 0 }, { id: "kr_3", status: "met", goalId: "gl_bl_b", archived: 1 },
    ]);
  });
});
