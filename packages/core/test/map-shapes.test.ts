import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANK_FIXTURES, MapLayout, TILE, labSize, type Building, type Lot } from "@muster-town/schema";
import { computeLayout, deriveRoads, MAX_HEADCOUNT, migrate, piecesFor, validateLayout, openDb, TownMeta, doorstepOf, findPath, treeLayout, type Grid, type TreeBuilding, type TreeGoal } from "../src/index.ts";

/** The live tree on 2026-10-31 (GET /api/goals and /api/town on muster.town): 19 active goals, the Town Hall and 6 labs. */
function liveTree() {
  const f = JSON.parse(readFileSync(new URL("./fixtures/live-tree-2026-10-31.json", import.meta.url), "utf8")) as {
    goals: TreeGoal[]; buildings: { id: string; kind: "lab" | "town-hall"; name: string; goalId: string; createdAt: string; headcount: number }[];
  };
  const buildings: TreeBuilding[] = f.buildings.map((b) => ({ ...b, size: b.kind === "town-hall" ? { w: 17, h: 11 } : labSize(b.headcount) }));
  return { goals: f.goals, buildings, raw: f.buildings };
}

const overlap = (a: Lot, b: Lot) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A goal signpost's words: drawn on the row above the post, rightwards, cut short of the next post on its row (renderer.ts). */
const SIGN_WORDS = 8;

describe.each(MapLayout.options)("the %s map of the live tree", (shape) => {
  const { goals, buildings, raw } = liveTree();
  const tree = treeLayout(goals, buildings, shape);
  const lots = buildings.map((b) => ({ id: b.id, kind: b.kind, lot: tree.lots.get(b.id)! }));

  it("draws every building and every goal with a building under it, inside the map, nothing overlapping", () => {
    for (const b of lots) {
      expect(b.lot, b.id).toBeDefined();
      expect(b.lot.x >= 1 && b.lot.y >= 1 && b.lot.x + b.lot.w <= tree.w && b.lot.y + b.lot.h <= tree.h, b.id).toBe(true);
    }
    const solid = [...lots.map((b) => ({ id: b.id, lot: b.lot })), { id: "bank", lot: tree.bank }];
    for (const a of solid) for (const b of solid) if (a.id < b.id) expect(overlap(a.lot, b.lot), `${a.id} × ${b.id}`).toBe(false);
    for (const s of tree.plazas.flatMap((p) => (p.street ? [p.street] : []))) for (const a of solid) expect(overlap(s, a.lot), a.id).toBe(false);
    const drawn = new Set(tree.plazas.map((p) => p.goalId));
    for (const b of raw) expect(drawn.has(b.goalId), b.goalId).toBe(true);
  });

  it("keeps the Bank right under the Town Hall, their doors on one street (on a town square: across the square)", () => {
    const hall = tree.lots.get("town-hall")!;
    expect(tree.bank.x).toBe(hall.x);
    const square = tree.paving?.[0];
    if (square) {
      expect(square.y).toBe(hall.y + hall.h);
      expect(tree.bank.y).toBe(square.y + square.h);
    } else expect(tree.bank.y).toBe(hall.y + hall.h + 1);
  });

  it("every door and every goal's place reaches the Town Hall by road alone", () => {
    const roads = deriveRoads(lots, tree, tree.w, tree.h);
    expect(roads.unreached).toEqual([]);
    const tiles = new Array<number>(tree.w * tree.h).fill(TILE.WALL);
    for (const t of roads.tiles) tiles[t.y * tree.w + t.x] = TILE.PATH;
    // a town square's paving is street too, round its fountain
    for (const l of tree.paving ?? []) for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) tiles[y * tree.w + x] = TILE.PAVING;
    for (const p of tree.plazas) if (p.fountain) for (let y = p.fountain.y; y < p.fountain.y + p.fountain.h; y++) for (let x = p.fountain.x; x < p.fountain.x + p.fountain.w; x++) tiles[y * tree.w + x] = TILE.WALL;
    const grid: Grid = { w: tree.w, h: tree.h, tiles };
    const hall = doorstepOf(tree.lots.get("town-hall")!, roads.sides.get("town-hall")!);
    for (const p of tree.plazas) expect(findPath(grid, hall, p.pos), p.goalId).not.toBeNull();
    for (const b of lots) expect(findPath(grid, hall, doorstepOf(b.lot, roads.sides.get(b.id)!)), b.id).not.toBeNull();
    expect(findPath(grid, hall, { x: tree.bank.x + BANK_FIXTURES.door.x, y: tree.bank.y - 1 })).not.toBeNull();
  });

  it("no two labels overlap: building names (cut to the lot's width) and goal signposts' words", () => {
    const labels = [
      ...lots.map((b) => ({ id: b.id, r: { x: b.lot.x, y: b.lot.y - 1, w: b.lot.w, h: 1 } })),
      ...tree.plazas.flatMap((p) => {
        if (!p.sign) return [];
        const next = Math.min(...tree.plazas.filter((o) => o.sign && o.sign.y === p.sign!.y && o.sign.x > p.sign!.x).map((o) => o.sign!.x));
        return [{ id: `sign:${p.goalId}`, r: { x: p.sign.x, y: p.sign.y - 1, w: Math.max(1, Math.min(SIGN_WORDS, next - p.sign.x - 1)), h: 1 } }];
      }),
    ];
    for (const a of labels) for (const b of labels) if (a.id < b.id) expect(overlap(a.r, b.r), `${a.id} × ${b.id}`).toBe(false);
    // a signpost's words never cover a building
    for (const a of labels.filter((l) => l.id.startsWith("sign:"))) for (const b of lots) expect(overlap(a.r, b.lot), `${a.id} × ${b.id}`).toBe(false);
  });

  it("the whole map: every place walkable and reachable from the plaza, the same map whatever order the tree arrives in", () => {
    const bs = raw.map((b) => ({ ...b, headcount: b.headcount, furniture: {} })) as unknown as Building[];
    const a = computeLayout(bs, goals, new Map(), new Map(), shape);
    const b = computeLayout([...bs].reverse(), [...goals].reverse(), new Map(), new Map(), shape);
    expect(b.grid).toEqual(a.grid);
    const plaza = a.places.find((p) => p.id === "plaza")!;
    for (const p of a.places) expect(findPath(a.grid, plaza.pos, p.pos), p.id).not.toBeNull();
    if (shape === "fountain") expect(a.grid.tiles.filter((t) => t === TILE.FOUNTAIN).length).toBeGreaterThan(0);
  });
});

