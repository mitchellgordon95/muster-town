import { BANK_FIXTURES, BANK_LOT, TILE, type Lot, type Tile } from "@muster-town/schema";
import type { ShapeInput } from "./radial.ts";
import { doorstepOf, type Side } from "./road.ts";
import { finish, type Plaza, type TreeBuilding, type TreeGoal, type TreeLayout } from "./tree.ts";

/**
 * The "fountain" shape of the map: a planned town (1:1 mt_3ldf9p5av1, "a nicely planned-out town that actually feels
 * like a town"). In the middle, a paved square with a fountain: the Town Hall on its north side, the Bank on its south
 * side, both doors on the square. A main street runs east and west through the square. Each first-level goal is a
 * district: a cross street (an avenue) off the main street, its buildings on both sides of it, back to back up and
 * down the avenue, every door facing the avenue (left column east, right column west). Districts alternate east and
 * west of the square, with a strip of park between them. Trees, lamps, benches and flower beds dress it.
 *
 * Each district's signpost stands at the corner of its avenue and the main street; deeper goals have no signpost (their
 * place is their first building's doorstep; the building's sign names the goal). Pure: the same tree always gives the
 * same map.
 */

/** The square's paving: rows tall, and how far it reaches past the Town Hall on each side. */
const SQ_H = 9, SQ_PAD = 4;
/** The main street's rows (from the square's fourth row) and an avenue's width. */
const MAIN_H = 2, AVE_W = 2;
/** Grass between the main street and the first building up or down an avenue (room for a signpost and its words). */
const SETBACK = 2;
/** Grass between buildings stacked along an avenue. */
const GAP = 1;
/** The park between two districts, and the main street's run past the last ones. */
const PARK = 5, END = 3;
/** Grass round the town, inside the map's own margin. */
const EDGE = 2;

type Col = { up: TreeBuilding[]; down: TreeBuilding[] };
interface District { goal: TreeGoal | null; buildings: TreeBuilding[]; l: Col; r: Col; lw: number; rw: number }

