/** Screen-space text: name labels and bubbles, drawn crisp on top of the scaled pixel layer. */
import type { Agent, BuildingBudget, Stoplight } from "@muster-town/schema";
import { fmtTokens, stoplightLabel } from "../format";

export const STATUS_COLOR: Record<string, string> = {
  idle: "#9a9db3", walking: "#7cc4ff", working: "#6fdc8c", "in-meeting": "#c79bff",
  "out-of-budget": "#ff9f5e", stopped: "#ff7b7b", banned: "#ff7b7b", retired: "#5c5f73", offline: "#6b6e82",
};

export interface Bubble { text: string; tone: "speech" | "work" | "warn" | "muted" | "bad" | "meet" }

const FONT = "600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const SFONT = "9px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const BFONT = "11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const TONE: Record<Bubble["tone"], { bg: string; fg: string; border: string }> = {
  speech: { bg: "#f4f1e8", fg: "#1b1c24", border: "#1b1c24" },
  work: { bg: "rgba(20,32,26,.92)", fg: "#9ff0b4", border: "#2f5c3f" },
  warn: { bg: "rgba(45,38,18,.94)", fg: "#ffcf5e", border: "#5f5226" },
  muted: { bg: "rgba(20,21,28,.85)", fg: "#9a9db3", border: "#2e3142" },
  bad: { bg: "rgba(48,24,24,.94)", fg: "#ff9b9b", border: "#5c3434" },
  meet: { bg: "rgba(36,26,52,.94)", fg: "#d6b8ff", border: "#4c3a6b" },
};

/** What an agent's bubble should say right now, if anything. */
export function bubbleFor(a: Agent, said: { text: string; at: number } | undefined, now: number): Bubble | null {
  if (said && now - said.at < 7000) return { text: said.text, tone: "speech" };
  switch (a.status) {
    case "working": return { text: a.activity || "working…", tone: "work" };
    case "out-of-budget": return { text: "Out of budget", tone: "bad" };
    // v1.4: a visitor whose loop isn't connected; it's asleep at its desk or the visitor bench
    case "offline": return { text: "zz", tone: "bad" };
    case "stopped": return { text: "Stopped", tone: "bad" };
    case "banned": return { text: "Banned", tone: "bad" };
    case "in-meeting": return { text: a.activity || "In a meeting", tone: "meet" };
    default: return a.kind === "service" ? { text: a.activity || "Ask me about the library", tone: "muted" } : null;
  }
}

/**
 * Budget line on a building sign: "1.2M today · 40M all-time · 46.7M left" (tokens its residents used, and what its
 * allocations and Bank share still hold); "left" only when it has an allocation or a Bank share; null when nothing was ever used or allocated.
 */
export function buildingBudgetLine(budget: BuildingBudget | undefined): string | null {
  if (!budget) return null;
  const today = budget.tokensToday ?? 0, allTime = budget.tokensAllTime ?? 0;
  const used = allTime > 0 ? `${fmtTokens(today)} today · ${fmtTokens(allTime)} all-time` : "";
  const left = budget.allocatedTokens > 0 || budget.bankTokens > 0 ? `${fmtTokens(budget.remainingTokens)} left` : "";
  return [used, left].filter(Boolean).join(" · ") || null;
}

/** Budget line under a resident's name: today's tokens and what's left of the daily allowance. */
export function residentBudgetLine(a: Agent, dailyTokensPerAgent: number | undefined): string | null {
  if (a.kind !== "resident" || !dailyTokensPerAgent) return null;
  return `${fmtTokens(a.spentTokensToday)} today · ${fmtTokens(Math.max(0, dailyTokensPerAgent - a.spentTokensToday))} left`;
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && (lines.join(" ").length < text.trim().length)) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && g.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/[\s,.;:]+$/, "") + "…";
  }
  return lines;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Name tag centred at (x, y) = just below the feet, with an optional small line (the budget) under it. `manager` adds a gold star after the name. */
