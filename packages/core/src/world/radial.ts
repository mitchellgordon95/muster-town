import { BANK_LOT, type Lot, type Tile } from "@muster-town/schema";
import { route } from "./road.ts";
import { finish, type Plaza, type TreeBuilding, type TreeGoal, type TreeLayout } from "./tree.ts";

/**
 * The "radial" shape of the map (mock mf_shxe83fsdq, 1:1 mt_q10xf3bkoq): the Town Hall in the middle with the Bank right
 * below it on a short street, a ring road around the two, and each first-level goal a spoke: its hub (a short road with
 * its signpost above) out from the ring at its own angle, the buildings under it on an arc beyond the hub. Roads on the
 * tile grid: each hub's road to the ring is routed (road.ts `route`), and deriveRoads routes every door to the nearest road.
 *
 * Spokes go clockwise from east, evenly spaced; a building is pushed out along its ray until it clears everything
 * placed before it. Pure: the same tree always gives the same map.
 */

/** Grass kept clear around every building and hub (room for the roads between them). */
const CLEAR = 2;
/** Hub and arc radii, in tiles (x wider than y: buildings are wider than tall). */
const HUB = { x: 22, y: 17 }, ARC = { x: 34, y: 25 };
/** A hub: its road's width, and room for its signpost's words above it. */
const HUB_W = 3, LABEL_W = 12;

interface Input {
  root: TreeGoal;
  hall: TreeBuilding | undefined;
  labs: (goalId: string) => TreeBuilding[];
  drawnKids: (goalId: string) => TreeGoal[];
  standsAt: Map<string, string>;
}

const hit = (a: Lot, b: Lot) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (l: Lot, d: number): Lot => ({ x: l.x - d, y: l.y - d, w: l.w + 2 * d, h: l.h + 2 * d });

