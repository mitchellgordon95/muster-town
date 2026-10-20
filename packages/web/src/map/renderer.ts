/**
 * Canvas 2D town renderer. Owns the rAF loop, camera, the human's client-side movement,
 * interpolation of other bodies between `agents.pos` updates, and proximity targeting.
 */
import type { Agent, Place } from "@muster-town/schema";
import { store, type PanelRef, isManager, roleOf } from "../state";
import { World } from "./world";
import { authStore } from "../auth/auth";
import { T, CHAR_W, CHAR_H, charSheet, tiles, HUMAN_SPRITE } from "./sprites";
import { layoutEdit, type LayoutDraft } from "./layoutEdit";
import { townPlan, type PlanDraft } from "./townPlan";
import { bubbleFor, buildingBudgetLine, drawBadge, drawBankSign, drawBubble, drawLabel, drawPill, drawSign, residentBudgetLine, type Bubble } from "./overlay";
import { blockedByRedeploy } from "../redeploy";
import { api } from "../api";
import { drawFlow, type Flow } from "./flow";
import { fitZoom, quickWalkGoal } from "./overview";
import { TILE } from "@muster-town/schema";

/** `index`/`count`: position among everything in reach, so the HUD can show "Tab 2/3" when targets overlap. */
const keyOf = (t: Target) => `${t.panel.kind}:${t.panel.id ?? ""}:${t.label}`;

/** `action: "flow"`: E opens the Bank's town map (the zoomed-out coin flow) instead of a panel. */
export interface Target { label: string; panel: PanelRef; agentId?: string; index?: number; count?: number; action?: "flow" }
interface Body { x: number; y: number; fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; moving: boolean; key: string }

const SPEED = 5 * T; // px per second
/** auto-walk (walkTo) speed: a bit faster than the keys so a notice doesn't take forever */
const ROUTE_SPEED = 11 * T;
const INTERACT_PX = 26;
const bname = (p: Place) => store.state.buildings.find((b) => b.id === p.buildingId)?.name ?? "the building";
/** Every panel is a place: what E opens when you stand at each place kind. */
export const PLACE_PANEL: Partial<Record<Place["kind"], (p: Place) => PanelRef & { verb: string }>> = {
  board: (p) => ({ kind: "board", id: p.buildingId ?? undefined, verb: `Read the ${bname(p)} board` }),
  cabinet: (p) => ({ kind: "cabinet", id: p.buildingId ?? undefined, verb: `Open the ${bname(p)} filing cabinet` }),
  intray: (p) => {
    const n = store.state.buildings.find((b) => b.id === p.buildingId)?.intray ?? 0;
    return { kind: "intray", id: p.buildingId ?? undefined, verb: `Check the in-tray${n ? ` (${n} waiting)` : ""}` };
  },
  planning: () => ({ kind: "planning", verb: "Use the planning desk" }),
  schedule: () => ({ kind: "schedule", verb: "Read the meeting schedule" }),
  "mod-station": () => ({ kind: "mod", verb: "Visit the mod station" }),
  library: () => ({ kind: "library", verb: "Browse the library" }),
  "trophy-room": () => ({ kind: "trophy", verb: "Visit the trophy room" }),
  outbox: () => ({ kind: "outbox", verb: "Check the outbox" }),
  bank: () => ({ kind: "bank", verb: "Visit the Bank" }),
  "meeting-room": (p) => ({ kind: "meeting", id: `room:${p.buildingId ?? ""}`, verb: `Join the ${p.name.toLowerCase()}` }),
  door: (p) => ({ kind: "building", id: p.buildingId ?? undefined, verb: `Enter ${p.name.replace(/^door( of|:)?\s*/i, "") || "building"}` }),
};