describe("map shapes differ", () => {
  it("fountain is a planned town: the Town Hall and the Bank face a paved square with a fountain, a main street runs through it, each first-level goal is a district on its own avenue with every door facing it (1:1 mt_3ldf9p5av1)", () => {
    const { goals, buildings } = liveTree();
    const f = treeLayout(goals, buildings, "fountain"), t = treeLayout(goals, buildings, "tree");
    const square = f.paving![0], hall = f.lots.get("town-hall")!, root = f.plazas.find((p) => !p.parentId)!;
    expect(f.sides!.get("town-hall")).toBe("s");
    expect(doorstepOf(hall, "s").y).toBe(square.y);
    expect(f.bank.y - 1).toBe(square.y + square.h - 1);
    expect(root.fountain).toMatchObject({ w: 3, h: 3 });
    expect(overlap(root.fountain!, square)).toBe(true);
    // the main street crosses the square and runs past it both ways
    const main = root.street!;
    expect(main.x).toBeLessThan(square.x);
    expect(main.x + main.w).toBeGreaterThan(square.x + square.w);
    // a district per first-level goal with a building under it: a signpost on the main street's edge, every lab's door
    // in a side wall, its doorstep on the district's avenue
    const districts = f.plazas.filter((p) => p.depth === 1);
    expect(districts.map((p) => p.goalId).sort()).toEqual(["gl_join", "gl_trust"]);
    for (const d of districts) expect(d.pos.y).toBe(main.y);
    const avenues = new Set(districts.flatMap((d) => f.edges.get(d.goalId)!).map((e) => `${e.x},${e.y}`));
    for (const b of buildings.filter((x) => x.kind === "lab")) {
      const side = f.sides!.get(b.id)!;
      expect(["e", "w"], b.id).toContain(side);
      const step = doorstepOf(f.lots.get(b.id)!, side);
      expect(avenues.has(`${step.x},${step.y}`), b.id).toBe(true);
    }
    // dressed: trees, lamps, benches and flower beds, none on a road or a lot
    const kinds = new Set(f.decor!.map((d) => d.tile));
    for (const k of [TILE.TREE, TILE.LAMP, TILE.BENCH, TILE.FLOWERS]) expect(kinds.has(k), String(k)).toBe(true);
    const solid = [...f.lots.values(), f.bank, main, root.fountain!];
    for (const d of f.decor!) for (const l of solid) expect(overlap({ ...d.at, w: 1, h: 1 }, l), `decor at ${d.at.x},${d.at.y}`).toBe(false);
    for (const d of f.decor!) expect(avenues.has(`${d.at.x},${d.at.y}`)).toBe(false);
    // the tree keeps one-row streets, no square, every lab's door in its top wall
    for (const p of t.plazas) { expect(p.street?.h ?? 1).toBe(1); expect(p.fountain).toBeNull(); }
    expect(t.paving).toBeUndefined();
  });

  it("every default room is legal with its door in any wall, for every headcount", () => {
    for (let n = 1; n <= MAX_HEADCOUNT; n++) for (const side of ["n", "s", "e", "w"] as const) {
      expect(validateLayout("lab", labSize(n), piecesFor("lab", n, labSize(n), side), {}, side), `headcount ${n}, door ${side}`).toEqual([]);
    }
  });

  it("radial: every lab's door faces the middle of the town", () => {
    const { goals, buildings } = liveTree();
    const r = treeLayout(goals, buildings, "radial"), hall = r.lots.get("town-hall")!;
    const mid = { x: hall.x + hall.w / 2, y: hall.y + hall.h };
    for (const b of buildings.filter((x) => x.kind === "lab")) {
      const l = r.lots.get(b.id)!, d = doorstepOf(l, r.sides!.get(b.id)!);
      // the doorstep is nearer the middle than the lot's centre is
      expect(Math.hypot(d.x - mid.x, d.y - mid.y), b.id).toBeLessThan(Math.hypot(l.x + l.w / 2 - mid.x, l.y + l.h / 2 - mid.y));
    }
  });
});

describe("the town-wide setting", () => {
  it("migration 070 keeps a town that already exists on the plain tree; a new town starts as fountain plazas", () => {
    const db = openDb(":memory:");
    const town = new TownMeta(db);
    expect(town.get().mapLayout).toBe("fountain"); // nothing stored: a new collective
    db.prepare("UPDATE meta SET value = ? WHERE key = 'town'").run("{}");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('town', ?)").run(JSON.stringify({ name: "Old", goal: "g" }));
    db.prepare("DELETE FROM schema_version WHERE version = 70").run();
    migrate(db);
    expect(town.get().mapLayout).toBe("tree");
    town.set({ mapLayout: "radial" });
    db.prepare("DELETE FROM schema_version WHERE version = 70").run();
    migrate(db);
    expect(town.get().mapLayout).toBe("radial"); // a pick is never overwritten
  });
});