export function radialLayout({ root, hall, labs, drawnKids, standsAt }: Input): TreeLayout {
  // the core: the Town Hall, a street under it (its door and the Bank's both on it), the Bank, and a ring around them
  const hs = hall?.size ?? { w: 17, h: 11 };
  const hallLot: Lot = { x: 0, y: 0, w: hs.w, h: hs.h };
  const bank: Lot = { x: 0, y: hs.h + 1, w: BANK_LOT.w, h: BANK_LOT.h };
  const core: Lot = { x: 0, y: 0, w: Math.max(hs.w, bank.w), h: bank.y + bank.h };
  const ring: Lot = grow(core, 2);
  const ringTiles: Tile[] = [];
  for (let x = ring.x; x < ring.x + ring.w; x++) ringTiles.push({ x, y: ring.y }, { x, y: ring.y + ring.h - 1 });
  for (let y = ring.y + 1; y < ring.y + ring.h - 1; y++) ringTiles.push({ x: ring.x, y }, { x: ring.x + ring.w - 1, y });
  const mid: Lot = { x: ring.x + 1, y: hs.h, w: ring.w - 2, h: 1 };
  const cx = core.x + core.w / 2, cy = core.y + core.h / 2;

  // the spokes: each first-level drawn goal, then each building of the root's own
  type Spoke = { goal: TreeGoal | null; buildings: TreeBuilding[] };
  const under = (id: string): TreeBuilding[] => [...labs(id), ...drawnKids(id).flatMap((c) => under(c.id))];
  const spokes: Spoke[] = [...drawnKids(root.id).map((g) => ({ goal: g, buildings: under(g.id) })), ...labs(root.id).map((b) => ({ goal: null, buildings: [b] }))];
  const n = Math.max(1, spokes.length);

  const taken: Lot[] = [grow(ring, CLEAR - 1)];
  /** push a w×h rect out along angle `a` from radius r until it clears everything taken; its lot */
  const settle = (w: number, h: number, a: number, r: { x: number; y: number }, pad: Lot = { x: 0, y: 0, w, h }): Lot => {
    for (let k = 1; ; k += 0.25) {
      const x = Math.round(cx + Math.cos(a) * r.x * k - w / 2), y = Math.round(cy + Math.sin(a) * r.y * k - h / 2);
      const box = { x: x + pad.x, y: y + pad.y, w: pad.w, h: pad.h };
      if (!taken.some((t) => hit(grow(box, CLEAR), t))) { taken.push(box); return { x, y, w, h }; }
    }
  };

  const lots = new Map<string, Lot>();
  if (hall) lots.set(hall.id, hallLot);
  const plazas: Plaza[] = [];
  const hubs: { id: string; at: Tile }[] = [];
  const rootSign = { x: core.x + core.w, y: mid.y - 1 };
  plazas.push({ goalId: root.id, parentId: null, text: root.text, depth: 0, pos: { x: rootSign.x, y: mid.y }, street: mid, sign: rootSign, fountain: null });
  spokes.forEach((s, i) => {
    const a = (2 * Math.PI * i) / n;
    if (s.goal) {
      // the hub: a short road, its signpost above its middle and the signpost's words above that
      const hub = settle(HUB_W, 1, a, HUB, { x: -1, y: -2, w: LABEL_W, h: 3 });
      const pos = { x: hub.x + 1, y: hub.y };
      plazas.push({ goalId: s.goal.id, parentId: root.id, text: s.goal.text, depth: 1, pos, street: hub, sign: { x: pos.x, y: pos.y - 1 }, fountain: null });
      hubs.push({ id: s.goal.id, at: pos });
    }
    // its buildings on an arc beyond the hub, spread over the spoke's share of the circle
    const spread = Math.min(Math.PI / 3, (2 * Math.PI) / n) * 0.8;
    s.buildings.forEach((b, j) => {
      const m = s.buildings.length;
      const lot = settle(b.size.w, b.size.h, a + (m > 1 ? spread * (j / (m - 1) - 0.5) : 0), ARC);
      lots.set(b.id, lot);
    });
  });
  // deeper drawn goals: their place is their first building's doorstep (the building's sign names the goal)
  const deeper = (g: TreeGoal, parentId: string, depth: number) => {
    for (const c of drawnKids(g.id)) {
      const first = [...under(c.id)][0];
      const l = lots.get(first.id)!;
      plazas.push({ goalId: c.id, parentId, text: c.text, depth, pos: { x: l.x + Math.floor(l.w / 2), y: l.y - 1 }, street: null, sign: null, fountain: null });
      deeper(c, c.id, depth + 1);
    }
  };
  for (const s of spokes) if (s.goal) deeper(s.goal, s.goal.id, 2);
  // a first-level goal that is only one building has a hub anyway (it is a spoke); standsAt stays the tree's

  // shift everything so the town starts MARGIN tiles in (signs and labels included)
  const all = [...lots.values(), bank, ring, ...plazas.flatMap((p) => (p.street ? [p.street] : [])), ...hubs.map((h) => ({ x: h.at.x - 1, y: h.at.y - 2, w: LABEL_W, h: 1 }))];
  const dx = 2 - Math.min(...all.map((r) => r.x)), dy = 2 - Math.min(...all.map((r) => r.y));
  const mv = <T extends Tile>(t: T): T => ({ ...t, x: t.x + dx, y: t.y + dy });
  for (const [id, l] of lots) lots.set(id, mv(l));
  const plazasAt = plazas.map((p) => ({ ...p, pos: mv(p.pos), street: p.street && mv(p.street), sign: p.sign && mv(p.sign) }));
  const edges = new Map<string, Tile[]>([[root.id, ringTiles.map(mv)]]);

  // each hub's road to the ring (or to a nearer road already laid), around every lot and signpost
  const sized = finish({ lots, standsAt, plazas: plazasAt, edges, bank: mv(bank) });
  const { w, h } = sized;
  const road = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const fill = (l: Lot, a: Uint8Array) => { for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) if (x >= 0 && y >= 0 && x < w && y < h) a[y * w + x] = 1; };
  for (const l of [...lots.values(), sized.bank]) fill(l, blocked);
  for (const p of plazasAt) if (p.sign) fill({ ...p.sign, w: 1, h: 1 }, blocked);
  for (const t of edges.get(root.id)!) road[t.y * w + t.x] = 1;
  fill(plazasAt[0].street!, road);
  for (const hb of hubs) {
    const p = plazasAt.find((x) => x.goalId === hb.id)!;
    const s = p.street!;
    // leave from the hub's end nearest the middle, heading for the ring
    const toward = s.x + 1 > cx + dx ? { x: s.x - 1, y: s.y, dir: 3 } : { x: s.x + s.w, y: s.y, dir: 2 };
    // the route starts on its first tile and stops short of the road it reaches
    const tiles = route({ x: toward.x, y: toward.y }, toward.dir, w, h, road.slice(), blocked) ?? [];
    for (const t of tiles) road[t.y * w + t.x] = 1;
    fill(s, road);
    edges.set(hb.id, tiles);
  }
  return sized;
}
