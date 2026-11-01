import { describe, expect, it } from "vitest";
import { BANK_FIXTURES, BANK_LOT, ROOT_GOAL_ID, TILE, labSize, type Lot } from "@muster-town/schema";
import { World, computeLayout, defaultSide, createBuilding, createResident, deriveRoads, doorstepOf, findPath, treeLayout, type Grid, type TreeBuilding, type TreeGoal } from "../src/index.ts";
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

/** Only roads walkable: grass, floors and everything else are walls. */
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

  it("draws only goals with buildings, no plaza per building: every lab stands on a street, nothing overlaps, the map is packed", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    // Fund, Join and Trust have no building under them: nothing draws for them; neither for the objectives
    expect(tree.plazas.map((p) => p.goalId).sort()).toEqual([ROOT_GOAL_ID, ...buildings.filter((b) => b.kind === "lab").map((b) => `gl_${b.id}`)].sort());
    const plaza = new Map(tree.plazas.map((p) => [p.goalId, p]));
    const hall = tree.lots.get("town-hall")!, main = plaza.get(ROOT_GOAL_ID)!.street!;
    expect(hall.y + hall.h).toBe(main.y); // the Town Hall stands on the main street
    expect(BANK_LOT.y).toBe(main.y + 1); // and the Bank below it
    const streets = tree.plazas.flatMap((p) => (p.street ? [p.street] : []));
    const onStreet = (t: { x: number; y: number }) => streets.some((s) => overlap({ ...t, w: 1, h: 1 }, s));
    for (const b of buildings) expect(onStreet(doorstepOf(tree.lots.get(b.id)!, defaultSide(b.kind))), b.id).toBe(true);
    // a goal with no drawn children has no street or signpost of its own: its place is its building's doorstep
    for (const b of buildings.filter((x) => x.kind === "lab")) {
      const p = plaza.get(b.goalId!)!;
      expect(p.street, b.id).toBeNull();
      expect(p.sign, b.id).toBeNull();
      expect(p.pos).toEqual(doorstepOf(tree.lots.get(b.id)!, "n"));
    }
    // nothing overlaps: lots, the Bank, streets and signposts
    const rects: [string, Lot][] = [...tree.lots.entries(), ["bank", tree.bank], ...streets.map((r, i): [string, Lot] => [`street ${i}`, r]),
      ...tree.plazas.flatMap((p): [string, Lot][] => (p.sign ? [[`sign:${p.goalId}`, { ...p.sign, w: 1, h: 1 }]] : []))];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i][1], rects[j][1]), `${rects[i][0]} vs ${rects[j][0]}`).toBe(false);
    // packed: one row of labs either side of the Bank, a tile of grass between neighbours
    const labs = buildings.filter((b) => b.kind === "lab").map((b) => tree.lots.get(b.id)!).sort((p, q) => p.x - q.x);
    const west = labs.filter((l) => l.x < tree.bank.x), east = labs.filter((l) => l.x > tree.bank.x);
    expect(west.length && east.length).toBeTruthy();
    for (const row of [west, east]) for (let i = 1; i < row.length; i++) expect(row[i].x - (row[i - 1].x + row[i - 1].w), `gap ${i}`).toBe(1);
    expect(tree.h).toBe(main.y + 1 + Math.max(BANK_LOT.h, ...labs.map((l) => l.h)) + 2);
  });

  it("a goal with its own building and drawn children gets a street one row down, a drop to it and a signpost; a bare chain folds", () => {
    const { goals, buildings } = liveTree();
    // Onboarding and UI/UX under the Workshop's goal; Trust holds Prod and Code (no building of its own); Fund → ob_fund → a lab (a chain)
    const parent: Record<string, string> = { gl_onboarding: "gl_workshop", gl_uiux: "gl_workshop", gl_prod: "gl_trust", gl_code: "gl_trust", "gl_bank-t": "ob_fund" };
    const g2 = [...goals.map((g) => (parent[g.id] ? { ...g, parentId: parent[g.id] } : g)), { id: "ob_fund", parentId: "gl_fund", text: "o", position: 0, createdAt: "" }];
    const tree = treeLayout(g2, buildings);
    const plaza = new Map(tree.plazas.map((p) => [p.goalId, p]));
    expect(plaza.has("gl_fund")).toBe(false);
    expect(plaza.has("ob_fund")).toBe(false);
    expect(plaza.get("gl_bank-t")!.parentId).toBe(ROOT_GOAL_ID);
    for (const id of ["gl_workshop", "gl_trust"]) {
      const p = plaza.get(id)!, main = plaza.get(ROOT_GOAL_ID)!.street!;
      expect(p.street!.y, id).toBe(main.y + 2);
      expect(p.sign, id).toEqual({ x: p.pos.x, y: p.pos.y - 1 });
      expect(tree.edges.get(id), id).toEqual([{ x: p.sign!.x - 1, y: main.y + 1 }]);
      expect(p.sign!.x - 1 >= p.street!.x && p.sign!.x - 1 < p.street!.x + p.street!.w, id).toBe(true); // the drop lands on the street
    }
    const ws = plaza.get("gl_workshop")!.street!;
    expect(tree.lots.get("workshop")!.y).toBe(ws.y - 1); // the Workshop stands on the main street
    for (const id of ["onboarding", "uiux"]) expect(tree.lots.get(id)!.y, id).toBe(ws.y + 1);
    const lots = buildings.map((b) => ({ id: b.id, kind: b.kind, lot: tree.lots.get(b.id)! }));
    expect(deriveRoads(lots, tree, tree.w, tree.h).unreached).toEqual([]);
  });

  it("leaves grass right of the Town Hall, above the main street, for the Bank's marquee", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    // the web hangs the marquee from two columns right of the Bank, beside the Town Hall's rows (renderer.ts)
    const hall = tree.lots.get("town-hall")!;
    const marquee: Lot = { x: tree.bank.x + tree.bank.w + 2, y: hall.y, w: 20, h: hall.h - 1 };
    for (const [id, lot] of tree.lots) expect(overlap(lot, marquee), id).toBe(false);
    for (const p of tree.plazas) if (p.street) expect(overlap(p.street, marquee), p.goalId).toBe(false);
  });

  it("puts the Town Hall and the Bank in the top middle, the blocks split evenly either side (1:1 mt_cyd2t5ioob)", () => {
    const { goals, buildings } = liveTree();
    for (const shaped of [goals, goals.map((g) => (g.id === "gl_onboarding" || g.id === "gl_uiux" ? { ...g, parentId: "gl_workshop" } : g))]) {
      const tree = treeLayout(shaped, buildings), hall = tree.lots.get("town-hall")!;
      expect(Math.abs(hall.x + hall.w / 2 - tree.w / 2)).toBeLessThanOrEqual(2);
      expect(tree.bank.x).toBe(hall.x);
      expect(hall.y).toBeLessThanOrEqual(Math.min(...[...tree.lots.values()].map((l) => l.y)));
      const labs = buildings.filter((b) => b.kind === "lab").map((b) => tree.lots.get(b.id)!);
      expect(labs.some((l) => l.x + l.w <= hall.x) && labs.some((l) => l.x >= hall.x + hall.w)).toBe(true);
    }
    // a lone block under a goal's drop stands right of it; two split one each side, centred under the signpost
    const pair = [...goals, { id: "gl_a", parentId: "gl_fund", text: "a", position: 0, createdAt: "" }, { id: "gl_b", parentId: "gl_fund", text: "b", position: 1, createdAt: "" }];
    const two = treeLayout(pair, [...buildings, { id: "a", kind: "lab", goalId: "gl_a", createdAt: "", size: labSize(2) }, { id: "b", kind: "lab", goalId: "gl_b", createdAt: "", size: labSize(2) }]);
    const fund = two.plazas.find((p) => p.goalId === "gl_fund")!, a = two.lots.get("a")!, b = two.lots.get("b")!;
    expect(a.x + a.w).toBeLessThan(fund.sign!.x);
    expect(b.x).toBe(fund.sign!.x);
    expect(fund.sign!.x - 1 - (a.x + a.w)).toBe(1);
  });

  it("every place and every door reaches the Town Hall by road alone", () => {
    const { goals, buildings } = liveTree();
    const tree = treeLayout(goals, buildings);
    const lots = buildings.map((b) => ({ id: b.id, kind: b.kind, lot: tree.lots.get(b.id)! }));
    expect(deriveRoads(lots, tree, tree.w, tree.h).unreached).toEqual([]);
    const grid = roadsOnly(lots, tree);
    const hall = doorstepOf(tree.lots.get("town-hall")!, "s");
    for (const p of tree.plazas) expect(findPath(grid, hall, p.pos), p.goalId).not.toBeNull();
    for (const b of lots) expect(findPath(grid, hall, doorstepOf(b.lot, defaultSide(b.kind))), b.id).not.toBeNull();
    expect(findPath(grid, hall, { x: tree.bank.x + BANK_FIXTURES.door.x, y: tree.bank.y - 1 })).not.toBeNull();
  });

  it("adding a building keeps every lab's order and the Town Hall in the middle; a deep chain stays on the map", () => {
    const { goals, buildings } = liveTree();
    const before = treeLayout(goals, buildings);
    const more = [...goals, { id: "gl_new", parentId: "gl_workshop", text: "New", position: 9, createdAt: "2026-10-31T00:00:00.000Z" }];
    const after = treeLayout(more, [...buildings, { id: "new-lab", kind: "lab", goalId: "gl_new", createdAt: "2026-10-31T00:00:00.000Z", size: labSize(2) }]);
    const order = (t: ReturnType<typeof treeLayout>) => buildings.filter((b) => b.kind === "lab").map((b) => b.id).sort((p, q) => t.lots.get(p)!.x - t.lots.get(q)!.x);
    expect(order(after)).toEqual(order(before));
    for (const t of [before, after]) { const hall = t.lots.get("town-hall")!; expect(Math.abs(hall.x + hall.w / 2 - t.w / 2)).toBeLessThanOrEqual(2); }
    const chain: TreeGoal[] = [{ id: ROOT_GOAL_ID, parentId: null, text: "root", position: 0, createdAt: "" }];
    for (let i = 0; i < 8; i++) chain.push({ id: `g${i}`, parentId: chain[chain.length - 1].id, text: `g${i}`, position: 0, createdAt: "" });
    const deep = treeLayout(chain, [{ id: "deep", kind: "lab", goalId: "g7", createdAt: "", size: labSize(3) }]);
    const lot = deep.lots.get("deep")!;
    expect(lot.y + lot.h).toBeLessThanOrEqual(deep.h);
    expect(deep.plazas.map((p) => p.goalId)).toEqual([ROOT_GOAL_ID, "g7"]); // the chain folds: no walk down eight empty goals
  });

  it("a tree change redraws the map: a new goal draws once a building attaches to it, the building moves there and its residents follow", () => {
    const { world, seed, by } = seededWorld("tree");
    // a second lab on the main street, so moving carbon-cycle to a goal of its own moves it (after the root's own buildings)
    const b = createBuilding(world, { name: "Sized", headcount: 7 }, seed.admin.id);
    expect(world.buildings.require(b.id).lot).toMatchObject(labSize(7));
    const g = world.goalTree.create(null, { parentId: ROOT_GOAL_ID, text: "Make the map the tree" });
    expect(world.layout.place(`plaza:${g.id}`)).toBeUndefined(); // no building under it: nothing on the map
    const ravi = by("Ravi"), desk = world.layout.deskOf(ravi.id)!;
    world.agents.patch(ravi.id, { pos: desk.pos });
    const lot = world.buildings.require("carbon-cycle").lot!;
    world.goalTree.attach(null, "carbon-cycle", g.id);
    const moved = world.buildings.require("carbon-cycle").lot!;
    expect(moved).not.toEqual(lot);
    const plaza = world.layout.requirePlace(`plaza:${g.id}`);
    expect(plaza.kind).toBe("plaza");
    expect(plaza.name).toBe("Make the map the tree");
    // the building stands on the street, its goal's place on its doorstep, and Ravi is still at his desk
    expect(plaza.pos).toEqual(doorstepOf(moved, "n"));
    expect(world.agents.require(ravi.id).pos).toEqual(world.layout.deskOf(ravi.id)!.pos);
    expect(world.layout.deskOf(ravi.id)!.pos).not.toEqual(desk.pos);
    // retiring the goal (moving the building back first) takes it off the map
    world.goalTree.attach(null, "carbon-cycle", ROOT_GOAL_ID);
    world.goalTree.retire(null, g.id);
    expect(world.layout.place(`plaza:${g.id}`)).toBeUndefined();
    // the new building's residents reach their desks from the plaza
    createResident(world, { buildingId: b.id, name: "Ida", title: "t", direction: "d" });
    const plazaTile = world.layout.requirePlace("plaza").pos;
    expect(findPath(world.layout.grid, plazaTile, world.layout.deskOf(by("Ida").id)!.pos)).not.toBeNull();
  });

  it("a map that changed across a restart (a deploy): residents follow their desks on the first rebuild", () => {
    const { world, dbPath, by, seed } = seededWorld("tree");
    createBuilding(world, { name: "Neighbour" }, seed.admin.id); // so carbon-cycle moving off the main street moves it
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
