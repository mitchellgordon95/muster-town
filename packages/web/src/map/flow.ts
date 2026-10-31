/**
 * The Bank's town map. Using it zooms the camera out to the whole town and shows the one balance every building
 * draws from (docs/how-work-gets-done.md §7): each drawing building's lot is tinted gold, and coins stream from the
 * Bank to it along an arc, all the same width since the balance is shared first come first served. A legend lists
 * the Bank's totals and the town-wide free tokens. The renderer owns the camera; this file only draws, in screen
 * space, over the dimmed town.
 */
import type { Place, SnapshotBuilding } from "@muster-town/schema";
import type { Bank } from "../api";
import { claimedTokens, fmtTokens } from "../format";
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

/**
 * Where the money comes from (world px): the Bank (a landmark, not a building: its map stand or vault),
 * else the Town Hall in a town that doesn't have a Bank yet. `skip` is the building it stands for, if any.
 */
export function flowSource(places: Place[], buildings: SnapshotBuilding[]): { at: { x: number; y: number }; skip: string | null } | null {
  const p = places.find((x) => x.kind === "bank-map") ?? places.find((x) => (x.kind as string) === "bank");
  if (p) return { at: { x: p.pos.x * T + T / 2, y: p.pos.y * T + T / 2 }, skip: p.buildingId };
  const hall = buildings.find((b) => b.kind === "town-hall");
  return hall?.lot ? { at: { x: (hall.lot.x + hall.lot.w / 2) * T, y: (hall.lot.y + hall.lot.h / 2) * T }, skip: hall.id } : null;
}

/** framing the whole town lives with the shared zoomed-out renderer */
export { fitZoom } from "./overview";

/** Line width (screen px) for a share: 100% is a fat river, a sliver still shows. */
export const widthFor = (pct: number) => 2 + Math.sqrt(Math.max(0, pct) / 100) * 20;

/** A building on the map: whether it draws from the Bank and its (even) slice of the one balance. */
export interface BankLink { pct: number; draws: boolean }

/**
 * Each building's slice of the Bank: the one balance split evenly between the buildings that draw (an
 * approximation: it's first come first served). Buildings the summary doesn't know yet are left out.
 */
export function bankLinks(bank: Bank, buildings: Pick<SnapshotBuilding, "id" | "kind">[]): Map<string, BankLink> {
  const known = new Set(buildings.map((b) => b.id));
  const n = bank.buildings.filter((r) => known.has(r.buildingId)).length;
  const out = new Map<string, BankLink>();
  for (const r of bank.buildings) {
    const draws = known.has(r.buildingId);
    out.set(r.buildingId, { pct: draws ? 100 / Math.max(1, n) : 0, draws });
  }
  return out;
}

/** "#rrggbb" with an alpha, as rgba() */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

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

/** `text` cut with an ellipsis to `max` px in the current font. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** A building's label, at most `max` px wide (its lot's width on screen, so neighbours' labels never overlap). */
function label(g: CanvasRenderingContext2D, x: number, y: number, title0: string, sub0: string, color: string | null, max = Infinity) {
  g.font = `700 12px ${FONT}`;
  const title = fit(g, title0, Math.max(24, max - 16));
  const tw = g.measureText(title).width;
  g.font = `11px ${FONT}`;
  const sub = fit(g, sub0, Math.max(24, max - 16));
  const sw = g.measureText(sub).width;
  const w = Math.max(tw, sw) + 16, h = 34, bx = Math.round(x - w / 2), by = Math.round(y - h);
  g.fillStyle = "rgba(20,21,28,.9)";
  g.strokeStyle = color ?? "rgba(200,200,220,.3)"; g.lineWidth = 1.5;
  roundRect(g, bx, by, w, h, 7); g.fill(); g.stroke();
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `700 12px ${FONT}`; g.fillStyle = color ? "#f4f1e4" : "#c9c3ae";
  g.fillText(title, x, by + 11);
  g.font = `11px ${FONT}`; g.fillStyle = color ?? "#a9a6b8";
  g.fillText(sub, x, by + 24);
  g.textAlign = "left";
}

/**
 * Draw the flow over the (already drawn) town. `toScreen` maps world px to CSS px; `cw`/`ch` is the canvas
 * in CSS px; `cx` is the middle of the visible strip (between the HUD and any open panel), `right` its right edge.
 */
