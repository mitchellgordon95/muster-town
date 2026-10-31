import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANK_FIXTURES, MapLayout, TILE, labSize, type Building, type Lot } from "@muster-town/schema";
import { computeLayout, deriveRoads, migrate, openDb, TownMeta, doorstepOf, findPath, treeLayout, type Grid, type TreeBuilding, type TreeGoal } from "../src/index.ts";

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

  it("keeps the Bank right under the Town Hall, their doors on one street", () => {
    const hall = tree.lots.get("town-hall")!;
    expect(tree.bank.x).toBe(hall.x);
    expect(tree.bank.y).toBe(hall.y + hall.h + 1);
  });

  it("every door and every goal's place reaches the Town Hall by road alone", () => {
    expect(deriveRoads(lots, tree, tree.w, tree.h).unreached).toEqual([]);
    const roads = deriveRoads(lots, tree, tree.w, tree.h);
    const tiles = new Array<number>(tree.w * tree.h).fill(TILE.WALL);
    for (const t of roads.tiles) tiles[t.y * tree.w + t.x] = TILE.PATH;
    const grid: Grid = { w: tree.w, h: tree.h, tiles };
    const hall = doorstepOf(tree.lots.get("town-hall")!, "town-hall");
    for (const p of tree.plazas) expect(findPath(grid, hall, p.pos), p.goalId).not.toBeNull();
    for (const b of lots) expect(findPath(grid, hall, doorstepOf(b.lot, b.kind)), b.id).not.toBeNull();
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
  it("fountain gives each first-level goal with children a plaza three rows tall with a fountain; tree keeps one-row streets", () => {
    const { goals, buildings } = liveTree();
    const f = treeLayout(goals, buildings, "fountain"), t = treeLayout(goals, buildings, "tree");
    const fat = f.plazas.filter((p) => p.depth === 1 && p.street);
    expect(fat.length).toBeGreaterThan(0);
    for (const p of fat) {
      expect(p.street!.h).toBe(3);
      expect(p.fountain).not.toBeNull();
      expect(overlap(p.fountain!, p.street!)).toBe(true);
    }
    for (const p of t.plazas) { expect(p.street?.h ?? 1).toBe(1); expect(p.fountain).toBeNull(); }
    expect(f.lots.get("town-hall")).toEqual(t.lots.get("town-hall"));
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
