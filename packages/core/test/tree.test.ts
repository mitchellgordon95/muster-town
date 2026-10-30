import { describe, expect, it } from "vitest";
import { BANK_FIXTURES, BANK_LOT, ROOT_GOAL_ID, TILE, labSize, type Lot } from "@muster-town/schema";
import { World, computeLayout, createBuilding, createResident, deriveRoads, doorstepOf, findPath, treeLayout, type Grid, type TreeBuilding, type TreeGoal } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

/** The live tree at def72e8 (16 goals, 6 labs + the Town Hall), in its shape. */
function liveTree() {
  const t = (n: number) => `2026-10-30T21:02:${String(n).padStart(2, "0")}.000Z`;
  const goals: TreeGoal[] = [{ id: ROOT_GOAL_ID, parentId: null, text: "Make Muster Town something strangers can fund, join, and trust", position: 0, createdAt: t(0) }];
  const add = (id: string, parentId: string, position: number) => goals.push({ id, parentId, text: `Goal ${id}`, position, createdAt: t(goals.length) });
  ["gl_fund", "gl_join", "gl_trust"].forEach((id, i) => add(id, ROOT_GOAL_ID, i));
  const labs = ["workshop", "onboarding", "prod", "bank-t", "code", "uiux"];
  labs.forEach((id, i) => add(`gl_${id}`, ROOT_GOAL_ID, 3 + i));
  for (const [lab, n] of [["workshop", 3], ["prod", 2], ["code", 1]] as const) for (let i = 0; i < n; i++) add(`ob_${lab}_${i}`, `gl_${lab}`, i);
  const desks = [5, 3, 2, 2, 2, 3];
  const buildings: TreeBuilding[] = [
    { id: "town-hall", kind: "town-hall", goalId: ROOT_GOAL_ID, createdAt: t(0), size: { w: 17, h: 11 } },
    ...labs.map((id, i): TreeBuilding => ({ id, kind: "lab", goalId: `gl_${id}`, createdAt: t(i + 1), size: labSize(desks[i]) })),
  ];
  return { goals, buildings };
}

/** Only roads and doors walkable: grass, floors and everything else are walls. */
function roadsOnly(lots: { id: string; kind: "lab" | "town-hall"; lot: Lot }[], tree: ReturnType<typeof treeLayout>): Grid {
  const roads = deriveRoads(lots, tree, tree.w, tree.h);
  const tiles = new Array<number>(tree.w * tree.h).fill(TILE.WALL);
  for (const t of roads.tiles) tiles[t.y * tree.w + t.x] = TILE.PATH;
  return { w: tree.w, h: tree.h, tiles };
}