export class MapRenderer {
  private g: CanvasRenderingContext2D;
  private world: World | null = null;
  private gridKey = "";
  private bodies = new Map<string, Body>();
  private me = { x: 0, y: 0, placed: false, moving: false, lastTile: "" };
  /** auto-walk: remaining tiles, and what to do on arrival */
  private route: { x: number; y: number }[] | null = null;
  private onArrive: (() => void) | null = null;
  private keys = new Set<string>();
  private cam = { x: 0, y: 0, init: false };
  zoom = 3;
  /** the zoom actually drawn: eases toward `zoom`, or toward the whole-town fit while the Bank's town map is open */
  private z = 0;
  /** the Bank's town map, while it's open */
  flow: Flow | null = null;
  panelInset = 0;
  leftInset = 330;
  private grass: CanvasPattern | null = null;
  private raf = 0;
  private last = performance.now();
  private target: Target | null = null;
  /** Key of the target picked with Tab; kept while it stays in reach, otherwise the nearest wins again. */
  private picked: string | null = null;
  private inReach: Target[] = [];
  private lastSent = 0;
  private pendingTile: { x: number; y: number } | null = null;
  private hitboxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  hoverId: string | null = null;
  /** last frame's camera, for screen -> tile */
  private view = { ox: 0, oy: 0, z: 3 };
  onTarget?: (t: Target | null) => void;
  onMove?: (x: number, y: number) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }
  destroy() { cancelAnimationFrame(this.raf); }

  keyDown(k: string) { this.keys.add(k); }
  keyUp(k: string) { this.keys.delete(k); }
  clearKeys() { this.keys.clear(); }
  get currentTarget() { return this.target; }
  /** Step to the next (or previous) target in reach. Returns false when there is nothing to cycle. */
  cycleTarget(dir: 1 | -1 = 1): boolean {
    const n = this.inReach.length;
    if (n < 2) return false;
    // step from what the hint shows now (the nearest, until something is picked)
    const cur = this.picked ?? (this.target ? keyOf(this.target) : null);
    const i = Math.max(0, this.inReach.findIndex((t) => keyOf(t) === cur));
    this.picked = keyOf(this.inReach[(i + dir + n) % n]);
    this.updateTarget();
    return true;
  }

  /** Open the Bank's town map: zoom out to the whole town and stream the Bank's coins to each building. */
  openFlow() {
    const flow: Flow = { t0: performance.now(), bank: null, error: null };
    this.flow = flow;
    this.route = null; this.onArrive = null;
    api().bank().then((b) => { flow.bank = b; }, (e) => { flow.error = e instanceof Error ? e.message : String(e); });
  }
  closeFlow() { this.flow = null; }
  /** The zoomed-out whole-town view: the Bank's town map and town planning share one camera. */
  overview(): boolean { return !!this.flow || !!townPlan.draft; }

  /** Dev hook: put the avatar next to an agent and face it. */
  teleportTo(agentId: string): boolean {
    const a = store.state.agents[agentId];
    if (!a || !this.world) return false;
    const p = store.livePos.get(agentId) ?? a.pos;
    const ax = Math.round(p.x), ay = Math.round(p.y);
    const opts = [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [0, -1]];
    const spot = opts.map(([dx, dy]) => ({ x: ax + dx, y: ay + dy })).find((t) => this.world!.walkable(t.x, t.y)) ?? this.world.nearestWalkable(ax, ay);
    this.placeMe(spot.x, spot.y);
    return true;
  }
  /**
   * Walk the avatar to a place along a path (teleport if there is none, or it's very long), then open `panel`.
   * Arrow keys cancel the walk.
   */
  walkToPlace(placeId: string, panel?: PanelRef): boolean {
    const p = store.state.places.find((x) => x.id === placeId);
    if (!p || !this.world) return false;
    const goal = this.world.walkable(p.pos.x, p.pos.y) ? p.pos : this.world.nearestWalkable(p.pos.x, p.pos.y);
    this.walkRoute(goal, () => { if (panel) store.open(panel); });
    return true;
  }
  /**
   * Quick-walk (the minimap's click) to a tile: there if it's reachable; a building's wall walks to its door
   * (the Bank's: its counter); anything else unreachable walks to the reachable tile nearest it.
   */
  walkToTile(x: number, y: number): boolean {
    const w = this.world;
    if (!w || layoutEdit.draft) return false;
    if (this.flow) this.closeFlow();
    const s = store.state, b = w.buildingAt(x, y);
    const door = w.at(x, y) !== TILE.WALL ? undefined
      : b ? s.places.find((p) => p.kind === "door" && p.buildingId === b.id)
      : w.inBank(x, y) ? s.places.find((p) => p.kind === "bank") : undefined;
    this.walkRoute(quickWalkGoal(w, this.myTile(), { x, y }, door?.pos ?? null), () => undefined);
    return true;
  }
  private myTile() { return { x: Math.floor(this.me.x / T), y: Math.floor((this.me.y - 1) / T) }; }
  /** Walk along a path to `goal`, then `arrive`; teleport when there's no path or it's very long. */
  private walkRoute(goal: { x: number; y: number }, arrive: () => void) {
    const path = this.world!.path(this.myTile(), goal);
    if (!path || path.length > 140 || !path.length) { this.route = null; this.onArrive = null; this.placeMe(goal.x, goal.y); arrive(); return; }
    this.route = path; this.onArrive = arrive;
  }

  /** For the minimap: the world, where I am, everyone else, and what the main view shows (world px). */
  get town(): World | null { return this.world; }
  get mePos() { return { x: this.me.x, y: this.me.y }; }
  /** The route's end tile, while auto-walking. */
  get routeEnd() { return this.route?.length ? this.route[this.route.length - 1] : null; }
  others(): { x: number; y: number; status: Agent["status"] }[] {
    const out: { x: number; y: number; status: Agent["status"] }[] = [];
    for (const [id, b] of this.bodies) { const a = store.state.agents[id]; if (a) out.push({ x: b.x, y: b.y, status: a.status }); }
    return out;
  }
  viewFrame() {
    const { ox, oy, z } = this.view;
    return { x: ox, y: oy, w: (this.canvas.clientWidth - this.panelInset) / z, h: this.canvas.clientHeight / z };
  }
  teleportToTile(x: number, y: number) { if (this.world) { const s = this.world.nearestWalkable(x, y); this.placeMe(s.x, s.y); } }
  private placeMe(tx: number, ty: number) {
    this.me.x = tx * T + T / 2; this.me.y = ty * T + T - 2; this.me.placed = true;
    this.cam.init = false;
    this.sendTile(true);
  }

  /** The tile under a screen point (CSS px). */
  tileAt(cx: number, cy: number): { x: number; y: number } {
    const { ox, oy, z } = this.view;
    return { x: Math.floor((cx / z + ox) / T), y: Math.floor((cy / z + oy) / T) };
  }

  /** Agent under a screen point (CSS px), for click-to-open. */
  hit(cx: number, cy: number): string | null {
    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const h = this.hitboxes[i];
      if (cx >= h.x && cx <= h.x + h.w && cy >= h.y && cy <= h.y + h.h) return h.id;
    }
    return null;
  }

  private ensureWorld() {
    const s = store.state;
    if (!s.grid) return;
    // while editing a layout, show the server's dry-run grid for the draft
    const ed = layoutEdit.draft;
    // planning the town: the dry-run grid, with the buildings where the draft has them
    const plan = townPlan.draft;
    const key = ed?.preview ? `edit:${ed.previewVersion}` : plan?.preview ? `plan:${plan.previewVersion}` : `snap:${s.gridVersion}`;
    if (this.gridKey === key && this.world) return;
    this.world = plan?.preview
      ? new World(plan.preview, s.buildings.map((b) => (plan.lots[b.id] ? { ...b, lot: plan.lots[b.id] } : b)), plan.places ?? s.places)
      : new World(ed?.preview ?? s.grid, s.buildings, s.places);
    this.gridKey = key;
    if (!this.me.placed) {
      const av = store.avatarId ? s.agents[store.avatarId] : null;
      const plaza = s.places.find((p) => p.kind === "plaza");
      const start = av?.pos ?? plaza?.pos ?? { x: Math.floor(s.grid.w / 2), y: s.grid.h - 3 };
      const w = this.world.nearestWalkable(start.x, start.y);
      this.placeMe(w.x, w.y);
    }
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.ensureWorld();
    this.resize();
    if (!this.world) { this.g.fillStyle = "#14151c"; this.g.fillRect(0, 0, this.canvas.width, this.canvas.height); return; }
    this.moveMe(dt);
    this.flushMove(now);
    this.updateBodies(now);
    this.updateTarget();
    this.draw(now);
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
  }

  private moveMe(dt: number) {
    // the arrow keys nudge furniture while editing a layout
    if (layoutEdit.draft || townPlan.draft) { this.me.moving = false; this.route = null; this.onArrive = null; return; }
    const k = this.keys, w = this.world!;
    let vx = 0, vy = 0;
    if (k.has("arrowleft") || k.has("a")) vx -= 1;
    if (k.has("arrowright") || k.has("d")) vx += 1;
    if (k.has("arrowup") || k.has("w")) vy -= 1;
    if (k.has("arrowdown") || k.has("s")) vy += 1;
    if ((vx || vy) && this.route) { this.route = null; this.onArrive = null; }
    if ((vx || vy) && this.flow) this.closeFlow();
    if (!vx && !vy && this.route) { this.followRoute(dt); return; }
    this.me.moving = !!(vx || vy);
    if (!this.me.moving) return;
    const norm = vx && vy ? Math.SQRT1_2 : 1;
    const free = (x: number, y: number) => {
      const hw = 4;
      return w.walkablePx(x - hw, y) && w.walkablePx(x + hw, y) && w.walkablePx(x - hw, y - 4) && w.walkablePx(x + hw, y - 4);
    };
    const step = SPEED * dt * norm;
    if (vx && free(this.me.x + vx * step, this.me.y)) this.me.x += vx * step;
    if (vy && free(this.me.x, this.me.y + vy * step)) this.me.y += vy * step;
    this.sendTile(false);
  }

  private followRoute(dt: number) {
    const r = this.route!;
    let budget = ROUTE_SPEED * dt;
    while (budget > 0 && r.length) {
      const tx = r[0].x * T + T / 2, ty = r[0].y * T + T - 2;
      const dx = tx - this.me.x, dy = ty - this.me.y, d = Math.hypot(dx, dy);
      if (d <= budget) { this.me.x = tx; this.me.y = ty; budget -= d; r.shift(); }
      else { this.me.x += (dx / d) * budget; this.me.y += (dy / d) * budget; budget = 0; }
    }
    this.me.moving = r.length > 0;
    this.sendTile(false);
    if (!r.length) { const f = this.onArrive; this.route = null; this.onArrive = null; this.sendTile(true); f?.(); }
  }

  private sendTile(force: boolean) {
    const tx = Math.floor(this.me.x / T), ty = Math.floor((this.me.y - 1) / T);
    const key = `${tx},${ty}`;
    if (key === this.me.lastTile && !force) return;
    this.me.lastTile = key;
    this.pendingTile = { x: tx, y: ty };
  }
  private flushMove(now: number) {
    if (!this.pendingTile || now - this.lastSent < 150) return;
    this.onMove?.(this.pendingTile.x, this.pendingTile.y);
    this.pendingTile = null;
    this.lastSent = now;
  }

  private updateBodies(now: number) {
    const s = store.state;
    for (const a of Object.values(s.agents)) {
      if (a.id === store.avatarId || a.status === "retired") continue;
      const lp = store.livePos.get(a.id) ?? { ...a.pos, at: now };
      const off = this.world!.seatOffset(lp.x, lp.y);
      const tx = lp.x * T + T / 2 + off.dx, ty = lp.y * T + T - 2 + off.dy;
      let b = this.bodies.get(a.id);
      if (!b) { b = { x: tx, y: ty, fx: tx, fy: ty, tx, ty, t0: now, dur: 1, moving: false, key: "" }; this.bodies.set(a.id, b); }
      const key = `${tx},${ty}`;
      if (key !== b.key) {
        const far = Math.hypot(tx - b.x, ty - b.y) > 6 * T;
        b.fx = far ? tx : b.x; b.fy = far ? ty : b.y; b.tx = tx; b.ty = ty; b.t0 = now;
        // server walks 8 tiles/s; match that, with a floor so single steps don't snap
        b.dur = Math.max(110, (Math.hypot(tx - b.fx, ty - b.fy) / (8 * T)) * 1000);
        b.key = key;
      }
      const p = Math.min(1, (now - b.t0) / b.dur);
      b.x = b.fx + (b.tx - b.fx) * p; b.y = b.fy + (b.ty - b.fy) * p;
      b.moving = p < 1 || a.status === "walking";
    }
    for (const id of this.bodies.keys()) if (!s.agents[id] || s.agents[id].status === "retired") this.bodies.delete(id);
  }

  private updateTarget() {
    const s = store.state;
    // nearest of agents and places wins, so standing on a place's spot (e.g. the mod station, next to the
    // seated moderators) targets the place, and stepping toward an agent targets the agent
    const near: { d: number; t: Target }[] = [];
    for (const a of Object.values(s.agents)) {
      if (a.id === store.avatarId || a.status === "retired") continue;
      const b = this.bodies.get(a.id); if (!b) continue;
      const d = Math.hypot(b.x - this.me.x, b.y - this.me.y);
      if (d < INTERACT_PX) near.push({ d, t: { label: `Talk to ${a.name}${roleOf(a) ? ` · ${roleOf(a)}` : ""}`, panel: { kind: "agent", id: a.id }, agentId: a.id } });
    }
    for (const p of s.places) {
      const d = Math.hypot(p.pos.x * T + T / 2 - this.me.x, p.pos.y * T + T - 2 - this.me.y);
      if (d >= INTERACT_PX) continue;
      if (p.kind === "bank-map") { near.push({ d, t: { label: "Look at the town map", panel: { kind: "building", id: p.buildingId ?? undefined }, action: "flow" } }); continue; }
      const f = PLACE_PANEL[p.kind]; if (!f) continue;
      const { verb, ...panel } = f(p); near.push({ d, t: { label: verb, panel } });
    }
    // stable order (not by distance) so Tab walks a fixed ring instead of reshuffling as you shuffle around
    const byDist = near.slice().sort((x, y) => x.d - y.d);
    this.inReach = near.map((n) => n.t).sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
    if (this.picked && !this.inReach.some((t) => keyOf(t) === this.picked)) this.picked = null;
    const chosen = this.picked ? this.inReach.find((t) => keyOf(t) === this.picked)! : byDist[0]?.t;
    const best: Target | null = chosen ? { ...chosen, index: this.inReach.indexOf(chosen) + 1, count: this.inReach.length } : null;
    const same = best?.label === this.target?.label && best?.panel.id === this.target?.panel.id && best?.index === this.target?.index && best?.count === this.target?.count;
    if (!same) { this.target = best; this.onTarget?.(best); }
  }

  /** Edit layout overlay (world px): dim outside the room, tile grid, piece outlines and the spots people stand on. */
  private drawLayoutEdit(ed: LayoutDraft, ox: number, oy: number, vw: number, vh: number) {
    const g = this.g, { lot } = ed;
    const lx = lot.x * T, ly = lot.y * T, lw = lot.w * T, lh = lot.h * T;
    g.fillStyle = "rgba(10,12,20,.55)";
    g.fillRect(ox - T, oy - T, vw + 2 * T, ly - oy + T);
    g.fillRect(ox - T, ly + lh, vw + 2 * T, oy + vh + T - ly - lh);
    g.fillRect(ox - T, ly, lx - ox + T, lh);
    g.fillRect(lx + lw, ly, ox + vw + T - lx - lw, lh);
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 0.5;
    g.beginPath();
    for (let x = 0; x <= lot.w; x++) { g.moveTo(lx + x * T, ly); g.lineTo(lx + x * T, ly + lh); }
    for (let y = 0; y <= lot.h; y++) { g.moveTo(lx, ly + y * T); g.lineTo(lx + lw, ly + y * T); }
    g.stroke();
    const bad = new Set(ed.errors.map((e) => e.key));
    for (const p of ed.pieces) {
      const a = ed.anchors[p.key];
      const color = bad.has(p.key) ? "#ff5d5d" : p.key === ed.selected ? "#ffd34d" : "rgba(255,255,255,.55)";
      g.strokeStyle = color; g.lineWidth = p.key === ed.selected || bad.has(p.key) ? 1.5 : 0.75;
      for (const c of p.cells) g.strokeRect(lx + (a.x + c.dx) * T + 0.5, ly + (a.y + c.dy) * T + 0.5, T - 1, T - 1);
      g.fillStyle = color;
      for (const st of p.stands) {
        g.beginPath(); g.arc(lx + (a.x + st.x) * T + T / 2, ly + (a.y + st.y) * T + T / 2, 1.8, 0, Math.PI * 2); g.fill();
      }
    }
  }

  /** Town planning overlay (world px): every lot outlined, the selected one gold, illegal ones red, wall handles. */
  private drawTownPlan(plan: PlanDraft, z: number) {
    const g = this.g, px = 1 / z;
    const bad = new Set(plan.errors.map((e) => e.buildingId));
    const lots: [string, { x: number; y: number; w: number; h: number }][] = [...Object.entries(plan.lots), ...(plan.create ? [["new", plan.create.lot] as [string, typeof plan.create.lot]] : [])];
    for (const [id, l] of lots) {
      const sel = id === plan.selected;
      const color = bad.has(id) ? "#ff5d5d" : sel ? "#ffd34d" : id === "new" ? "#7fd4ff" : "rgba(255,255,255,.7)";
      g.fillStyle = bad.has(id) ? "rgba(255,93,93,.18)" : id === "new" ? "rgba(127,212,255,.16)" : sel ? "rgba(255,211,77,.12)" : "rgba(255,255,255,.04)";
      g.fillRect(l.x * T, l.y * T, l.w * T, l.h * T);
      g.strokeStyle = color; g.lineWidth = (sel || bad.has(id) ? 3 : 1.5) * px;
      g.setLineDash(id === "new" ? [6 * px, 4 * px] : []);
      g.strokeRect(l.x * T, l.y * T, l.w * T, l.h * T);
      g.setLineDash([]);
      // corner handles: drag a wall or corner to resize
      if (sel) {
        g.fillStyle = color;
        const hs = 6 * px;
        for (const [cx, cy] of [[l.x, l.y], [l.x + l.w, l.y], [l.x, l.y + l.h], [l.x + l.w, l.y + l.h]]) g.fillRect(cx * T - hs / 2, cy * T - hs / 2, hs, hs);
      }
    }
  }

  private draw(now: number) {
    const g = this.g, w = this.world!;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const viewW = cw - this.panelInset;
    const ww = w.w * T, wh = w.h * T;
    // centre the avatar in the strip between the HUD and the panel
    const hud = document.querySelector(".hud")?.getBoundingClientRect();
    this.leftInset = hud ? Math.min(hud.right + 12, viewW * 0.45) : 0;
    // ease the zoom: out to the whole town (fitted in that strip) while the Bank's town map is open, back to `zoom` after
    const overview = this.overview();
    const goalZ = overview ? fitZoom(ww, wh, viewW - this.leftInset, ch, this.zoom) : this.zoom;
    this.z = !this.z ? goalZ : Math.abs(goalZ - this.z) < 0.01 ? goalZ : this.z + (goalZ - this.z) * 0.12;
    const z = this.z;
    const ed = layoutEdit.draft;
    // editing a layout: centre the room instead of the avatar; the town map: centre the whole town
    const fx = ed ? (ed.lot.x + ed.lot.w / 2) * T : overview ? ww / 2 : this.me.x, fy = ed ? (ed.lot.y + ed.lot.h / 2) * T : overview ? wh / 2 : this.me.y;
    let cx = fx - (this.leftInset + (viewW - this.leftInset) / 2) / z, cy = fy - ch / 2 / z;
    // let the camera pan past the left edge by the HUD's width so nothing hides under it
    const lead = this.leftInset / z;
    if (!overview) {
      cx = ww * z + this.leftInset <= viewW ? -(viewW / z - ww) / 2 : Math.max(-lead, Math.min(ww - viewW / z, cx));
      cy = wh * z <= ch ? -(ch / z - wh) / 2 : Math.max(0, Math.min(wh - ch / z, cy));
    }
    if (!this.cam.init) { this.cam.x = cx; this.cam.y = cy; this.cam.init = true; }
    this.cam.x += (cx - this.cam.x) * 0.18; this.cam.y += (cy - this.cam.y) * 0.18;
    const ox = Math.round(this.cam.x * z * dpr) / (z * dpr), oy = Math.round(this.cam.y * z * dpr) / (z * dpr);
    const toScreen = (x: number, y: number) => ({ x: (x - ox) * z, y: (y - oy) * z });
    this.view = { ox, oy, z };

    g.setTransform(z * dpr, 0, 0, z * dpr, -ox * z * dpr, -oy * z * dpr);
    g.imageSmoothingEnabled = false;
    // grass beyond the world edge so panning past it (behind the HUD) looks continuous
    this.grass ??= g.createPattern(tiles().grass, "repeat");
    g.fillStyle = this.grass ?? "#5f9e4f";
    g.fillRect(ox - T, oy - T, cw / z + 2 * T, ch / z + 2 * T);
    g.drawImage(w.bitmap, 0, 0);

    // bodies, sorted by feet y
    const s = store.state;
    type D = { id: string; a: Agent | null; x: number; y: number; moving: boolean };
    const list: D[] = [];
    for (const a of Object.values(s.agents)) {
      if (a.id === store.avatarId || a.status === "retired") continue;
      const b = this.bodies.get(a.id); if (b) list.push({ id: a.id, a, x: b.x, y: b.y, moving: b.moving });
    }
    const meAgent = store.avatarId ? s.agents[store.avatarId] ?? null : null;
    list.push({ id: "__me", a: meAgent, x: this.me.x, y: this.me.y, moving: this.me.moving });
    list.sort((p, q) => p.y - q.y);
    const tick = Math.floor(now / 250);
    for (const d of list) {
      const sprite = d.id === "__me" ? HUMAN_SPRITE : d.a!.sprite;
      const frame = d.moving ? (tick % 2 ? 2 : 0) : d.a?.status === "working" ? tick % 2 : 0;
      g.fillStyle = "rgba(0,0,0,.28)";
      g.beginPath(); g.ellipse(d.x, d.y, 5, 2, 0, 0, Math.PI * 2); g.fill();
      // a guest's body is a local-only ghost
      g.globalAlpha = d.id === "__me" && authStore.get().guest ? 0.45 : d.a && (d.a.status === "stopped" || d.a.status === "banned") ? 0.55 : d.a?.status === "offline" ? 0.4 : 1;
      g.drawImage(charSheet(sprite), frame * CHAR_W, 0, CHAR_W, CHAR_H, Math.round(d.x - CHAR_W / 2), Math.round(d.y - CHAR_H + 1), CHAR_W, CHAR_H);
      g.globalAlpha = 1;
    }

    if (ed) this.drawLayoutEdit(ed, ox, oy, cw / z, ch / z);
    const plan = townPlan.draft;
    if (plan) this.drawTownPlan(plan, z);

    // screen-space overlay
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.flow) {
      // the town map: just the flow over the dimmed town (no signs, labels or bubbles); bodies can't be clicked
      this.hitboxes = [];
      drawFlow(g, now, this.flow, s.buildings, s.places, toScreen, cw, ch, this.leftInset + (viewW - this.leftInset) / 2);
      return;
    }
    if (plan) {
      // planning: each lot's name, nothing else (bodies can't be clicked)
      this.hitboxes = [];
      const names = new Map(s.buildings.map((b) => [b.id, b.name]));
      if (plan.create) names.set("new", plan.create.name.trim() || "New building");
      for (const [id, l] of [...Object.entries(plan.lots), ...(plan.create ? [["new", plan.create.lot] as const] : [])]) {
        const p = toScreen(l.x * T, l.y * T);
        drawPill(g, p.x, p.y - 3, `${names.get(id) ?? id} · ${l.w}×${l.h}`);
      }
      return;
    }
    for (const b of s.buildings) {
      if (!b.lot) continue;
      const p = toScreen((b.lot.x + b.lot.w / 2) * T, b.lot.y * T - 3);
      const sub = b.kind === "town-hall" ? (s.town?.name ?? "") : b.goal.length > 56 ? b.goal.slice(0, 55) + "…" : b.goal;
      if (p.x > -300 && p.x < cw + 300 && p.y > -40 && p.y < ch + 60) drawSign(g, p.x, p.y, b.name, sub, buildingBudgetLine(b.budget));
    }
    // the Bank's marquee hangs over the path, just outside its front door
    if (w.bank) {
      const p = toScreen((w.bank.x + w.bank.w / 2) * T, w.bank.y * T - 5);
      if (p.x > -300 && p.x < cw + 300 && p.y > -40 && p.y < ch + 140) drawBankSign(g, p.x, p.y, s.bank, now);
    }
    // in-tray badges on the managers' desks (the desk is the tile above the place's standing spot)
    for (const b of s.buildings) {
      if (!b.intray) continue;
      const p = s.places.find((x) => x.id === `intray:${b.id}`);
      if (!p) continue;
      const q = toScreen(p.pos.x * T + T - 2, (p.pos.y - 1) * T + 1);
      if (q.x > -40 && q.x < cw + 40 && q.y > -40 && q.y < ch + 40) drawBadge(g, q.x, q.y, b.intray);
    }
    this.hitboxes = [];
    const blocked = blockedByRedeploy(s.events);
    const targetId = this.target?.agentId;
    for (const d of list) {
      const p = toScreen(d.x, d.y);
      if (p.x < -200 || p.x > cw + 200 || p.y < -100 || p.y > ch + 100) continue;
      const isMe = d.id === "__me";
      const name = isMe ? (authStore.get().guest ? "You (guest)" : "You") : d.a!.name;
      const hl = d.id === targetId || d.id === this.hoverId;
      const home = d.a?.homeBuildingId ? s.buildings.find((b) => b.id === d.a!.homeBuildingId) : undefined;
      drawLabel(g, p.x, p.y + 3, name, d.a?.status ?? "idle", hl, isMe, d.a && !isMe ? residentBudgetLine(d.a, home?.dailyTokensPerAgent) : null, !!d.a && isManager(d.a, s.buildings));
      // held by a draining redeploy: its next session starts after the restart
      if (!isMe && blocked.has(d.id)) { const q = toScreen(d.x + CHAR_W / 2 - 2, d.y - CHAR_H + 4); drawPill(g, q.x, q.y, "⟳ redeploy"); }
      if (!isMe) this.hitboxes.push({ id: d.id, x: p.x - CHAR_W * z / 2, y: p.y - CHAR_H * z, w: CHAR_W * z, h: CHAR_H * z + 31 });
    }
    // bubbles last so they sit above every label
    const bubbles: { d: (typeof list)[number]; b: Bubble }[] = [];
    for (const d of list) {
      const said = store.said.get(d.id === "__me" ? store.avatarId ?? "__me" : d.id);
      const b = d.a ? bubbleFor(d.a, said, now) : said && now - said.at < 7000 ? { text: said.text, tone: "speech" as const } : null;
      if (b) bubbles.push({ d, b });
    }
    // speech on top of status bubbles, the targeted agent on top of everything
    const rank = (x: { d: { id: string }; b: Bubble }) => (x.d.id === targetId ? 2 : 0) + (x.b.tone === "speech" ? 1 : 0);
    bubbles.sort((p, q) => rank(p) - rank(q));
    for (const { d, b: bubble } of bubbles) {
      const p = toScreen(d.x, d.y - CHAR_H);
      if (p.x < -200 || p.x > cw + 200 || p.y < -100 || p.y > ch + 200) continue;
      drawBubble(g, p.x, p.y, bubble, d.id === targetId || d.id === this.hoverId);
    }
  }
}
