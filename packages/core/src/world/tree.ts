import { BANK_LOT, ROOT_GOAL_ID, type Lot, type Tile } from "@muster-town/schema";

/**
 * The map is the goal tree (docs/goals.md "The map is the tree", build step 2). Nobody places buildings: `treeLayout`
 * computes every lot and plaza from the tree, and `computeLayout` draws them.
 *
 * - The Town Hall stands at the root, above the root plaza; the Bank (fixed, `BANK_LOT`) stands below it.
 * - Each goal is a plaza: a strip of road two tiles tall with a signpost (TILE.SIGNPOST) at its right end.
 * - A building attached to a goal hangs below that goal's plaza, its door in the top wall on the plaza. A goal with no
 *   building is an empty plaza (its signpost shows the gap).
 * - A goal's children hang below its cluster, left to right in a fixed order (`position`, then `createdAt`, then id).
 *   Each subtree owns a band of columns, rounded up to BAND_STEP: the round-up is the band's slack, so a new child
 *   usually fits and nothing moves; when it doesn't, only the bands to its right shift. Earlier (left) bands never move.
 * - Roads are the tree's edges (`edges`), drawn like an org chart: a trunk down the parent's corridor, a bus along the
 *   row above its children, a short drop onto each child's plaza. The layout keeps those tiles free, so no search is needed.
 *
 * Pure: the same tree always gives the same map.
 */

/** Rows of a plaza strip. */
const PLAZA_H = 2;
/** Columns left of a goal's buildings, kept free so its children's roads reach the plaza. */
const CORRIDOR = 3;
/** Grass between two buildings on one plaza. */
const LOT_GAP = 2;
/** Width of an empty goal's plaza. */
const EMPTY_W = 4;
/** Rows between a cluster's bottom and its children's plazas (a road row with grass either side). */
const V_GAP = 3;
/** Grass after each band, before the next sibling's. */
const H_GAP = 3;
/** Bands are rounded up to a multiple of this: the slack that lets a new child fit without moving anything. */
export const BAND_STEP = 8;
/** x where the root's children band starts. */
const LEFT = 2;

export interface TreeGoal { id: string; parentId: string | null; text: string; position: number; createdAt: string }
export interface TreeBuilding { id: string; kind: "lab" | "town-hall"; goalId?: string | null; createdAt: string; size: { w: number; h: number } }
export interface Plaza {
  goalId: string;
  parentId: string | null;
  text: string;
  depth: number;
  /** the road strip */
  rect: Lot;
  /** the signpost tile (right of the strip, on its top row) */
  sign: Tile;
}
export interface TreeLayout {
  lots: Map<string, Lot>;
  /** the goal each building stands at (the root for the Town Hall and for one attached to no drawn goal) */
  standsAt: Map<string, string>;
  plazas: Plaza[];
  /** per non-root goal: the road from just above its plaza to its parent's plaza (drop, bus, trunk), first tile first */
  edges: Map<string, Tile[]>;
  w: number;
  h: number;
}

