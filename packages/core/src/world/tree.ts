import { BANK_LOT, ROOT_GOAL_ID, type Lot, type MapLayout, type Tile } from "@muster-town/schema";
import { radialLayout } from "./radial.ts";
import type { Side } from "./road.ts";
import { squareLayout } from "./square.ts";

/**
 * The map is the goal tree (docs/goals.md "The map is the tree", build step 2). Nobody places buildings: `treeLayout`
 * computes every lot and street from the tree, and `computeLayout` draws them. Packed so it reads as a town
 * (Mitchell, 1:1 mt_wql34b8gkl): no lot for a goal without buildings, no plaza per building, one tile of grass between neighbours.
 *
 * - The Town Hall stands at the root in the middle of the town, above the main street (a road one tile tall); the Bank
 *   right below it (`BANK_LOT`'s row and size, its column under the Town Hall).
 * - Only goals with a building somewhere under them draw. A goal with no building of its own and one drawn child folds
 *   into that child (a chain is one step, not a long walk); with two or more it is a junction.
 * - A building stands right on the street of its goal's parent, its door in its top wall on that street. A goal's own
 *   buildings come first, left to right in a fixed order (`position`, then `createdAt`, then id).
 * - Symmetric (1:1 mt_cyd2t5ioob): along the main street the root's buildings and its children's blocks keep that order
 *   but split round the Town Hall and Bank so each side is about as wide (`halves`); the narrower side gets grass, so
 *   the Town Hall stands in the middle of the map.
 * - A goal with drawn children gets a street of its own, one row below its parent's, right after the goal's own
 *   buildings: a one-tile road drops to it from the parent's street, and the children's blocks hang off it, split
 *   round the drop the same way.
 *   Its signpost (TILE.SIGNPOST) stands beside the drop, the goal's place (`plaza:<goalId>`) on the street below it.
 *   A goal without children needs no signpost: its buildings' signs name it.
 * - Blocks sit side by side with one tile of grass between them; adding a building keeps every block's order (it can
 *   move a block across the Town Hall or a drop when the balance shifts).
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
  /** a block: the goal's own buildings, then (with drawn children) its street over the children's blocks, split round the drop */
  const blockW = (id: string): number => {
    const own = rowW(labs(id));
    const children = drawnKids(id);
    if (!children.length) return own;
    const [left, right] = halves(children.map((c) => blockW(c.id)));
    return own + (own ? GAP : 0) + (left ? left + GAP : 0) + 1 + right;
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
    // the children's blocks hang off the street, as many tiles each side of the drop as the order allows
    const widths = children.map((c) => blockW(c.id));
    const [left, , k] = halves(widths);
    const sx = cx, drop = sx + (left ? left + GAP : 0), sy = y + 2, sw = x + blockW(g.id) - sx;
    edges.set(g.id, [{ x: drop, y: y + 1 }]);
    plazas.push({ goalId: g.id, parentId, text: g.text, depth, pos: { x: drop + 1, y: sy }, street: { x: sx, y: sy, w: sw, h: 1 }, sign: { x: drop + 1, y: y + 1 }, fountain: null });
    let kx = sx;
    children.forEach((c, i) => {
      if (i === k) kx = drop + 1;
      place(c, g.id, depth + 1, kx, sy);
      kx += widths[i] + GAP;
    });
  };

  // the root: the Town Hall in the middle above the main street, the Bank right below it; the root's own buildings and its
  // children's blocks keep their order along the main street, split round the Bank so each side is about as wide
  // (Mitchell, 1:1 mt_cyd2t5ioob: "the townhall and bank should be in the top middle"); the narrower side gets grass
  const hallSize = hall?.size ?? { w: 17, h: 11 };
  const x0 = MARGIN - 1, sy = BANK_LOT.y - 1;
  const items: { w: number; put: (x: number) => void }[] = [
    ...labs(root.id).map((b) => ({ w: b.size.w, put: (x: number) => lots.set(b.id, { x, y: sy + 1, w: b.size.w, h: b.size.h }) })),
    ...drawnKids(root.id).map((c) => ({ w: blockW(c.id), put: (x: number) => place(c, root.id, 1, x, sy) })),
  ];
  const [left, right, k] = halves(items.map((i) => i.w));
  const core = Math.max(BANK_LOT.w, hallSize.w);
  const side = Math.max(left, right) + GAP;
  const mid = MARGIN + side; // the core's left edge
  const hallLot = { x: mid + Math.floor((core - hallSize.w) / 2), y: sy - hallSize.h, w: hallSize.w, h: hallSize.h };
  const bank = { ...BANK_LOT, x: hallLot.x + Math.floor((hallSize.w - BANK_LOT.w) / 2) };
  if (hall) lots.set(hall.id, hallLot);
  let cx = mid - GAP - left;
  items.forEach((it, i) => {
    if (i === k) cx = mid + core + GAP;
    it.put(cx);
    cx += it.w + GAP;
  });
  const sign = { x: hallLot.x + hallLot.w + 1, y: sy - 1 };
  // the main street runs the whole width, so the town reads the same either side of the Town Hall
  const end = mid + core + side;
  plazas.unshift({ goalId: root.id, parentId: null, text: root.text, depth: 0, pos: { x: sign.x, y: sy }, street: { x: x0, y: sy, w: Math.max(end + 1, sign.x + 2) - x0, h: 1 }, sign, fountain: null });
  return finish({ lots, standsAt, plazas, edges, bank });
}

/**
 * Split a row of widths, in order, into a left part (the first k) and a right part so the two are as even as can be
 * (ties go right, so a lone block stands right of its drop). Widths include the grass between neighbours.
 */
function halves(widths: number[]): [left: number, right: number, k: number] {
  const run = (a: number[]) => a.reduce((s, w, i) => s + w + (i ? GAP : 0), 0);
  let best: [number, number, number] = [0, run(widths), 0];
  for (let k = 1; k <= widths.length; k++) {
    const l = run(widths.slice(0, k)), r = run(widths.slice(k));
    if (Math.abs(l - r) < Math.abs(best[0] - best[1])) best = [l, r, k];
  }
  return best;
}

/** The map's size: everything drawn, plus MARGIN of grass. */
export function finish(t: Omit<TreeLayout, "w" | "h">): TreeLayout {
  const rects = [...t.lots.values(), t.bank, ...t.plazas.flatMap((p) => (p.street ? [p.street] : [])), ...[...t.edges.values()].flat().map((e) => ({ ...e, w: 1, h: 1 })),
    ...(t.paving ?? []), ...(t.decor ?? []).map((d) => ({ ...d.at, w: 1, h: 1 }))];
  return { ...t, w: Math.max(...rects.map((r) => r.x + r.w)) + MARGIN, h: Math.max(...rects.map((r) => r.y + r.h)) + MARGIN };
}
