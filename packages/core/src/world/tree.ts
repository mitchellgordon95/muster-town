import { BANK_LOT, ROOT_GOAL_ID, type Lot, type MapLayout, type Tile } from "@muster-town/schema";
import { radialLayout } from "./radial.ts";
import type { Side } from "./road.ts";
import { squareLayout } from "./square.ts";

/**
 * The map is the goal tree (docs/goals.md "The map is the tree", build step 2). Nobody places buildings: `treeLayout`
 * computes every lot and street from the tree, and `computeLayout` draws them. Packed so it reads as a town
 * (Mitchell, 1:1 mt_wql34b8gkl): no lot for a goal without buildings, no plaza per building, one tile of grass between neighbours.
 *
 * - The Town Hall stands at the root, above the main street (a road one tile tall); the Bank (fixed, `BANK_LOT`) below it.
 * - Only goals with a building somewhere under them draw. A goal with no building of its own and one drawn child folds
 *   into that child (a chain is one step, not a long walk); with two or more it is a junction.
 * - A building stands right on the street of its goal's parent, its door in its top wall on that street. A goal's own
 *   buildings come first, left to right in a fixed order (`position`, then `createdAt`, then id).
 * - A goal with drawn children gets a street of its own, one row below its parent's: a one-tile road drops from the parent's
 *   street right after the goal's own buildings, the street runs right from it, and the children's blocks hang off it.
 *   Its signpost (TILE.SIGNPOST) stands beside the drop, the goal's place (`plaza:<goalId>`) on the street below it.
 *   A goal without children needs no signpost: its buildings' signs name it.
 * - Blocks sit side by side with one tile of grass between them, so adding a building shifts the blocks after it
 *   (right, keeping order); nothing before it moves.
 *
 * Three shapes of the same tree, a town-wide setting (`town.mapLayout`, 1:1 mt_q10xf3bkoq; mocks dc_fvgi5nq36j):
 * - "tree": the packed layout above.
 * - "fountain": a planned town (square.ts, 1:1 mt_3ldf9p5av1): a square with the Town Hall and a fountain, a main
 *   street through it, each first-level goal a district on its own cross street.
 * - "radial": the Town Hall in the middle and each first-level goal a spoke (radial.ts).
 *
 * Pure: the same tree always gives the same map.
 */

/** Grass between two neighbouring buildings or blocks. */
const GAP = 1;
/** Grass around the town. */
const MARGIN = 2;

export interface TreeGoal { id: string; parentId: string | null; text: string; position: number; createdAt: string }
export interface TreeBuilding { id: string; kind: "lab" | "town-hall"; goalId?: string | null; createdAt: string; size: { w: number; h: number } }
/** A drawn goal: its place on the map and, when it has drawn children, its street and signpost. */
export interface Plaza {
  goalId: string;
  /** the drawn goal it hangs off (null for the root) */
  parentId: string | null;
  text: string;
  depth: number;
  /** its place (`plaza:<goalId>`): on its own street below its signpost, or the doorstep of its first building */
  pos: Tile;
  /** its street (the root's is the main street), null for a goal with no drawn children */
  street: Lot | null;
  /** its signpost: directly above `pos` (the web finds it there); null for a goal with no drawn children */
  sign: Tile | null;
  /** the fountain in the middle of the town square (the root's, "fountain" shape; not walkable); null elsewhere */
  fountain: Lot | null;
}
export interface TreeLayout {
  lots: Map<string, Lot>;
  /** the goal each building is drawn at (the root for the Town Hall and for one attached to no active goal) */
  standsAt: Map<string, string>;
  plazas: Plaza[];
  /** per junction goal: the road dropping from its parent's street to its own */
  edges: Map<string, Tile[]>;
  /** the Bank's lot: below the Town Hall */
  bank: Lot;
  /** the wall each building's door is in, where the shape decides it (else road.ts picks the side facing the nearest road) */
  sides?: Map<string, Side>;
  /** the town square's paving */
  paving?: Lot[];
  /** trees, lamps, benches and flower beds (TILE ids), each one tile */
  decor?: { at: Tile; tile: number }[];
  w: number;
  h: number;
}