const byOrder = <T extends { createdAt: string; id: string }>(a: T & { position?: number }, b: T & { position?: number }) =>
  (a.position ?? 0) - (b.position ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function treeLayout(goals: TreeGoal[], buildings: TreeBuilding[]): TreeLayout {
  const ids = new Set(goals.map((g) => g.id));
  const root = goals.find((g) => g.id === ROOT_GOAL_ID) ?? goals.find((g) => !g.parentId) ?? { id: ROOT_GOAL_ID, parentId: null, text: "", position: 0, createdAt: "" };
  const kids = new Map<string, TreeGoal[]>();
  for (const g of goals) {
    if (g.id === root.id) continue;
    // a goal whose parent isn't drawn hangs off the root, so nothing is lost off the map
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
  const rowW = (list: TreeBuilding[]) => list.reduce((s, b, i) => s + b.size.w + (i ? LOT_GAP : 0), 0);
  const clusterW = (id: string) => (labs(id).length ? CORRIDOR + rowW(labs(id)) : EMPTY_W);
  const clusterH = (id: string) => PLAZA_H + Math.max(0, ...labs(id).map((b) => b.size.h));
  const band = new Map<string, number>();
  const bandW = (id: string): number => {
    const known = band.get(id);
    if (known !== undefined) return known;
    const children = (kids.get(id) ?? []).reduce((s, c) => s + bandW(c.id), 0);
    const w = Math.ceil((Math.max(clusterW(id) + 1, children) + H_GAP) / BAND_STEP) * BAND_STEP;
    band.set(id, w);
    return w;
  };

  const lots = new Map<string, Lot>();
  const plazas: Plaza[] = [];
  const edges = new Map<string, Tile[]>();
  /** the road from child plaza `c` (top-left at cx, cy) to its parent's plaza: up to the bus, along it to the trunk, up the trunk */
  const edge = (id: string, cx: number, cy: number, trunkX: number, plazaBottom: number) => {
    const out: Tile[] = [], busY = cy - 2;
    for (let y = cy - 1; y >= busY; y--) out.push({ x: cx + 1, y });
    for (let x = cx + 1; x !== trunkX;) { x += x < trunkX ? 1 : -1; out.push({ x, y: busY }); }
    for (let y = busY - 1; y > plazaBottom; y--) out.push({ x: trunkX, y });
    edges.set(id, out);
  };
  const hang = (list: TreeBuilding[], x: number, y: number) => {
    for (const b of list) { lots.set(b.id, { x, y, w: b.size.w, h: b.size.h }); x += b.size.w + LOT_GAP; }
  };
  const place = (g: TreeGoal, depth: number, x: number, y: number) => {
    const w = clusterW(g.id);
    plazas.push({ goalId: g.id, parentId: g.parentId && ids.has(g.parentId) ? g.parentId : root.id, text: g.text, depth, rect: { x, y, w, h: PLAZA_H }, sign: { x: x + w, y } });
    hang(labs(g.id), x + CORRIDOR, y + PLAZA_H);
    let cx = x;
    const cy = y + clusterH(g.id) + V_GAP;
    for (const c of kids.get(g.id) ?? []) { place(c, depth + 1, cx, cy); edge(c.id, cx, cy, x + 1, y + PLAZA_H - 1); cx += bandW(c.id); }
  };

  // the root: the Town Hall above its plaza, the Bank below it, the root's other buildings right of the Bank
  const hallSize = hall?.size ?? { w: 17, h: 11 };
  const py = BANK_LOT.y - PLAZA_H;
  if (hall) lots.set(hall.id, { x: BANK_LOT.x, y: py - hallSize.h, w: hallSize.w, h: hallSize.h });
  const rootLabs = labs(root.id);
  hang(rootLabs, BANK_LOT.x + BANK_LOT.w + LOT_GAP, BANK_LOT.y);
  const x0 = BANK_LOT.x - CORRIDOR - 1;
  const right = Math.max(BANK_LOT.x + hallSize.w, BANK_LOT.x + BANK_LOT.w, ...rootLabs.map((b) => lots.get(b.id)!.x + b.size.w));
  plazas.push({ goalId: root.id, parentId: null, text: root.text, depth: 0, rect: { x: x0, y: py, w: right - x0, h: PLAZA_H }, sign: { x: right, y: py } });
  const bottom = Math.max(BANK_LOT.y + BANK_LOT.h, ...rootLabs.map((b) => BANK_LOT.y + b.size.h));
  let cx = LEFT;
  for (const c of kids.get(root.id) ?? []) { place(c, 1, cx, bottom + V_GAP); edge(c.id, cx, bottom + V_GAP, x0 + 1, py + PLAZA_H - 1); cx += bandW(c.id); }

  const rects = [...lots.values(), BANK_LOT as Lot, ...plazas.map((p) => ({ ...p.rect, w: p.rect.w + 1 }))];
  return {
    lots, standsAt, plazas, edges,
    w: Math.max(64, ...rects.map((r) => r.x + r.w + 3)),
    h: Math.max(...rects.map((r) => r.y + r.h + 3)),
  };
}