export function drawFlow(g: CanvasRenderingContext2D, now: number, flow: Flow, buildings: SnapshotBuilding[], places: Place[], toScreen: (x: number, y: number) => Pt, cw: number, ch: number, cx: number, right = cw) {
  const grow = Math.min(1, (now - flow.t0) / GROW_MS), ease = 1 - (1 - grow) ** 3;
  g.fillStyle = `rgba(8,10,22,${0.6 * ease})`;
  g.fillRect(0, 0, cw, ch);

  const bank = flow.bank;
  const src = flowSource(places, buildings);
  const centre = (b: SnapshotBuilding): Pt | null => b.lot ? toScreen((b.lot.x + b.lot.w / 2) * T, (b.lot.y + b.lot.h / 2) * T) : null;
  const from = src ? toScreen(src.at.x, src.at.y) : null;
  const links = bank ? bankLinks(bank, buildings) : new Map<string, BankLink>();
  const flows = buildings
    .filter((b) => b.id !== src?.skip && b.lot)
    .map((b) => ({ b, s: links.get(b.id), at: centre(b)!, foot: toScreen((b.lot!.x + b.lot!.w / 2) * T, (b.lot!.y + b.lot!.h) * T) }))
    .sort((p, q) => (q.s?.pct ?? 0) - (p.s?.pct ?? 0));

  if (from && bank) {
    // the lots, tinted and outlined in gold (one the Bank summary doesn't know yet, dashed grey)
    for (const { b, s } of flows) {
      const l = b.lot!;
      const p = toScreen(l.x * T, l.y * T), q = toScreen((l.x + l.w) * T, (l.y + l.h) * T);
      const on = !!s?.draws;
      roundRect(g, p.x - 3, p.y - 3, q.x - p.x + 6, q.y - p.y + 6, 6);
      if (on) { g.fillStyle = rgba(GOLD, 0.22 * ease); g.fill(); }
      g.strokeStyle = on ? rgba(GOLD, 0.9 * ease) : `rgba(200,200,220,${0.25 * ease})`;
      g.lineWidth = on ? 2.5 : 1;
      g.setLineDash(on ? [] : [4, 4]);
      g.stroke();
      g.setLineDash([]);
    }
    // thin rivers first so fat ones lie on top
    for (const { s, at } of [...flows].reverse()) {
      const pct = s?.pct ?? 0;
      if (pct <= 0 || !s) continue;
      const pts = arc(from, at), acc = measure(pts), len = acc[acc.length - 1];
      const shown = len * ease, w = widthFor(pct);
      const cut = pts.slice(0, Math.max(2, acc.findIndex((d) => d >= shown) + 1 || pts.length));
      const path = () => { g.beginPath(); cut.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); };
      g.lineCap = "round"; g.lineJoin = "round";
      // glow, body (pale gold at the Bank, gold where it lands), then a bright marching core for the direction
      g.save(); g.shadowColor = rgba(GOLD, 0.8); g.shadowBlur = 14;
      g.strokeStyle = rgba(GOLD, 0.45); g.lineWidth = w + 4; path(); g.stroke();
      g.restore();
      const grad = g.createLinearGradient(from.x, from.y, at.x, at.y);
      grad.addColorStop(0, "#ffe9a3"); grad.addColorStop(0.55, GOLD); grad.addColorStop(1, GOLD);
      g.strokeStyle = grad; g.lineWidth = w; path(); g.stroke();
      g.strokeStyle = "rgba(255,250,230,.75)"; g.lineWidth = Math.max(1, w * 0.18);
      g.setLineDash([2, 10]); g.lineDashOffset = -now / 1000 * COIN_SPEED; path(); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      // coins: as many in flight as the slice is big, so a bigger slice is a busier river
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
    // labels under each building, clear of the rivers that land on its middle: name, then what it holds
    for (const { b, s, foot } of flows) {
      const row = bank.buildings.find((r) => r.buildingId === b.id);
      // as wide as the lot plus the grass to its neighbour (core tree.ts GAP): labels side by side never overlap
      const max = toScreen((b.lot!.x + b.lot!.w + 1) * T, 0).x - toScreen(b.lot!.x * T, 0).x - 4;
      label(g, foot.x, foot.y + 44, b.name, s && row ? (s.draws ? `draws on the Bank${row.heldTokens ? ` · holds ${fmtTokens(row.heldTokens)}` : ""}` : "draws nothing from the Bank") : "…", s?.draws ? GOLD : null, max);
    }
    drawLegend(g, bank, right - 16, ch - 16, ease);
  }

  // title card
  const lines: [string, string][] = bank
    ? [[`${fmtTokens(bank.balanceTokens)} adj. tokens in the Bank`, `${bank.free ? fmtTokens(claimedTokens(bank.free)) : "…"} claimed · ${bank.free ? fmtTokens(bank.free.freeTokens) : "…"} free · Esc to return`]]
    : [[flow.error ? "Couldn't read the Bank" : "Reading the Bank…", flow.error ?? "Esc to return"]];
  const [t1, t2] = lines[0];
  const hint = bank && !flows.some((f) => (f.s?.pct ?? 0) > 0) ? "No building draws on the Bank yet" : t2;
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

/** The Bank's legend, anchored at its bottom-right corner (x, y): the balance, then what is claimed town-wide and what is still free. */
function drawLegend(g: CanvasRenderingContext2D, bank: Bank, x: number, y: number, alpha: number) {
  const rows: [string, string][] = [
    ["Balance", fmtTokens(bank.balanceTokens)],
    ["Claimed", bank.free ? fmtTokens(claimedTokens(bank.free)) : "…"],
    ["Free", bank.free ? fmtTokens(bank.free.freeTokens) : "…"],
  ];
  const RH = 20, PAD = 12, HEAD = 26;
  g.font = `700 12px ${FONT}`;
  const nameW = Math.max(...rows.map((r) => g.measureText(r[0]).width));
  const valW = Math.max(...rows.map((r) => g.measureText(r[1]).width));
  const w = PAD + nameW + 24 + valW + PAD, h = HEAD + rows.length * RH + PAD / 2;
  const bx = Math.round(x - w), by = Math.round(y - h);
  g.globalAlpha = alpha;
  g.fillStyle = "rgba(20,21,28,.92)"; g.strokeStyle = "rgba(242,201,76,.5)"; g.lineWidth = 1.5;
  roundRect(g, bx, by, w, h, 10); g.fill(); g.stroke();
  g.textBaseline = "middle"; g.textAlign = "left";
  g.font = `800 12px ${FONT}`; g.fillStyle = GOLD; g.fillText("THE BANK", bx + PAD, by + 15);
  rows.forEach(([name, val], i) => {
    const ry = by + HEAD + i * RH + RH / 2;
    g.font = `11px ${FONT}`; g.fillStyle = "#a9a6b8"; g.fillText(name, bx + PAD, ry);
    g.textAlign = "right"; g.font = `700 12px ${FONT}`; g.fillStyle = i === 4 ? GOLD : "#e8e2cc"; g.fillText(val, bx + w - PAD, ry); g.textAlign = "left";
  });
  g.globalAlpha = 1;
}