const byOrder = <T extends { createdAt: string; id: string }>(a: T & { position?: number }, b: T & { position?: number }) =>
  (a.position ?? 0) - (b.position ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function treeLayout(goals: TreeGoal[], buildings: TreeBuilding[], shape: MapLayout = "tree"): TreeLayout {
  const ids = new Set(goals.map((g) => g.id));
  const root = goals.find((g) => g.id === ROOT_GOAL_ID) ?? goals.find((g) => !g.parentId) ?? { id: ROOT_GOAL_ID, parentId: null, text: "", position: 0, createdAt: "" };
  const kids = new Map<string, TreeGoal[]>();
  for (const g of goals) {
    if (g.id === root.id) continue;
    // a goal whose parent isn't active hangs off the root, so nothing is lost off the map
    const p = g.parentId && ids.has(g.parentId) ? g.parentId : root.id;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(g);
  }
  for (const list of kids.values()) list.sort(byOrder);
  const labsAt = new Map<string, TreeBuilding[]>(), standsAt = new Map<string, string>();
  let hall: TreeBuilding | undefined;
  for (const b of [...buildings].sort(byOrder)) {
    if (b.kind === "town-hall") { hall ??= b; standsAt.set(b.id, root.id); continue; }
    const g = b.goalId && ids.has(b.goalId) ? b.goalId : root.id;
    standsAt.set(b.id, g);
    if (!labsAt.has(g)) labsAt.set(g, []);
    labsAt.get(g)!.push(b);
  }
  const labs = (id: string) => labsAt.get(id) ?? [];

  // the drawn tree: goals with a building under them; a goal with none of its own and one drawn child folds into it
  const drawn = new Map<string, TreeGoal[]>();
  const drawnKids = (id: string): TreeGoal[] => {
    const known = drawn.get(id);
    if (known) return known;
    const out: TreeGoal[] = [];
    for (const c of kids.get(id) ?? []) {
      const under = drawnKids(c.id);
      if (labs(c.id).length || under.length > 1) out.push(c);
      else out.push(...under);
    }
    drawn.set(id, out);
    return out;
  };

  if (shape === "radial") return radialLayout({ root, hall, labs, drawnKids, standsAt });
  if (shape === "fountain") return squareLayout({ root, hall, labs, drawnKids, standsAt });

  const rowW = (list: TreeBuilding[]) => list.reduce((s, b, i) => s + b.size.w + (i ? GAP : 0), 0);
  const kidsW = (id: string, depth: number) => drawnKids(id).reduce((s, c, i) => s + blockW(c.id, depth + 1) + (i ? GAP : 0), 0);
  /** a block: the goal's own buildings, then (with drawn children) the drop and its street over the children's blocks */
  const blockW = (id: string, depth: number): number => {
    const own = rowW(labs(id));
    return drawnKids(id).length ? own + (own ? GAP : 0) + 1 + kidsW(id, depth) : own;
  };

  const lots = new Map<string, Lot>();
  const plazas: Plaza[] = [];
  const edges = new Map<string, Tile[]>();
  /** lay a goal's block out with its left edge at x, hanging off the street on row y */
  const place = (g: TreeGoal, parentId: string, depth: number, x: number, y: number) => {
    let cx = x;
    for (const b of labs(g.id)) { lots.set(b.id, { x: cx, y: y + 1, w: b.size.w, h: b.size.h }); cx += b.size.w + GAP; }
    const children = drawnKids(g.id);
    if (!children.length) {
      const first = lots.get(labs(g.id)[0].id)!;
      plazas.push({ goalId: g.id, parentId, text: g.text, depth, pos: { x: first.x + Math.floor(first.w / 2), y }, street: null, sign: null, fountain: null });
      return;
    }
    const drop = cx, sy = y + 2, sw = x + blockW(g.id, depth) - drop;
    edges.set(g.id, [{ x: drop, y: y + 1 }]);
    plazas.push({ goalId: g.id, parentId, text: g.text, depth, pos: { x: drop + 1, y: sy }, street: { x: drop, y: sy, w: sw, h: 1 }, sign: { x: drop + 1, y: y + 1 }, fountain: null });
    // the children hang off the street
    let kx = drop + 1;
    for (const c of children) { place(c, g.id, depth + 1, kx, sy); kx += blockW(c.id, depth + 1) + GAP; }
  };

  // the root: the Town Hall above the main street, the Bank below it, then the root's own buildings and its children's blocks
  const hallSize = hall?.size ?? { w: 17, h: 11 };
  const sy = BANK_LOT.y - 1;
  const hallLot = { x: BANK_LOT.x, y: sy - hallSize.h, w: hallSize.w, h: hallSize.h };
  if (hall) lots.set(hall.id, hallLot);
  let cx = BANK_LOT.x + Math.max(BANK_LOT.w, hallSize.w) + GAP;
  for (const b of labs(root.id)) { lots.set(b.id, { x: cx, y: sy + 1, w: b.size.w, h: b.size.h }); cx += b.size.w + GAP; }
  for (const c of drawnKids(root.id)) { place(c, root.id, 1, cx, sy); cx += blockW(c.id, 1) + GAP; }
  const sign = { x: hallLot.x + hallLot.w + 1, y: sy - 1 };
  const x0 = BANK_LOT.x - 1;
  plazas.unshift({ goalId: root.id, parentId: null, text: root.text, depth: 0, pos: { x: sign.x, y: sy }, street: { x: x0, y: sy, w: Math.max(cx, sign.x + 2) - x0, h: 1 }, sign, fountain: null });
  return finish({ lots, standsAt, plazas, edges, bank: { ...BANK_LOT } });
}

/** The map's size: everything drawn, plus MARGIN of grass. */
export function finish(t: Omit<TreeLayout, "w" | "h">): TreeLayout {
  const rects = [...t.lots.values(), t.bank, ...t.plazas.flatMap((p) => (p.street ? [p.street] : [])), ...[...t.edges.values()].flat().map((e) => ({ ...e, w: 1, h: 1 })),
    ...(t.paving ?? []), ...(t.decor ?? []).map((d) => ({ ...d.at, w: 1, h: 1 }))];
  return { ...t, w: Math.max(...rects.map((r) => r.x + r.w)) + MARGIN, h: Math.max(...rects.map((r) => r.y + r.h)) + MARGIN };
}
