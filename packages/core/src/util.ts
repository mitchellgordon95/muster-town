import { customAlphabet, nanoid } from "nanoid";
import type { Tile } from "@muster-town/schema";

const alnum = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export type IdPrefix = "ag" | "bl" | "dc" | "as" | "mt" | "ms" | "us" | "se" | "al" | "rl" | "in" | "bi" | "bc" | "bd" | "pl" | "gr" | "kr" | "ob" | "sp" | "ar" | "mf" | "sc" | "gl" | "gp";
/** `ag_x1y2z3...` style ids (see Conventions). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${alnum()}`;
}
export function newToken(): string {
  return `at_${nanoid(32)}`;
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function chebyshev(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export class Emitter<T> {
  private listeners = new Set<(v: T) => void>();
  subscribe(fn: (v: T) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  emit(v: T): void {
    for (const fn of this.listeners) {
      try { fn(v); } catch (e) { console.error("[core] listener error", e); }
    }
  }
}

export function slugify(s: string, max = 50): string {
  const slug = s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return (slug.slice(0, max).replace(/-+$/, "") || "untitled");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Frontmatter: `---\nkey: value\n---\nbody`. Values are parsed as JSON when possible
 * (the export format writes JSON values), otherwise kept as strings (v0 wrote plain YAML scalars).
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].trim();
    let v: unknown = raw;
    if (raw !== "") {
      try { v = JSON.parse(raw); } catch { v = raw.replace(/^'(.*)'$/, "$1"); }
    }
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

/**
 * The content of a markdown section whose heading matches `re` (e.g. /proposal/i),
 * up to the next heading of the same or higher level. Null if absent.
 */
export function extractSection(md: string, re: RegExp): string | null {
  const lines = md.split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!h) continue;
    if (start < 0) {
      if (re.test(h[2])) { start = i + 1; level = h[1].length; }
    } else if (h[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n").trim();
}

/** First meaningful line of markdown, stripped of heading/list/bold label syntax. */
export function firstLine(md: string, max = 120): string {
  for (const raw of md.split(/\r?\n/)) {
    let l = raw.trim();
    if (!l) continue;
    l = l.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    l = l.replace(/^\*\*[^*]{1,40}:\*\*\s*/, "").replace(/^\*\*([^*]+)\*\*$/, "$1");
    l = l.replace(/\*\*/g, "").trim();
    if (l) return truncate(l, max);
  }
  return "";
}