export function drawLabel(g: CanvasRenderingContext2D, x: number, y: number, name: string, status: string, highlight: boolean, isMe: boolean, sub?: string | null, manager = false) {
  g.font = FONT;
  const tw = g.measureText(name).width;
  const mw = manager ? g.measureText(" \u2605").width : 0;
  const w = tw + mw + 18, h = 16;
  const lx = Math.round(x - w / 2), ly = Math.round(y);
  g.fillStyle = highlight ? "rgba(124,196,255,.95)" : isMe ? "rgba(255,255,255,.92)" : "rgba(16,17,24,.82)";
  roundRect(g, lx, ly, w, h, 8); g.fill();
  g.fillStyle = STATUS_COLOR[status] ?? "#9a9db3";
  g.beginPath(); g.arc(lx + 8, ly + h / 2, 3, 0, Math.PI * 2); g.fill();
  g.fillStyle = highlight || isMe ? "#14151c" : "#e8e9f0";
  g.textBaseline = "middle";
  g.fillText(name, lx + 14, ly + h / 2 + 0.5);
  if (manager) { g.fillStyle = "#f5c542"; g.fillText(" \u2605", lx + 14 + tw, ly + h / 2 + 0.5); }
  if (!sub) return;
  g.font = SFONT;
  const sw = g.measureText(sub).width + 10, sh = 12;
  const sx = Math.round(x - sw / 2), sy = ly + h + 1;
  g.fillStyle = "rgba(16,17,24,.7)";
  roundRect(g, sx, sy, sw, sh, 6); g.fill();
  g.fillStyle = "#b8bbcc"; g.textAlign = "center";
  g.fillText(sub, x, sy + sh / 2 + 0.5);
  g.textAlign = "left";
}

/** Bubble whose tail points at (x, y) = just above the head. */
export function drawBubble(g: CanvasRenderingContext2D, x: number, y: number, b: Bubble, full: boolean) {
  g.font = BFONT;
  const maxW = full ? 210 : 150;
  const lines = wrap(g, b.text, maxW, full ? 4 : 2);
  const lh = 14, padX = 7, padY = 5;
  const w = Math.min(maxW, Math.max(...lines.map((l) => g.measureText(l).width))) + padX * 2;
  const h = lines.length * lh + padY * 2;
  const bx = Math.round(x - w / 2), by = Math.round(y - h - 7);
  const c = TONE[b.tone];
  g.fillStyle = c.bg; g.strokeStyle = c.border; g.lineWidth = 1;
  roundRect(g, bx + 0.5, by + 0.5, w, h, 6); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(x - 5, by + h); g.lineTo(x, by + h + 6); g.lineTo(x + 5, by + h); g.closePath();
  g.fill();
  g.beginPath(); g.moveTo(x - 5, by + h + 0.5); g.lineTo(x, by + h + 6.5); g.lineTo(x + 5, by + h + 0.5); g.stroke();
  g.fillStyle = c.bg; g.fillRect(x - 4, by + h - 1, 8, 2);
  g.fillStyle = c.fg; g.textBaseline = "top";
  lines.forEach((l, i) => g.fillText(l, bx + padX, by + padY + i * lh + 1));
}

/** Count badge (the in-tray on a manager's desk; "×N" over stacked bodies), centred at (x, y). */
/** `neutral`: grey (a stack's ×N, a count of bodies, not a problem); red otherwise. Returns its box, for hit-testing. */
export function drawBadge(g: CanvasRenderingContext2D, x: number, y: number, n: number | string, tone: "bad" | "neutral" = "bad", hl = false) {
  const text = typeof n === "string" ? n : n > 99 ? "99+" : String(n);
  g.font = "700 10px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const w = Math.max(16, g.measureText(text).width + 9), h = 16;
  const bx = Math.round(x - w / 2), by = Math.round(y - h / 2);
  g.fillStyle = tone === "neutral" ? "#5d6177" : "#e5484d"; g.strokeStyle = hl ? "#fff" : "#14151c"; g.lineWidth = 2;
  roundRect(g, bx, by, w, h, 8); g.stroke(); g.fill();
  g.fillStyle = "#fff"; g.textBaseline = "middle"; g.textAlign = "center";
  g.fillText(text, x, by + h / 2 + 0.5);
  g.textAlign = "left";
  return { x: bx, y: by, w, h };
}

