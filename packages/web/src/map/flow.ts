/**
 * The Bank's town map. Using it zooms the camera out to the whole town and streams gold coins from the Bank to
 * every building along arcs, each as wide (and as busy) as that building's % share of the Bank.
 * The renderer owns the camera; this file only draws, in screen space, over the dimmed town.
 */
import type { SnapshotBuilding } from "@muster-town/schema";
import type { Bank } from "../api";
import { fmtTokens } from "../format";
import { roundRect } from "./overlay";
import { T } from "./sprites";

export interface Flow {
  /** when the map was opened (performance.now ms), for the grow-in */
  t0: number;
  /** null until GET /api/bank answers */
  bank: Bank | null;
  error: string | null;
}

type Pt = { x: number; y: number };
const FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const GOLD = "#f2c94c", GOLD_DEEP = "#b8862a", INK = "#14151c";
/** coins travel this many screen px per second, whatever the zoom */
const COIN_SPEED = 90;
const GROW_MS = 1100;

/** The building the money comes from: the Bank, or the Town Hall in a town that doesn't have one yet. */
export function bankBuilding(buildings: SnapshotBuilding[]): SnapshotBuilding | undefined {
  return buildings.find((b) => (b.kind as string) === "bank" || b.id === "bank") ?? buildings.find((b) => b.kind === "town-hall");
}

/** The largest zoom that shows the whole world (`ww`×`wh` world px) in the view, with a margin; never above `max`. */
export function fitZoom(ww: number, wh: number, viewW: number, viewH: number, max: number): number {
  return Math.max(0.5, Math.min(max, (viewW * 0.92) / ww, (viewH * 0.8) / wh));
}

/** Line width (screen px) for a share: 100% is a fat river, a sliver still shows. */
export const widthFor = (pct: number) => 2 + Math.sqrt(Math.max(0, pct) / 100) * 20;

/** Points along a quadratic arc from `a` to `b`, bowing upward by a fraction of its length. */
function arc(a: Pt, b: Pt, n = 48): Pt[] {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - Math.min(220, d * 0.35) - 20 };
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return out;
}

/** Cumulative lengths of a polyline, and the point `s` px along it. */
function measure(pts: Pt[]): number[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return acc;
}
function along(pts: Pt[], acc: number[], s: number): Pt {
  let i = 1;
  while (i < acc.length - 1 && acc[i] < s) i++;
  const seg = acc[i] - acc[i - 1] || 1, t = Math.max(0, Math.min(1, (s - acc[i - 1]) / seg));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
}