const overlap = (a: Lot, b: Lot) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the map is the tree (docs/goals.md, build step 2)", () => {
  it("the same tree always gives the same map, whatever order it arrives in", () => {
    const { goals, buildings } = liveTree();
    const a = computeLayout(buildings.map((b) => ({ ...b, name: b.id, headcount: 2, furniture: {} })) as never, goals, new Map(), new Map());
    const b = computeLayout([...buildings].reverse().map((x) => ({ ...x, name: x.id, headcount: 2, furniture: {} })) as never, [...goals].reverse(), new Map(), new Map());
    expect(b.grid).toEqual(a.grid);
    expect([...b.lots.entries()].sort()).toEqual([...a.lots.entries()].sort());
    expect(b.places.map((p) => p.id).sort()).toEqual(a.places.map((p) => p.id).sort());
  });

  it("draws a plaza per goal with its signpost, the Town Hall at the root, every building below its goal's plaza with its door on it", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    expect(tree.plazas).toHaveLength(16);
    const plaza = new Map(tree.plazas.map((p) => [p.goalId, p]));
    const hall = tree.lots.get("town-hall")!, root = plaza.get(ROOT_GOAL_ID)!;
    expect(hall.y + hall.h).toBe(root.rect.y); // the Town Hall stands on the root plaza
    expect(BANK_LOT.y).toBe(root.rect.y + root.rect.h); // and the Bank below it
    for (const b of buildings.filter((x) => x.kind === "lab")) {
      const lot = tree.lots.get(b.id)!, p = plaza.get(b.goalId!)!;
      expect(tree.standsAt.get(b.id)).toBe(b.goalId);
      const step = doorstepOf(lot, "lab");
      expect(step.y, b.id).toBe(p.rect.y + p.rect.h - 1);
      expect(step.x >= p.rect.x && step.x < p.rect.x + p.rect.w, b.id).toBe(true);
    }
    // nothing overlaps: lots, the Bank, plazas and their signposts
    const rects: [string, Lot][] = [...tree.lots.entries(), ["bank", BANK_LOT], ...tree.plazas.map((p): [string, Lot] => [`plaza:${p.goalId}`, { ...p.rect, w: p.rect.w + 1 }])];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i][1], rects[j][1]), `${rects[i][0]} vs ${rects[j][0]}`).toBe(false);
    // an empty goal (Fund, Join, Trust today) is an empty plaza with its signpost
    expect(plaza.get("gl_fund")!.rect.w).toBeGreaterThan(0);
  });

  it("leaves grass left of the Bank for its marquee (the root plaza alone separates the Bank from the Town Hall's wall)", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    // the web hangs the marquee right-aligned one column left of the root's trunk, beside the Bank's rows (renderer.ts)
    const marquee: Lot = { x: BANK_LOT.x - 4 - 20, y: BANK_LOT.y, w: 20, h: BANK_LOT.h };
    for (const [id, lot] of tree.lots) expect(overlap(lot, marquee), id).toBe(false);
    for (const p of tree.plazas) expect(overlap({ ...p.rect, w: p.rect.w + 1 }, marquee), p.goalId).toBe(false);
    for (const [id, road] of tree.edges) for (const t of road) expect(overlap({ ...t, w: 1, h: 1 }, marquee), id).toBe(false);
  });

  it("every plaza and every door reaches the Town Hall by road alone (the roads are the tree's edges)", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    const lots = buildings.map((b) => ({ id: b.id, kind: b.kind, lot: tree.lots.get(b.id)! }));
    expect(deriveRoads(lots, tree, tree.w, tree.h).unreached).toEqual([]);
    const grid = roadsOnly(lots, tree);
    const hall = doorstepOf(tree.lots.get("town-hall")!, "town-hall");
    for (const p of tree.plazas) expect(findPath(grid, hall, { x: p.rect.x, y: p.rect.y }), p.goalId).not.toBeNull();
    for (const b of lots) expect(findPath(grid, hall, doorstepOf(b.lot, b.kind)), b.id).not.toBeNull();
    expect(findPath(grid, hall, { x: BANK_LOT.x + BANK_FIXTURES.door.x, y: BANK_LOT.y - 1 })).not.toBeNull();
    // a child's road runs to its own parent's plaza: Workshop's objectives hang off the Workshop's plaza, not the root's
    const ws = tree.plazas.find((p) => p.goalId === "gl_workshop")!, edge = tree.edges.get("ob_workshop_0")!;
    expect(edge.at(-1)!.y).toBe(ws.rect.y + ws.rect.h);
  });

  it("adding a sibling moves no earlier building or plaza; a deep chain grows down, not off the map", () => {
    const { goals, buildings } = liveTree();
    const before = treeLayout(goals, buildings);
    const more = [...goals, { id: "gl_new", parentId: "gl_workshop", text: "New", position: 9, createdAt: "2026-10-31T00:00:00.000Z" }];
    const after = treeLayout(more, [...buildings, { id: "new-lab", kind: "lab", goalId: "gl_new", createdAt: "2026-10-31T00:00:00.000Z", size: labSize(2) }]);
    // the Workshop's band is the 4th child of the root: the Town Hall, Fund/Join/Trust and the Workshop (all left of the new goal) stay put
    for (const id of ["town-hall", "workshop"]) expect(after.lots.get(id), id).toEqual(before.lots.get(id));
    for (const g of ["gl_town", "gl_fund", "gl_join", "gl_trust", "gl_workshop", "ob_workshop_0", "ob_workshop_1", "ob_workshop_2"]) {
      expect(after.plazas.find((p) => p.goalId === g)!.rect, g).toEqual(before.plazas.find((p) => p.goalId === g)!.rect);
    }
    // later bands may shift right, never left, and keep their order
    for (const id of ["onboarding", "prod", "bank-t", "code", "uiux"]) expect(after.lots.get(id)!.x).toBeGreaterThanOrEqual(before.lots.get(id)!.x);
    const chain: TreeGoal[] = [{ id: ROOT_GOAL_ID, parentId: null, text: "root", position: 0, createdAt: "" }];
    for (let i = 0; i < 8; i++) chain.push({ id: `g${i}`, parentId: chain[chain.length - 1].id, text: `g${i}`, position: 0, createdAt: "" });
    const deep = treeLayout(chain, [{ id: "deep", kind: "lab", goalId: "g7", createdAt: "", size: labSize(3) }]);
    const lot = deep.lots.get("deep")!;
    expect(lot.y + lot.h).toBeLessThanOrEqual(deep.h);
  });

  it("a tree change redraws the map: a new goal gets a plaza, attaching a building moves it there and its residents follow", () => {
    const { world, seed, by } = seededWorld();
    const g = world.goalTree.create(null, { parentId: ROOT_GOAL_ID, text: "Make the map the tree" });
    const plaza = world.layout.requirePlace(`plaza:${g.id}`);
    expect(plaza.kind).toBe("plaza");
    expect(plaza.name).toBe("Make the map the tree");
    const ravi = by("Ravi"), desk = world.layout.deskOf(ravi.id)!;
    world.agents.patch(ravi.id, { pos: desk.pos });
    const lot = world.buildings.require("carbon-cycle").lot!;
    world.goalTree.attach(null, "carbon-cycle", g.id);
    const moved = world.buildings.require("carbon-cycle").lot!;
    expect(moved).not.toEqual(lot);
    // the building now stands below its new goal's plaza, and Ravi is still at his desk
    const p = world.layout.plazas.find((x) => x.goalId === g.id)!;
    expect(moved.y).toBe(p.rect.y + p.rect.h);
    expect(world.agents.require(ravi.id).pos).toEqual(world.layout.deskOf(ravi.id)!.pos);
    expect(world.layout.deskOf(ravi.id)!.pos).not.toEqual(desk.pos);
    // retiring the goal (moving the building back first) takes its plaza off the map
    world.goalTree.attach(null, "carbon-cycle", ROOT_GOAL_ID);
    world.goalTree.retire(null, g.id);
    expect(world.layout.place(`plaza:${g.id}`)).toBeUndefined();
    // a new building lands at its goal; Desks sets its size
    const b = createBuilding(world, { name: "Sized", headcount: 7 }, seed.admin.id);
    expect(world.buildings.require(b.id).lot).toMatchObject(labSize(7));
    createResident(world, { buildingId: b.id, name: "Ida", title: "t", direction: "d" });
    const plazaTile = world.layout.requirePlace("plaza").pos;
    expect(findPath(world.layout.grid, plazaTile, world.layout.deskOf(by("Ida").id)!.pos)).not.toBeNull();
  });

  it("a map that changed across a restart (a deploy): residents follow their desks on the first rebuild", () => {
    const { world, dbPath, by } = seededWorld();
    const g = world.goalTree.create(null, { parentId: ROOT_GOAL_ID, text: "Somewhere else" });
    const ravi = by("Ravi");
    world.agents.patch(ravi.id, { pos: world.layout.deskOf(ravi.id)!.pos });
    // the tree changes with no redraw (as a new build's layout would differ from the stored one)
    world.buildings.upsert({ ...world.buildings.require("carbon-cycle"), goalId: g.id });
    const old = world.layout.deskOf(ravi.id)!.pos;
    world.close();
    const w2 = World.open(dbPath);
    const desk = w2.layout.deskOf(ravi.id)!.pos;
    expect(desk).not.toEqual(old);
    expect(w2.agents.require(ravi.id).pos).toEqual(desk);
    w2.close();
  });
});