/** A hover card whose top-left sits near (x, y), kept inside the `cw`×`ch` canvas: a bold title, then one wrapped item per line. */
export function drawTip(g: CanvasRenderingContext2D, x: number, y: number, title: string, items: string[], cw: number, ch: number) {
  const max = 280, pad = 8, lh = 14;
  const font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", bold = `700 ${font}`;
  g.font = font;
  const rows = items.flatMap((t) => wrapText(g, `• ${t}`, max).map((l, i) => (i ? `   ${l}` : l)));
  const rowsW = Math.max(0, ...rows.map((r) => g.measureText(r).width));
  g.font = bold;
  const heads = wrapText(g, title, max);
  const w = Math.min(max, Math.max(rowsW, ...heads.map((t) => g.measureText(t).width))) + pad * 2;
  const h = pad * 2 + lh * (rows.length + heads.length) + 2;
  const bx = Math.round(Math.max(4, Math.min(cw - w - 4, x))), by = Math.round(Math.max(4, Math.min(ch - h - 4, y)));
  g.fillStyle = "rgba(20,21,28,.94)"; g.strokeStyle = "#e5484d"; g.lineWidth = 1;
  roundRect(g, bx, by, w, h, 6); g.fill(); g.stroke();
  g.textBaseline = "top"; g.textAlign = "left";
  g.font = bold; g.fillStyle = "#ff8b8e";
  heads.forEach((t, i) => g.fillText(t, bx + pad, by + pad + lh * i));
  g.font = font; g.fillStyle = "#e4e6f2";
  rows.forEach((r, i) => g.fillText(r, bx + pad, by + pad + lh * (i + heads.length) + 2));
}

/** A dashed red line from a blocked agent (a) to what blocks it (b), screen px, with a dot at b. */
export function drawBlockLine(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, hl: boolean) {
  g.strokeStyle = hl ? "rgba(255,93,98,.95)" : "rgba(229,72,77,.6)"; g.lineWidth = hl ? 2.5 : 1.5;
  g.setLineDash([6, 4]);
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  g.setLineDash([]);
  g.fillStyle = g.strokeStyle;
  g.beginPath(); g.arc(b.x, b.y, hl ? 4 : 3, 0, Math.PI * 2); g.fill();
}

/** Small amber pill (e.g. "⟳ redeploy") whose bottom-left sits at (x, y): an agent held by a draining redeploy. */
export function drawPill(g: CanvasRenderingContext2D, x: number, y: number, text: string) {
  g.font = "700 9px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const w = g.measureText(text).width + 10, h = 13;
  const bx = Math.round(x), by = Math.round(y - h);
  g.fillStyle = "#ffcf5e"; g.strokeStyle = "#14151c"; g.lineWidth = 2;
  roundRect(g, bx, by, w, h, 6); g.stroke(); g.fill();
  g.fillStyle = "#2d2612"; g.textBaseline = "middle";
  g.fillText(text, bx + 5, by + h / 2 + 0.5);
}

/** Break `text` into lines no wider than `max` px in the current font (a single over-long word gets its own line). */
export function wrapText(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > max) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const NFONT = "700 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
/**
 * A building's banner above its lot (bottom at y): a cloth hung from a wooden pole on two posts, with the name,
 * the full goal wrapped (or the town's name, for the Town Hall) and an optional budget line. `hl` brightens it
 * for hover. Returns the banner's screen rect, for click-to-open.
 */