function coin(g: CanvasRenderingContext2D, p: Pt, r: number, spin: number) {
  // a coin seen turning: squash its width with the spin
  const w = Math.max(0.35, Math.abs(Math.cos(spin))) * r;
  g.fillStyle = "rgba(0,0,0,.35)";
  g.beginPath(); g.ellipse(p.x + 1, p.y + 1.5, w, r, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = GOLD_DEEP;
  g.beginPath(); g.ellipse(p.x, p.y, w, r, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = GOLD;
  g.beginPath(); g.ellipse(p.x, p.y, w * 0.72, r * 0.72, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#fff4c2";
  g.fillRect(p.x - w * 0.35, p.y - r * 0.45, Math.max(1, w * 0.3), Math.max(1, r * 0.3));
}

function label(g: CanvasRenderingContext2D, x: number, y: number, title: string, sub: string, strong: boolean) {
  g.font = `700 12px ${FONT}`;
  const tw = g.measureText(title).width;
  g.font = `11px ${FONT}`;
  const sw = g.measureText(sub).width;
  const w = Math.max(tw, sw) + 16, h = 34, bx = Math.round(x - w / 2), by = Math.round(y - h);
  g.fillStyle = strong ? "rgba(36,28,8,.92)" : "rgba(20,21,28,.85)";
  g.strokeStyle = strong ? GOLD : "rgba(242,201,76,.35)"; g.lineWidth = 1.5;
  roundRect(g, bx, by, w, h, 7); g.fill(); g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `700 12px ${FONT}`; g.fillStyle = strong ? GOLD : "#c9c3ae";
  g.fillText(title, x, by + 11);
  g.font = `11px ${FONT}`; g.fillStyle = "#e8e2cc";
  g.fillText(sub, x, by + 24);
  g.textAlign = "left";
}

/**
 * Draw the flow over the (already drawn) town. `toScreen` maps world px to CSS px; `cw`/`ch` is the canvas
 * in CSS px; `cx` is the middle of the visible strip (between the HUD and any open panel).
 */
export function drawFlow(g: CanvasRenderingContext2D, now: number, flow: Flow, buildings: SnapshotBuilding[], toScreen: (x: number, y: number) => Pt, cw: number, ch: number, cx: number) {
  const grow = Math.min(1, (now - flow.t0) / GROW_MS), ease = 1 - (1 - grow) ** 3;
  g.fillStyle = `rgba(8,10,22,${0.6 * ease})`;
  g.fillRect(0, 0, cw, ch);

  const src = bankBuilding(buildings);
  const centre = (b: SnapshotBuilding): Pt | null => b.lot ? toScreen((b.lot.x + b.lot.w / 2) * T, (b.lot.y + b.lot.h / 2) * T) : null;
  const from = src ? centre(src) : null;
  const shares = new Map((flow.bank?.buildings ?? []).map((s) => [s.buildingId, s]));
  const flows = buildings
    .filter((b) => b.id !== src?.id && b.lot)
    .map((b) => ({ b, s: shares.get(b.id), at: centre(b)!, foot: toScreen((b.lot!.x + b.lot!.w / 2) * T, (b.lot!.y + b.lot!.h) * T) }))
    .sort((p, q) => (q.s?.pct ?? 0) - (p.s?.pct ?? 0));

  if (from && flow.bank) {
    // the recipients' lots, outlined in gold as strong as their share
    for (const { b, s } of flows) {
      const pct = s?.pct ?? 0, l = b.lot!;
      const p = toScreen(l.x * T, l.y * T), q = toScreen((l.x + l.w) * T, (l.y + l.h) * T);
      g.strokeStyle = pct > 0 ? `rgba(242,201,76,${(0.35 + 0.6 * Math.min(1, pct / 50)) * ease})` : `rgba(200,200,220,${0.25 * ease})`;
      g.lineWidth = pct > 0 ? 2 : 1;
      g.setLineDash(pct > 0 ? [] : [4, 4]);
      roundRect(g, p.x - 3, p.y - 3, q.x - p.x + 6, q.y - p.y + 6, 6); g.stroke();
      g.setLineDash([]);
    }
    // thin rivers first so fat ones lie on top
    for (const { s, at } of [...flows].reverse()) {
      const pct = s?.pct ?? 0;
      if (pct <= 0) continue;
      const pts = arc(from, at), acc = measure(pts), len = acc[acc.length - 1];
      const shown = len * ease, w = widthFor(pct);
      const cut = pts.slice(0, Math.max(2, acc.findIndex((d) => d >= shown) + 1 || pts.length));
      const path = () => { g.beginPath(); cut.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); };
      g.lineCap = "round"; g.lineJoin = "round";
      // glow, body, then a bright marching core that shows the direction of flow
      g.save(); g.shadowColor = "rgba(242,201,76,.8)"; g.shadowBlur = 14;
      g.strokeStyle = "rgba(184,134,42,.55)"; g.lineWidth = w + 4; path(); g.stroke();
      g.restore();
      const grad = g.createLinearGradient(from.x, from.y, at.x, at.y);
      grad.addColorStop(0, "#ffe9a3"); grad.addColorStop(1, GOLD);
      g.strokeStyle = grad; g.lineWidth = w; path(); g.stroke();
      g.strokeStyle = "rgba(255,250,230,.75)"; g.lineWidth = Math.max(1, w * 0.18);
      g.setLineDash([2, 10]); g.lineDashOffset = -now / 1000 * COIN_SPEED; path(); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      // coins: as many in flight as the share is big, so a bigger share is a busier river
      if (grow >= 1) {
        const n = Math.max(1, Math.round(pct / 6)), r = 3 + w * 0.18;
        const head = (now / 1000) * COIN_SPEED;
        for (let k = 0; k < n; k++) {
          const s0 = (head + (k / n) * len) % len;
          coin(g, along(pts, acc, s0), r, now / 220 + k);
        }
      }
    }
    // the Bank: a pulsing gold ring
    const pulse = (now % 1600) / 1600;
    g.strokeStyle = `rgba(242,201,76,${0.8 * (1 - pulse)})`; g.lineWidth = 3;
    g.beginPath(); g.arc(from.x, from.y, 14 + pulse * 30, 0, Math.PI * 2); g.stroke();
    g.fillStyle = GOLD; g.strokeStyle = INK; g.lineWidth = 2;
    g.beginPath(); g.arc(from.x, from.y, 9, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = INK; g.font = `800 11px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("¤", from.x, from.y + 0.5); g.textAlign = "left";
    // labels on top of everything
    // labels under each building, clear of the rivers that land on its middle
    for (const { b, s, foot } of flows) {
      const pct = s?.pct ?? 0;
      const left = s ? s.expiringTokens + s.durableTokens : 0;
      label(g, foot.x, foot.y + 44, `${b.name} · ${pct % 1 ? pct.toFixed(1) : pct}%`, pct > 0 ? `${fmtTokens(left)} tokens left to draw` : "no share", pct > 0);
    }
  }

  // title card
  const bank = flow.bank;
  const lines: [string, string][] = bank
    ? [[`${fmtTokens(bank.balanceTokens)} tokens in the Bank`, `${fmtTokens(bank.expiringTokens)} expire today · ${fmtTokens(bank.durableTokens)} durable · Esc to return`]]
    : [[flow.error ? "Couldn't read the Bank" : "Reading the Bank…", flow.error ?? "Esc to return"]];
  const [t1, t2] = lines[0];
  const hint = bank && !flows.some((f) => (f.s?.pct ?? 0) > 0) ? "No building has a share of the Bank yet" : t2;
  g.font = `800 18px ${FONT}`;
  const w1 = g.measureText(t1).width;
  g.font = `12px ${FONT}`;
  const w = Math.max(w1, g.measureText(hint).width) + 36, h = 56, bx = Math.round(cx - w / 2), by = 18;
  g.globalAlpha = ease;
  g.fillStyle = "rgba(30,24,8,.92)"; g.strokeStyle = GOLD; g.lineWidth = 2;
  roundRect(g, bx, by, w, h, 10); g.fill(); g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `800 18px ${FONT}`; g.fillStyle = GOLD; g.fillText(t1, cx, by + 20);
  g.font = `12px ${FONT}`; g.fillStyle = "#e8e2cc"; g.fillText(hint, cx, by + 40);
  g.textAlign = "left"; g.globalAlpha = 1;
}
