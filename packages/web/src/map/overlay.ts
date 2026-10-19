/** Screen-space text: name labels and bubbles, drawn crisp on top of the scaled pixel layer. */
import type { Agent } from "@agent-town/schema";

export const STATUS_COLOR: Record<string, string> = {
  idle: "#9a9db3", walking: "#7cc4ff", working: "#6fdc8c", "in-meeting": "#c79bff",
  "awaiting-review": "#ffcf5e", "out-of-budget": "#ff9f5e", stopped: "#ff7b7b", banned: "#ff7b7b",
};

export interface Bubble { text: string; tone: "speech" | "work" | "warn" | "muted" | "bad" | "meet" }

const FONT = "600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
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
    case "awaiting-review": return { text: "Report ready for review", tone: "warn" };
    case "out-of-budget": return { text: "Out of budget", tone: "bad" };
    case "stopped": return { text: "Stopped", tone: "bad" };
    case "banned": return { text: "Banned", tone: "bad" };
    case "in-meeting": return { text: a.activity || "In a meeting", tone: "meet" };
    default: return a.kind === "service" ? { text: a.activity || "Ask me about the library", tone: "muted" } : null;
  }
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

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Name tag centred at (x, y) = just below the feet. */
export function drawLabel(g: CanvasRenderingContext2D, x: number, y: number, name: string, status: string, highlight: boolean, isMe: boolean) {
  g.font = FONT;
  const tw = g.measureText(name).width;
  const w = tw + 18, h = 16;
  const lx = Math.round(x - w / 2), ly = Math.round(y);
  g.fillStyle = highlight ? "rgba(124,196,255,.95)" : isMe ? "rgba(255,255,255,.92)" : "rgba(16,17,24,.82)";
  roundRect(g, lx, ly, w, h, 8); g.fill();
  g.fillStyle = STATUS_COLOR[status] ?? "#9a9db3";
  g.beginPath(); g.arc(lx + 8, ly + h / 2, 3, 0, Math.PI * 2); g.fill();
  g.fillStyle = highlight || isMe ? "#14151c" : "#e8e9f0";
  g.textBaseline = "middle";
  g.fillText(name, lx + 14, ly + h / 2 + 0.5);
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

/** Building sign above a lot. */
export function drawSign(g: CanvasRenderingContext2D, x: number, y: number, name: string, sub: string) {
  g.font = "700 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const w = Math.max(g.measureText(name).width, sub ? (g.font = BFONT, g.measureText(sub).width) : 0) + 20;
  const h = sub ? 34 : 22;
  const sx = Math.round(x - w / 2), sy = Math.round(y - h);
  g.fillStyle = "rgba(16,17,24,.88)"; g.strokeStyle = "#3a3e55";
  roundRect(g, sx + 0.5, sy + 0.5, w, h, 6); g.fill(); g.stroke();
  g.textBaseline = "top"; g.textAlign = "center";
  g.font = "700 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  g.fillStyle = "#e8e9f0"; g.fillText(name, x, sy + 5);
  if (sub) { g.font = BFONT; g.fillStyle = "#ffcf5e"; g.fillText(sub, x, sy + 19); }
  g.textAlign = "left";
}