export function drawSign(g: CanvasRenderingContext2D, x: number, y: number, name: string, sub: string, budget?: string | null, hl = false, light?: Stoplight | null) {
  g.font = NFONT;
  const nw = g.measureText(name).width;
  g.font = BFONT;
  const lines = sub ? wrapText(g, sub, Math.max(200, Math.min(nw, 280))) : [];
  const tw = Math.max(nw, ...lines.map((l) => g.measureText(l).width), budget ? g.measureText(budget).width : 0);
  const w = Math.round(Math.max(tw + 28, 110)), tail = 7, lh = 13;
  const body = 8 + 15 + lines.length * lh + (budget ? lh + 2 : 0) + 6;
  const ch = body + tail, rodY = Math.round(y - ch - 10);
  const cx = Math.round(x - w / 2), top = rodY + 3, bot = top + body;
  // posts down to the ground, then the rod with round finials
  g.fillStyle = "#2a1a0c";
  g.fillRect(cx - 7, rodY, 4, y - rodY); g.fillRect(cx + w + 3, rodY, 4, y - rodY);
  g.fillStyle = "#8a5a2b";
  g.fillRect(cx - 6, rodY + 1, 2, y - rodY - 1); g.fillRect(cx + w + 4, rodY + 1, 2, y - rodY - 1);
  g.fillStyle = "#2a1a0c"; g.fillRect(cx - 12, rodY - 2, w + 24, 6);
  g.fillStyle = "#b07a40"; g.fillRect(cx - 11, rodY - 1, w + 22, 4);
  g.fillStyle = "#d9a466"; g.fillRect(cx - 11, rodY - 1, w + 22, 1);
  for (const fx of [cx - 13, cx + w + 13]) {
    g.beginPath(); g.arc(fx, rodY + 1, 4, 0, Math.PI * 2); g.fillStyle = "#2a1a0c"; g.fill();
    g.beginPath(); g.arc(fx, rodY + 1, 2.8, 0, Math.PI * 2); g.fillStyle = "#e3b04b"; g.fill();
  }
  // the cloth: straight sides, a swallowtail hem, a fold shading across it
  const cloth = () => {
    g.beginPath(); g.moveTo(cx, top); g.lineTo(cx + w, top); g.lineTo(cx + w, bot + tail);
    g.lineTo(x, bot); g.lineTo(cx, bot + tail); g.closePath();
  };
  const grad = g.createLinearGradient(cx, 0, cx + w, 0);
  const [c0, c1] = hl ? ["#9a3340", "#b8424f"] : ["#6e1f2a", "#8c2a36"];
  grad.addColorStop(0, c0); grad.addColorStop(0.35, c1); grad.addColorStop(0.65, c0); grad.addColorStop(1, c1);
  cloth(); g.fillStyle = grad; g.fill();
  g.strokeStyle = "#2a0d12"; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
  // stitched border inset from the edge
  g.save(); g.setLineDash([3, 2]); g.strokeStyle = "rgba(246,231,200,.45)";
  g.beginPath(); g.moveTo(cx + 4, top + 4); g.lineTo(cx + w - 4, top + 4); g.lineTo(cx + w - 4, bot + tail - 6);
  g.lineTo(x, bot - 4); g.lineTo(cx + 4, bot + tail - 6); g.closePath(); g.stroke(); g.restore();
  // loops where the cloth wraps the rod
  g.fillStyle = "#4a141c";
  for (let i = 0, n = Math.max(2, Math.round(w / 40)); i <= n; i++) g.fillRect(Math.round(cx + 2 + ((w - 8) * i) / n), rodY - 2, 4, 7);
  g.textBaseline = "top"; g.textAlign = "center";
  g.font = NFONT; g.fillStyle = "#2a0d12"; g.fillText(name, x, top + 8);
  g.fillStyle = "#f6e7c8"; g.fillText(name, x, top + 7);
  let ty = top + 7 + 16;
  g.font = BFONT; g.fillStyle = "#ffd98a";
  for (const l of lines) { g.fillText(l, x, ty); ty += lh; }
  if (budget) { g.fillStyle = "#9ff0b4"; g.fillText(budget, x, ty + 2); }
  g.textAlign = "left";
  // goal-directed: the stoplight housing mounted on the right post, under the finial; its reason as a tooltip on hover
  if (light) {
    drawStoplight(g, cx + w - 1, rodY + 9, light.light);
    if (hl) drawSignTip(g, x, rodY - 9, light);
  }
  return { x: cx - 17, y: rodY - 5, w: w + 34, h: y - rodY + 5 };
}

