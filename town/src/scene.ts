import Phaser from "phaser";
import { makeTextures, CHAR_W, CHAR_H, PLAYER_SPRITE } from "./sprites";
import type { Building, Desk, TownState, Activity } from "./api";

export const TILE = 16;
export interface AgentRef { building: Building; desk?: Desk; librarian?: boolean; }

interface AgentView {
  ref: AgentRef;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  bubble: Phaser.GameObjects.Text;
  key: string;
  lastActivity?: string;
}

export class TownScene extends Phaser.Scene {
  private state!: TownState;
  private blocked = new Set<string>();
  private player!: Phaser.GameObjects.Sprite;
  private agents = new Map<string, AgentView>();
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private nearest?: AgentView;
  private worldW = 0; private worldH = 0;
  onInteract?: (ref: AgentRef) => void;
  onHint?: (text: string | null) => void;

  constructor(state: TownState) { super("town"); this.state = state; }

  create() {
    makeTextures(this);
    this.buildWorld();
    this.cameras.main.setZoom(3).setRoundPixels(true);
    this.cameras.main.setBounds(0, 0, this.worldW, this.worldH);
    this.cameras.main.startFollow(this.player, true, 0.15, 0.15);
    const kb = this.input.keyboard!;
    kb.disableGlobalCapture();
    this.keys = kb.addKeys({ up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT", w: "W", a: "A", s: "S", d: "D", e: "E" }, false) as any;
    this.keys.e.on("down", () => { if (this.nearest && !typing()) this.onInteract?.(this.nearest.ref); });
  }

  private tile(key: string, tx: number, ty: number, depth = 0) {
    return this.add.image(tx * TILE, ty * TILE, key).setOrigin(0).setDepth(depth);
  }

  private buildWorld() {
    const bs = this.state.buildings;
    const layouts = bs.map((b) => layoutFor(b));
    let x = 3;
    const maxH = Math.max(...layouts.map((l) => l.H), 8);
    this.worldW = (layouts.reduce((a, l) => a + l.W + 4, 0) + 4) * TILE;
    this.worldH = (maxH + 10) * TILE;
    const TW = this.worldW / TILE, TH = this.worldH / TILE;
    for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) this.tile("grass", tx, ty, -2);
    const roadY = maxH + 5;
    for (let tx = 0; tx < TW; tx++) this.tile("path", tx, roadY, -1);

    bs.forEach((b, i) => {
      const L = layouts[i];
      const bx = x, by = roadY - 3 - L.H;
      // floor + walls
      for (let ty = 0; ty < L.H; ty++) for (let tx = 0; tx < L.W; tx++) {
        const edge = tx === 0 || ty === 0 || tx === L.W - 1 || ty === L.H - 1;
        const doorX = Math.floor(L.W / 2);
        if (edge && !(ty === L.H - 1 && tx === doorX)) { this.tile("wall", bx + tx, by + ty, 1); this.block(bx + tx, by + ty); }
        else this.tile("floor", bx + tx, by + ty, -1);
      }
      // path from door to road
      const doorX = bx + Math.floor(L.W / 2);
      for (let ty = by + L.H; ty < roadY; ty++) this.tile("path", doorX, ty, -1);
      // sign
      this.add.text((bx + L.W / 2) * TILE, (by - 0.4) * TILE, b.name, { fontSize: "8px", color: "#fff", fontStyle: "bold", resolution: 4, stroke: "#000", strokeThickness: 2 }).setOrigin(0.5, 1).setDepth(5);
      if (b.goal) this.add.text((bx + L.W / 2) * TILE, (by + 0.9) * TILE, b.goal, { fontSize: "5px", color: "#ffcf5e", resolution: 4, wordWrap: { width: (L.W - 2) * TILE }, align: "center" }).setOrigin(0.5, 0.5).setDepth(5);
      // desks
      b.desks.forEach((d, j) => {
        const c = j % L.cols, r = Math.floor(j / L.cols);
        const dx = bx + 2 + c * 4, dy = by + 2 + r * 4;
        this.tile("desk", dx, dy, 1); this.block(dx, dy); this.block(dx + 1, dy);
        this.addAgent({ building: b, desk: d }, d.sprite, (dx + 1) * TILE, (dy + 1.4) * TILE);
      });
      // librarian corner
      const sy = by + L.H - 3;
      this.tile("shelf", bx + 1, sy, 1); this.block(bx + 1, sy);
      this.tile("plant", bx + L.W - 2, sy, 1); this.block(bx + L.W - 2, sy);
      this.addAgent({ building: b, librarian: true }, b.librarian.sprite, (bx + 2.5) * TILE, (sy + 0.5) * TILE);
      x += L.W + 4;
    });
    // decorative trees along the road
    for (let tx = 1; tx < TW; tx += 5) { this.tile("plant", tx, roadY + 2, 1); this.block(tx, roadY + 2); }

    const spawnX = (3 + Math.floor(layouts[0]?.W / 2 || 4)) * TILE + TILE / 2;
    this.player = this.add.sprite(spawnX, (roadY + 0.5) * TILE, `char${PLAYER_SPRITE}`, 0).setOrigin(0.5, 1).setDepth(10);
  }

  private block(tx: number, ty: number) { this.blocked.add(`${tx},${ty}`); }
  private isBlocked(px: number, py: number) { return this.blocked.has(`${Math.floor(px / TILE)},${Math.floor(py / TILE)}`); }

  private addAgent(ref: AgentRef, spriteIdx: number, x: number, y: number) {
    const key = ref.desk ? `${ref.building.id}/${ref.desk.id}` : `${ref.building.id}/librarian`;
    const sprite = this.add.sprite(x, y, `char${spriteIdx}`, 0).setOrigin(0.5, 1).setDepth(3);
    const name = ref.desk ? ref.desk.name : ref.building.librarian.name;
    const label = this.add.text(x, y + 1, name, { fontSize: "5px", color: "#fff", resolution: 4, stroke: "#000", strokeThickness: 2 }).setOrigin(0.5, 0).setDepth(4);
    const bubble = this.add.text(x, y - CHAR_H - 2, "", { fontSize: "5px", color: "#e8e9f0", backgroundColor: "#14151c", padding: { x: 2, y: 1 }, resolution: 4, wordWrap: { width: 70 } }).setOrigin(0.5, 1).setDepth(6);
    const view: AgentView = { ref, sprite, label, bubble, key };
    this.agents.set(key, view);
    this.refreshAgent(view);
  }

  private refreshAgent(v: AgentView) {
    if (!v.ref.desk) { v.bubble.setText("📚 ask me anything"); v.bubble.setColor("#9a9db3"); return; }
    const st = v.ref.desk.status;
    const last = st.activity[st.activity.length - 1];
    switch (st.state) {
      case "working":
        v.sprite.play(`type${v.ref.desk.sprite}`, true);
        v.bubble.setText(trunc(v.lastActivity ?? last?.text ?? "working…", 44)).setColor("#6fdc8c"); break;
      case "awaiting-review":
        v.sprite.stop(); v.sprite.setFrame(0);
        v.bubble.setText(`📄 run ${st.latestReport?.run} report ready (${st.latestReport?.verdict})`).setColor("#ffcf5e"); break;
      case "stopped":
        v.sprite.stop(); v.sprite.setFrame(0); v.sprite.setAlpha(0.6);
        v.bubble.setText("■ stopped").setColor("#ff7b7b"); break;
      case "error":
        v.sprite.stop(); v.sprite.setFrame(0);
        v.bubble.setText("⚠ error, see panel").setColor("#ff7b7b"); break;
      default:
        v.sprite.stop(); v.sprite.setFrame(0);
        v.bubble.setText(st.latestReport ? "✓ approved, starting soon" : "💤 not started").setColor("#9a9db3");
    }
    if (st.state !== "stopped") v.sprite.setAlpha(1);
  }

  /** Called from outside on WS state updates. */
  applyState(state: TownState) {
    this.state = state;
    for (const b of state.buildings) {
      for (const d of b.desks) {
        const v = this.agents.get(`${b.id}/${d.id}`);
        if (v) { v.ref = { building: b, desk: d }; this.refreshAgent(v); }
      }
      const lib = this.agents.get(`${b.id}/librarian`);
      if (lib) lib.ref = { building: b, librarian: true };
    }
  }
  applyActivity(a: Activity) {
    const v = this.agents.get(`${a.building}/${a.desk}`);
    if (!v || !v.ref.desk) return;
    v.lastActivity = a.text;
    v.ref.desk.status.activity.push(a);
    if (v.ref.desk.status.state === "working") this.refreshAgent(v);
  }

  /** Dev helper: move the player next to an agent ("carbon-cycle/ocean" or "carbon-cycle/librarian"). */
  teleportTo(key: string) {
    const v = this.agents.get(key); if (!v) return false;
    this.player.x = v.sprite.x + 14; this.player.y = v.sprite.y + 2; return true;
  }
  interactNearest() { if (this.nearest) this.onInteract?.(this.nearest.ref); }

  update(_t: number, dtMs: number) {
    if (typing()) return;
    const dt = dtMs / 1000, speed = 70;
    let vx = 0, vy = 0;
    if (this.keys.left.isDown || this.keys.a.isDown) vx = -1;
    if (this.keys.right.isDown || this.keys.d.isDown) vx = 1;
    if (this.keys.up.isDown || this.keys.w.isDown) vy = -1;
    if (this.keys.down.isDown || this.keys.s.isDown) vy = 1;
    const p = this.player;
    const tryMove = (dx: number, dy: number) => {
      const nx = p.x + dx, ny = p.y + dy;
      const hw = CHAR_W / 2 - 2, feet = 4;
      if (this.isBlocked(nx - hw, ny - 1) || this.isBlocked(nx + hw, ny - 1) || this.isBlocked(nx - hw, ny - feet) || this.isBlocked(nx + hw, ny - feet)) return;
      if (nx < 0 || ny < 0 || nx > this.worldW || ny > this.worldH) return;
      p.x = nx; p.y = ny;
    };
    if (vx) tryMove(vx * speed * dt, 0);
    if (vy) tryMove(0, vy * speed * dt);
    if (vx || vy) p.play(`type${PLAYER_SPRITE}`, true); else { p.stop(); p.setFrame(0); }
    p.setDepth(10);

    // nearest agent
    let best: AgentView | undefined, bd = 26;
    for (const v of this.agents.values()) {
      const d = Phaser.Math.Distance.Between(p.x, p.y, v.sprite.x, v.sprite.y);
      if (d < bd) { bd = d; best = v; }
    }
    if (best !== this.nearest) {
      this.nearest = best;
      if (!best) this.onHint?.(null);
      else {
        const who = best.ref.desk ? `${best.ref.desk.name} · ${best.ref.desk.title}` : `${best.ref.building.librarian.name} · librarian`;
        this.onHint?.(`Press E to talk to ${who}`);
      }
    }
  }
}

function layoutFor(b: Building) {
  const n = Math.max(1, b.desks.length);
  const cols = Math.min(3, n), rows = Math.ceil(n / cols);
  return { cols, rows, W: cols * 4 + 3, H: rows * 4 + 4 };
}
function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
export function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
}
