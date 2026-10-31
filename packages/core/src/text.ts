/** Small text helpers shared by prompts and memory (no world access). */
import type { Doc } from "@muster-town/schema";

export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/** The body of a markdown `## heading` section (up to the next `#`/`##` heading), trimmed; "" when absent. */
export function sectionOf(body: string, heading: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim().replace(/^#+\s*/, "").toLowerCase() === heading.toLowerCase() && /^#{1,6}\s/.test(l.trim()));
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l.trim()));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
}

export const NEED = "What I need from you";
export const oneLine = (s: string, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** One line describing a doc: a report's "What I need from you" first line, else the body's first non-heading line. */
export function docGist(d: Doc): string {
  const firstText = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l)) ?? "";
  const line = (d.type === "report" ? firstText(sectionOf(d.body, NEED)) : "") || firstText(d.body);
  return oneLine(line) || "(empty)";
}

/** FTS5 query from free text: quoted terms OR'd together (ranked by bm25). */
export function ftsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}]+/gu);
  if (!terms?.length) return null;
  return terms.slice(0, 20).map((t) => `"${t}"`).join(" OR ");
}