const LAMP: Record<Stoplight["light"], string> = { red: "#ff5f5f", yellow: "#ffcf5e", green: "#6fdc8c" };
/** A traffic-light housing with its top-left at (x, y): three lamps, red over yellow over green, only `light` lit (with a glow). */
export function drawStoplight(g: CanvasRenderingContext2D, x: number, y: number, light: Stoplight["light"]) {
  const w = 16, h = 38;
  g.fillStyle = "#0d0e13"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
  roundRect(g, x, y, w, h, 5); g.fill(); g.stroke(); g.lineWidth = 1;
  g.fillStyle = "#2a2d3a"; g.fillRect(x + 3, y + 2, w - 6, 1); // a highlight on the housing's top edge
  (["red", "yellow", "green"] as const).forEach((k, i) => {
    const cy = y + 7.5 + i * 11.5, on = k === light;
    g.beginPath(); g.arc(x + w / 2, cy, 4.4, 0, Math.PI * 2);
    if (on) { g.save(); g.shadowColor = LAMP[k]; g.shadowBlur = 9; g.fillStyle = LAMP[k]; g.fill(); g.restore(); }
    else { g.fillStyle = "#23252e"; g.fill(); g.strokeStyle = "#1a1b22"; g.stroke(); }
  });
}

/** The hovered banner's stoplight line, in a dark tip above the rod (bottom edge at y, centred on x): "Blocked: no key results to work toward". */
function drawSignTip(g: CanvasRenderingContext2D, x: number, y: number, light: Stoplight) {
  g.font = BFONT;
  const label = stoplightLabel(light.light);
  const lines = wrapText(g, `${label}: ${light.reason}`, 260);
  const lh = 14, padX = 8, padY = 5;
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + padX * 2, h = lines.length * lh + padY * 2;
  const bx = Math.round(x - w / 2), by = Math.round(y - h);
  g.fillStyle = "rgba(20,21,28,.94)"; g.strokeStyle = LAMP[light.light]; g.lineWidth = 1.5;
  roundRect(g, bx, by, w, h, 5); g.fill(); g.stroke(); g.lineWidth = 1;
  // a small stem down to the rod
  g.fillStyle = LAMP[light.light]; g.fillRect(Math.round(x) - 1, by + h, 2, 4);
  g.textBaseline = "top"; g.textAlign = "left";
  lines.forEach((l, i) => {
    g.fillStyle = i === 0 ? LAMP[light.light] : "#f6e7c8";
    if (i === 0) { g.fillText(label + ":", bx + padX, by + padY); g.fillStyle = "#f6e7c8"; g.fillText(l.slice(label.length + 1), bx + padX + g.measureText(label + ":").width, by + padY); }
    else g.fillText(l, bx + padX, by + padY + i * lh);
  });
}

const SANS = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
/**
 * The Bank's marquee, hung outside its front (bottom edge at y): the town's tokens in big gold digits, split into
 * today's expiring daily allowance, the Bank's permanent pool, and what buildings hold from direct donations.
 * `bank` null = not loaded yet.
 */
