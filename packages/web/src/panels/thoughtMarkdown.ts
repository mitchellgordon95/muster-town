/** Inline markdown in an agent thought (grant gr_7h6r66d10i): pure helpers for ThoughtText and the head line. */
const LIST_OR_HEADING = /^\s*(?:[-*+•]\s+|\d+[.)]\s+|#{1,6}\s+)/;
const INLINE = /\*\*(.+?)\*\*|`([^`\n]+)`/g;

/** One line split into plain text, bold and code spans. */
export function inlineParts(line: string): { kind: "text" | "bold" | "code"; text: string }[] {
  const out: { kind: "text" | "bold" | "code"; text: string }[] = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index! > at) out.push({ kind: "text", text: line.slice(at, m.index) });
    out.push(m[1] !== undefined ? { kind: "bold", text: m[1] } : { kind: "code", text: m[2] });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ kind: "text", text: line.slice(at) });
  return out;
}

/** The thought's lines, list markers and heading hashes taken off, blank lines dropped. */
export function thoughtLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(LIST_OR_HEADING, "").trim()).filter(Boolean);
}

/** Markdown characters taken off (for one-line places like the panel's head line). */
export const plainThought = (text: string) => thoughtLines(text).map((l) => inlineParts(l).map((p) => p.text).join("")).join(" ");