export function squareLayout({ root, hall, labs, drawnKids, standsAt }: ShapeInput): TreeLayout {
  const hs = hall?.size ?? { w: 17, h: 11 };
  const sqW = Math.max(hs.w, BANK_LOT.w) + 2 * SQ_PAD;
  const hallLot: Lot = { x: Math.floor((sqW - hs.w) / 2), y: 0, w: hs.w, h: hs.h };
  const square: Lot = { x: 0, y: hs.h, w: sqW, h: SQ_H };
  const bank: Lot = { x: Math.floor((sqW - BANK_LOT.w) / 2), y: square.y + SQ_H, w: BANK_LOT.w, h: BANK_LOT.h };
  const mainY = square.y + 3;
  // the fountain: three by three, under the Town Hall's door
  const doorX = hallLot.x + Math.floor(hs.w / 2);
  const fountain: Lot = { x: doorX - 1, y: mainY, w: 3, h: 3 };

  // the districts: each first-level drawn goal with every building under it, then the root's own buildings
  const under = (id: string): TreeBuilding[] => [...labs(id), ...drawnKids(id).flatMap((c) => under(c.id))];
  const groups: { goal: TreeGoal | null; buildings: TreeBuilding[] }[] = [
    ...drawnKids(root.id).map((g) => ({ goal: g, buildings: under(g.id) })),
    ...(labs(root.id).length ? [{ goal: null, buildings: labs(root.id) }] : []),
  ].filter((d) => d.buildings.length);
  const districts: District[] = groups.map(({ goal, buildings }) => {
    // slots in turn: left up, right up, left down, right down, then the next row out
    const l: Col = { up: [], down: [] }, r: Col = { up: [], down: [] };
    buildings.forEach((b, i) => [l.up, r.up, l.down, r.down][i % 4].push(b));
    const width = (c: Col) => Math.max(0, ...[...c.up, ...c.down].map((b) => b.size.w));
    return { goal, buildings, l, r, lw: width(l), rw: width(r) };
  });

  const lots = new Map<string, Lot>();
  if (hall) lots.set(hall.id, hallLot);
  const sides = new Map<string, Side>();
  if (hall) sides.set(hall.id, "s");
  const plazas: Plaza[] = [];
  const edges = new Map<string, Tile[]>();
  const signs: Tile[] = [];

  // lay the districts out, alternately east and west of the square
  let east = sqW + PARK, west = -PARK;
  districts.forEach((d, i) => {
    const w = d.lw + AVE_W + d.rw;
    const x0 = i % 2 === 0 ? east : west - w;
    if (i % 2 === 0) east += w + PARK; else west -= w + PARK;
    const ax = x0 + d.lw;
    let top = mainY, bottom = mainY + MAIN_H;
    const stack = (col: TreeBuilding[], left: boolean, up: boolean) => {
      let y = up ? mainY - SETBACK : mainY + MAIN_H + SETBACK;
      for (const b of col) {
        const lot = { x: left ? ax - b.size.w : ax + AVE_W, y: up ? y - b.size.h : y, w: b.size.w, h: b.size.h };
        lots.set(b.id, lot);
        sides.set(b.id, left ? "e" : "w");
        y = up ? lot.y - GAP : lot.y + lot.h + GAP;
        top = Math.min(top, lot.y); bottom = Math.max(bottom, lot.y + lot.h);
      }
    };
    stack(d.l.up, true, true); stack(d.r.up, false, true); stack(d.l.down, true, false); stack(d.r.down, false, false);
    const avenue: Tile[] = [];
    for (let y = top; y < bottom; y++) for (let x = ax; x < ax + AVE_W; x++) if (y < mainY || y >= mainY + MAIN_H) avenue.push({ x, y });
    if (d.goal) {
      // the district's signpost on the corner of its avenue and the main street, its words above it
      const sign = { x: ax - 1, y: mainY - 1 };
      signs.push(sign);
      plazas.push({ goalId: d.goal.id, parentId: root.id, text: d.goal.text, depth: 1, pos: { x: sign.x, y: mainY }, street: null, sign, fountain: null });
      edges.set(d.goal.id, avenue);
    } else edges.set(`${root.id}:own`, avenue);
  });
  // deeper drawn goals: their place is their first building's doorstep
  const deeper = (g: TreeGoal, depth: number) => {
    for (const c of drawnKids(g.id)) {
      const first = under(c.id)[0];
      plazas.push({ goalId: c.id, parentId: g.id, text: c.text, depth, pos: doorstepOf(lots.get(first.id)!, sides.get(first.id)!), street: null, sign: null, fountain: null });
      deeper(c, depth + 1);
    }
  };
  for (const d of districts) if (d.goal) deeper(d.goal, 2);

  // the main street, from the west end to the east end; the root's signpost in the square's top-left corner
  const mainX = Math.min(0, west + PARK) - END, mainW = Math.max(sqW, east - PARK) + END - mainX;
  const rootSign = { x: square.x + 2, y: square.y + 1 };
  signs.push(rootSign);
  plazas.unshift({ goalId: root.id, parentId: null, text: root.text, depth: 0, pos: { x: rootSign.x, y: rootSign.y + 1 }, street: { x: mainX, y: mainY, w: mainW, h: MAIN_H }, sign: rootSign, fountain });

  const decor = dress({ hallLot, square, bank, fountain, mainY, mainX, mainW, lots, edges, signs, plazas });

  // shift everything so the town starts EDGE tiles in from the map's margin
  const all = [...lots.values(), bank, square, ...decor.map((d) => ({ ...d.at, w: 1, h: 1 })), { x: mainX, y: mainY, w: mainW, h: MAIN_H }, ...[...edges.values()].flat().map((t) => ({ ...t, w: 1, h: 1 }))];
  const dx = EDGE - Math.min(...all.map((r) => r.x)), dy = EDGE - Math.min(...all.map((r) => r.y));
  const mv = <T extends Tile>(t: T): T => ({ ...t, x: t.x + dx, y: t.y + dy });
  for (const [id, l] of lots) lots.set(id, mv(l));
  for (const [id, e] of edges) edges.set(id, e.map(mv));
  return finish({
    lots, standsAt, edges, sides, bank: mv(bank), paving: [mv(square)],
    plazas: plazas.map((p) => ({ ...p, pos: mv(p.pos), street: p.street && mv(p.street), sign: p.sign && mv(p.sign), fountain: p.fountain && mv(p.fountain) })),
    decor: decor.map((d) => ({ ...d, at: mv(d.at) })),
  });
}

/**
 * The town's dressing: lamps and benches round the square and flower beds along the Town Hall, lamps along the main
 * street, trees in the parks and round the edge. Only on tiles nothing else uses, never next to a door, a signpost or
 * a goal's place, and never touching another tree.
 */