export function drawBankSign(g: CanvasRenderingContext2D, x: number, y: number, bank: { townTokens: number; expiringTokens: number; durableTokens: number; heldTokens: number } | null, now: number) {
  const n = (v: number) => v.toLocaleString("en-US");
  const total = bank ? n(bank.townTokens) : "…";
  const parts = [
    { label: "EXPIRES TODAY", value: bank ? n(bank.expiringTokens) : "…", color: "#ffb26b" },
    { label: "PERMANENT", value: bank ? n(bank.durableTokens) : "…", color: "#9ff0b4" },
    { label: "HELD BY BUILDINGS", value: bank ? n(bank.heldTokens) : "…", color: "#9fd4ff" },
  ];
  g.font = `800 30px ${SANS}`;
  const tw = g.measureText(total).width;
  g.font = `700 15px ${SANS}`;
  const colW = Math.max(...parts.map((p) => g.measureText(p.value).width), 96) + 24;
  const title = "THE BANK · ADJ. TOKENS AVAILABLE TO THE TOWN";
  g.font = `800 11px ${SANS}`;
  const w = Math.round(Math.max(tw + 48, colW * parts.length + 16, g.measureText(title).width + 32, 240)), h = 112;
  const sx = Math.round(x - w / 2), sy = Math.round(y - h);
  // dark plate, double gold border with a slow shimmer running round it
  const grad = g.createLinearGradient(sx, sy, sx, sy + h);
  grad.addColorStop(0, "rgba(38,28,8,.94)"); grad.addColorStop(1, "rgba(16,12,4,.94)");
  g.fillStyle = grad; roundRect(g, sx + 0.5, sy + 0.5, w, h, 8); g.fill();
  const t = (now / 2600) % 1;
  const rim = g.createLinearGradient(sx, sy, sx + w, sy + h);
  rim.addColorStop(0, "#b3851a"); rim.addColorStop(Math.max(0, t - 0.08), "#e8bf3f"); rim.addColorStop(t, "#fff6c8"); rim.addColorStop(Math.min(1, t + 0.08), "#e8bf3f"); rim.addColorStop(1, "#b3851a");
  g.strokeStyle = rim; g.lineWidth = 2.5; roundRect(g, sx + 0.5, sy + 0.5, w, h, 8); g.stroke();
  g.strokeStyle = "rgba(242,201,76,.35)"; g.lineWidth = 1; roundRect(g, sx + 4.5, sy + 4.5, w - 8, h - 8, 5); g.stroke();
  g.textAlign = "center"; g.textBaseline = "top";
  g.font = `800 11px ${SANS}`; g.fillStyle = "#e8bf3f";
  g.fillText(title, x, sy + 10);
  // the total in big gold digits, with a darker drop
  g.font = `800 30px ${SANS}`;
  g.fillStyle = "#5c3f08"; g.fillText(total, x, sy + 27);
  const gold = g.createLinearGradient(0, sy + 25, 0, sy + 57);
  gold.addColorStop(0, "#fff1b0"); gold.addColorStop(0.5, "#f2c94c"); gold.addColorStop(1, "#c8921c");
  g.fillStyle = gold; g.fillText(total, x, sy + 25);
  // the pools side by side, with a rule between each
  const cols = parts.length;
  g.strokeStyle = "rgba(242,201,76,.3)";
  for (let i = 1; i < cols; i++) { const lx = Math.round(sx + (w * i) / cols) + 0.5; g.beginPath(); g.moveTo(lx, sy + 66); g.lineTo(lx, sy + h - 10); g.stroke(); }
  parts.forEach((p, i) => {
    const cx = sx + (w * (i + 0.5)) / cols;
    g.font = `700 9px ${SANS}`; g.fillStyle = "#c9b98a"; g.fillText(p.label, cx, sy + 68);
    g.font = `700 15px ${SANS}`; g.fillStyle = p.color; g.fillText(p.value, cx, sy + 81);
  });
  g.textAlign = "left";
}
