/**
 * Canvas 2D town renderer. Owns the rAF loop, camera, the human's client-side movement,
 * interpolation of other bodies between `agents.pos` updates, and proximity targeting.
 */
import type { Agent, Place } from "@agent-town/schema";
import { store, type PanelRef, isManager, roleOf } from "../state";
import { World } from "./world";
import { T, CHAR_W, CHAR_H, charSheet, tiles, HUMAN_SPRITE } from "./sprites";
import { bubbleFor, drawBadge, drawBubble, drawLabel, drawSign, type Bubble } from "./overlay";

export interface Target { label: string; panel: PanelRef; agentId?: string }
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
  donation: () => ({ kind: "donation", verb: "Donate tokens" }),
  schedule: () => ({ kind: "schedule", verb: "Read the meeting schedule" }),
  "mod-station": () => ({ kind: "mod", verb: "Visit the mod station" }),
  library: () => ({ kind: "library", verb: "Browse the library" }),
  "trophy-room": () => ({ kind: "trophy", verb: "Visit the trophy room" }),
  outbox: () => ({ kind: "outbox", verb: "Check the outbox" }),
  "meeting-room": (p) => ({ kind: "meeting", id: `room:${p.buildingId ?? ""}`, verb: `Join the ${p.name.toLowerCase()}` }),
  door: (p) => ({ kind: "building", id: p.buildingId ?? undefined, verb: `Enter ${p.name.replace(/^door( of|:)?\s*/i, "") || "building"}` }),
};