function dress(t: { hallLot: Lot; square: Lot; bank: Lot; fountain: Lot; mainY: number; mainX: number; mainW: number; lots: Map<string, Lot>; edges: Map<string, Tile[]>; signs: Tile[]; plazas: Plaza[] }): { at: Tile; tile: number }[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const used = new Set<string>(), keepClear = new Set<string>();
  const mark = (l: Lot, s: Set<string>, grow = 0) => { for (let y = l.y - grow; y < l.y + l.h + grow; y++) for (let x = l.x - grow; x < l.x + l.w + grow; x++) s.add(key(x, y)); };
  for (const l of [...t.lots.values(), t.bank, t.hallLot]) mark(l, used);
  mark(t.fountain, used);
  mark({ x: t.mainX, y: t.mainY, w: t.mainW, h: MAIN_H }, used);
  for (const e of t.edges.values()) for (const p of e) used.add(key(p.x, p.y));
  for (const s of t.signs) mark({ ...s, w: 1, h: 1 }, keepClear, 1);
  for (const p of t.plazas) mark({ ...p.pos, w: 1, h: 1 }, keepClear, 1);
  // every door's doorstep and the walk from the Town Hall and the Bank to the fountain stay clear
  const doorX = t.fountain.x + 1;
  mark({ x: doorX - 1, y: t.square.y, w: 3, h: t.square.h }, keepClear);
  mark({ x: t.bank.x + BANK_FIXTURES.door.x - 1, y: t.bank.y - 2, w: 3, h: 2 }, keepClear);
  // the lawn right of the Bank holds its marquee (web renderer.ts)
  mark({ x: t.bank.x + t.bank.w, y: t.bank.y, w: 8, h: 7 }, keepClear);

  const out: { at: Tile; tile: number }[] = [];
  const free = (x: number, y: number) => !used.has(key(x, y)) && !keepClear.has(key(x, y));
  const put = (x: number, y: number, tile: number) => { if (!free(x, y)) return false; out.push({ at: { x, y }, tile }); used.add(key(x, y)); return true; };

  // the square: a lamp in each corner, benches facing the fountain from either side, flower beds along the Town Hall
  const { x: sx, y: sy, w: sw, h: sh } = t.square;
  for (const [x, y] of [[sx + 1, sy + 1], [sx + sw - 2, sy + 1], [sx + 1, sy + sh - 2], [sx + sw - 2, sy + sh - 2]]) put(x, y, TILE.LAMP);
  for (const y of [sy + 1, sy + sh - 2]) for (const x of [doorX - 6, doorX - 5, doorX + 5, doorX + 6]) put(x, y, TILE.BENCH);
  for (const x of [doorX - 4, doorX - 3, doorX + 3, doorX + 4]) put(x, sy, TILE.FLOWERS);

  // lamps along both sides of the main street, every LAMP_EVERY tiles
  const LAMP_EVERY = 6;
  for (let x = t.mainX + 1; x < t.mainX + t.mainW; x += LAMP_EVERY) {
    if (x >= sx - 1 && x <= sx + sw) continue;
    put(x, t.mainY - 1, TILE.LAMP); put(x, t.mainY + MAIN_H, TILE.LAMP);
  }

  // trees: on grass two tiles clear of every building and road, none touching another; a tree every few tiles
  const all = [...t.lots.values(), t.bank, t.square, { x: t.mainX, y: t.mainY, w: t.mainW, h: MAIN_H }];
  const x0 = Math.min(...all.map((l) => l.x)) - EDGE, y0 = Math.min(...all.map((l) => l.y)) - EDGE;
  const x1 = Math.max(...all.map((l) => l.x + l.w)) + EDGE, y1 = Math.max(...all.map((l) => l.y + l.h)) + EDGE;
  const near = new Set<string>();
  for (const l of all) mark(l, near, 1);
  for (const e of t.edges.values()) for (const p of e) mark({ ...p, w: 1, h: 1 }, near, 1);
  const trees = new Set<string>();
  // a fixed scatter: the same map always gets the same trees
  const hash = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) % 100;
  };
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (near.has(key(x, y)) || hash(x, y) >= 30) continue;
    let touching = false;
    for (let dy = -1; dy <= 1 && !touching; dy++) for (let dx = -1; dx <= 1; dx++) if (trees.has(key(x + dx, y + dy))) { touching = true; break; }
    if (touching) continue;
    if (put(x, y, TILE.TREE)) trees.add(key(x, y));
  }
  return out;
}