export class MapRenderer {
  private g: CanvasRenderingContext2D;
  private world: World | null = null;
  private gridVersion = -1;
  private bodies = new Map<string, Body>();
  private me = { x: 0, y: 0, placed: false, moving: false, lastTile: "" };
  /** auto-walk: remaining tiles, and what to do on arrival */
  private route: { x: number; y: number }[] | null = null;
  private onArrive: (() => void) | null = null;
  private keys = new Set<string>();
  private cam = { x: 0, y: 0, init: false };
  zoom = 3;
  panelInset = 0;
  leftInset = 330;
  private grass: CanvasPattern | null = null;
  private raf = 0;
  private last = performance.now();
  private target: Target | null = null;
  private lastSent = 0;
  private pendingTile: { x: number; y: number } | null = null;
  private hitboxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  hoverId: string | null = null;
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
    const from = { x: Math.floor(this.me.x / T), y: Math.floor((this.me.y - 1) / T) };
    const path = this.world.path(from, goal);
    const arrive = () => { if (panel) store.open(panel); };
    if (!path || path.length > 140) { this.route = null; this.placeMe(goal.x, goal.y); arrive(); return true; }
    if (!path.length) { this.route = null; this.placeMe(goal.x, goal.y); arrive(); return true; }
    this.route = path; this.onArrive = arrive;
    return true;
  }
  teleportToTile(x: number, y: number) { if (this.world) { const s = this.world.nearestWalkable(x, y); this.placeMe(s.x, s.y); } }
  private placeMe(tx: number, ty: number) {
    this.me.x = tx * T + T / 2; this.me.y = ty * T + T - 2; this.me.placed = true;
    this.cam.init = false;
    this.sendTile(true);
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
    if (this.gridVersion === s.gridVersion && this.world) return;
    this.world = new World(s.grid, s.buildings, s.places);
    this.gridVersion = s.gridVersion;
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
    const k = this.keys, w = this.world!;
    let vx = 0, vy = 0;
    if (k.has("arrowleft") || k.has("a")) vx -= 1;
    if (k.has("arrowright") || k.has("d")) vx += 1;
    if (k.has("arrowup") || k.has("w")) vy -= 1;
    if (k.has("arrowdown") || k.has("s")) vy += 1;
    if ((vx || vy) && this.route) { this.route = null; this.onArrive = null; }
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
    let best: Target | null = null, bd = INTERACT_PX;
    for (const a of Object.values(s.agents)) {
      if (a.id === store.avatarId || a.status === "retired") continue;
      const b = this.bodies.get(a.id); if (!b) continue;
      const d = Math.hypot(b.x - this.me.x, b.y - this.me.y);
      if (d < bd) { bd = d; best = { label: `Talk to ${a.name}${roleOf(a) ? ` · ${roleOf(a)}` : ""}`, panel: { kind: "agent", id: a.id }, agentId: a.id }; }
    }
    for (const p of s.places) {
      const f = PLACE_PANEL[p.kind]; if (!f) continue;
      const d = Math.hypot(p.pos.x * T + T / 2 - this.me.x, p.pos.y * T + T - 2 - this.me.y);
      if (d < bd) { bd = d; const { verb, ...panel } = f(p); best = { label: verb, panel }; }
    }
    const same = best?.label === this.target?.label && best?.panel.id === this.target?.panel.id;
    if (!same) { this.target = best; this.onTarget?.(best); }
  }

  private draw(now: number) {
    const g = this.g, w = this.world!;
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const z = this.zoom;
    const viewW = cw - this.panelInset;
    // camera: follow the avatar, centred in the part of the screen the panel doesn't cover
    // centre the avatar in the strip between the HUD and the panel
    const hud = document.querySelector(".hud")?.getBoundingClientRect();
    this.leftInset = hud ? Math.min(hud.right + 12, viewW * 0.45) : 0;
    let cx = this.me.x - (this.leftInset + (viewW - this.leftInset) / 2) / z, cy = this.me.y - ch / 2 / z;
    const ww = w.w * T, wh = w.h * T;
    // let the camera pan past the left edge by the HUD's width so nothing hides under it
    const lead = this.leftInset / z;
    cx = ww * z + this.leftInset <= viewW ? -(viewW / z - ww) / 2 : Math.max(-lead, Math.min(ww - viewW / z, cx));
    cy = wh * z <= ch ? -(ch / z - wh) / 2 : Math.max(0, Math.min(wh - ch / z, cy));
    if (!this.cam.init) { this.cam.x = cx; this.cam.y = cy; this.cam.init = true; }
    this.cam.x += (cx - this.cam.x) * 0.18; this.cam.y += (cy - this.cam.y) * 0.18;
    const ox = Math.round(this.cam.x * z * dpr) / (z * dpr), oy = Math.round(this.cam.y * z * dpr) / (z * dpr);
    const toScreen = (x: number, y: number) => ({ x: (x - ox) * z, y: (y - oy) * z });

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
      g.globalAlpha = d.a && (d.a.status === "stopped" || d.a.status === "banned") ? 0.55 : 1;
      g.drawImage(charSheet(sprite), frame * CHAR_W, 0, CHAR_W, CHAR_H, Math.round(d.x - CHAR_W / 2), Math.round(d.y - CHAR_H + 1), CHAR_W, CHAR_H);
      g.globalAlpha = 1;
    }

    // screen-space overlay
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const b of s.buildings) {
      if (!b.lot) continue;
      const p = toScreen((b.lot.x + b.lot.w / 2) * T, b.lot.y * T - 3);
      const sub = b.kind === "town-hall" ? (s.town?.name ?? "") : b.goal.length > 56 ? b.goal.slice(0, 55) + "…" : b.goal;
      if (p.x > -300 && p.x < cw + 300 && p.y > -40 && p.y < ch + 60) drawSign(g, p.x, p.y, b.name, sub);
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
    const targetId = this.target?.agentId;
    for (const d of list) {
      const p = toScreen(d.x, d.y);
      if (p.x < -200 || p.x > cw + 200 || p.y < -100 || p.y > ch + 100) continue;
      const isMe = d.id === "__me";
      const name = isMe ? "You" : d.a!.name;
      const hl = d.id === targetId || d.id === this.hoverId;
      drawLabel(g, p.x, p.y + 3, name, d.a?.status ?? "idle", hl, isMe, !!d.a && isManager(d.a, s.buildings));
      if (!isMe) this.hitboxes.push({ id: d.id, x: p.x - CHAR_W * z / 2, y: p.y - CHAR_H * z, w: CHAR_W * z, h: CHAR_H * z + 18 });
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
