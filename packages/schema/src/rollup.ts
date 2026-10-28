/**
 * The rollup format (town hall mt_rjhwj2qggm, notes dc_z4zgfk6tsz, decision 5; made the town default in 1:1
 * mt_vcn0e66r1t): four sections, and each Shipped item says what it is, what you'd see (with one cropped picture) and
 * the human's call. `submit_report` checks it (headings required, labels warned) and the Town Hall in-tray renders the
 * Shipped items as cards when the labels are there, falling back to plain markdown otherwise.
 */

/** The four headings of a rollup, in order (`## Needs from …` names the collective's owner, so any name matches). */
export const ROLLUP_SECTIONS = ["Shipped", "Decided", "Key results", "Needs from"] as const;
/** The three labels of a Shipped item (the picture sits between "What you'd see" and "Your call"). */
export const ROLLUP_LABELS = ["What it is", "What you'd see", "Your call"] as const;
/** One screen: at most this many Shipped items and pictures. */
export const ROLLUP_MAX_ITEMS = 3;
export const ROLLUP_MAX_PICTURES = 2;

export interface RollupPicture { alt: string; src: string }
export interface RollupItem {
  title: string;
  whatItIs: string;
  whatYoudSee: string;
  pictures: RollupPicture[];
  yourCall: string;
  /** Markdown after the item's "Your call" paragraph (rendered under the card). */
  after: string;
  /** The labels it lacks (empty = a full card). */
  missing: string[];
}
export interface ParsedRollup {
  /** Markdown before "## Shipped" (the optional intro line). */
  before: string;
  /** Markdown between "## Shipped" and its first numbered item. */
  shippedIntro: string;
  items: RollupItem[];
  /** Markdown from the heading after Shipped to the end (Decided, Key results, Needs). */
  after: string;
  /** Headings of ROLLUP_SECTIONS the body lacks. */
  missingSections: string[];
}

const HEADING = /^##\s+(.+?)\s*#*\s*$/;
const sectionOf = (h: string) => ROLLUP_SECTIONS.find((s) => h.toLowerCase().replace(/[*_]/g, "").trim().startsWith(s.toLowerCase()));
// "**1. Title**", "1. **Title**", "1) Title", "### 1. Title", "### Title"
const ITEM = /^(?:###\s+|\*\*\s*(?=\d+[.)]\s)|(?=\d+[.)]\s))/;
// "**What it is:** x", "**What it is**: x", "What it is: x", "- What it is: x"
const LABEL = /^(?:[-*]\s+)?(?:\*\*|__)?\s*(what it is|what you['’]d see|your call)\s*(?::\s*(?:\*\*|__)?|(?:\*\*|__)\s*:?)\s*/i;
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const labelKey = (l: string) => l.toLowerCase().startsWith("what it") ? "whatItIs" : l.toLowerCase().startsWith("your") ? "yourCall" : "whatYoudSee";
const LABEL_NAME = { whatItIs: ROLLUP_LABELS[0], whatYoudSee: ROLLUP_LABELS[1], yourCall: ROLLUP_LABELS[2] } as const;

function itemTitle(line: string): string {
  return line.replace(/^###\s+/, "").replace(/\*\*|__/g, "").replace(/^\s*\d+[.)]\s*/, "").trim();
}

function parseItem(lines: string[]): RollupItem {
  const fields = { whatItIs: [] as string[], whatYoudSee: [] as string[], yourCall: [] as string[] };
  const seen = new Set<keyof typeof fields>();
  const pictures: RollupPicture[] = [];
  const pre: string[] = [];
  const after: string[] = [];
  let cur: keyof typeof fields | null = null;
  let callDone = false;
  for (const raw of lines.slice(1)) {
    if (callDone) { after.push(raw); continue; }
    const m = LABEL.exec(raw);
    if (m) { cur = labelKey(m[1]!); seen.add(cur); raw.slice(m[0].length) && fields[cur].push(raw.slice(m[0].length)); continue; }
    // the "Your call" paragraph ends at a blank line; what follows goes under the card
    if (cur === "yourCall" && !raw.trim() && fields.yourCall.length) { callDone = true; continue; }
    const text = raw.replace(IMAGE, (_, alt: string, src: string) => { pictures.push({ alt, src }); return ""; });
    if (!text.trim() && raw.trim()) continue; // a line that was only pictures
    (cur ? fields[cur] : pre).push(text);
  }
  const join = (ls: string[]) => ls.join("\n").trim();
  // text between the title and the first label reads as "what it is" when that label is missing
  if (!seen.has("whatItIs") && join(pre)) fields.whatItIs = pre;
  else if (join(pre)) fields.whatItIs = [...pre, ...fields.whatItIs];
  const missing = (Object.keys(LABEL_NAME) as (keyof typeof fields)[]).filter((k) => !seen.has(k)).map((k) => LABEL_NAME[k]);
  return { title: itemTitle(lines[0]!), whatItIs: join(fields.whatItIs), whatYoudSee: join(fields.whatYoudSee), pictures, yourCall: join(fields.yourCall), after: join(after), missing };
}

/** Split a rollup body into its intro, Shipped items and the rest. Never throws; a body without "## Shipped" has no items. */
export function parseRollup(body: string): ParsedRollup {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const present = new Set<string>();
  let shippedAt = -1, shippedEnd = lines.length;
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const h = fence ? null : HEADING.exec(l);
    if (!h) return;
    const s = sectionOf(h[1]!);
    if (s) present.add(s);
    if (s === "Shipped" && shippedAt < 0) shippedAt = i;
    else if (shippedAt >= 0 && i > shippedAt && shippedEnd === lines.length) shippedEnd = i;
  });
  const missingSections = ROLLUP_SECTIONS.filter((s) => !present.has(s)).map((s) => s === "Needs from" ? "Needs from Mitchell" : s);
  if (shippedAt < 0) return { before: body.trim(), shippedIntro: "", items: [], after: "", missingSections };
  const section = lines.slice(shippedAt + 1, shippedEnd);
  const starts = section.flatMap((l, i) => ITEM.test(l) && itemTitle(l) ? [i] : []);
  const items = starts.map((s, n) => parseItem(section.slice(s, starts[n + 1] ?? section.length)));
  return {
    before: lines.slice(0, shippedAt).join("\n").trim(),
    shippedIntro: section.slice(0, starts[0] ?? section.length).join("\n").trim(),
    items,
    after: lines.slice(shippedEnd).join("\n").trim(),
    missingSections,
  };
}

/** True when every Shipped item carries the three labels (the in-tray then shows cards). */
export function rollupHasCards(p: ParsedRollup): boolean {
  return p.items.length > 0 && p.items.every((it) => !it.missing.length);
}

/** What `submit_report` tells a manager about a rollup's format: missing labels, too many items or pictures. Headings are checked separately (refused). */
export function rollupWarnings(p: ParsedRollup): string[] {
  const out = p.items.flatMap((it, i) => it.missing.length ? [`Shipped item ${i + 1} ("${it.title.slice(0, 60)}") lacks ${it.missing.map((l) => `**${l}:**`).join(", ")}`] : []);
  if (p.items.length > ROLLUP_MAX_ITEMS) out.push(`${p.items.length} Shipped items; keep it to ${ROLLUP_MAX_ITEMS} (one screen)`);
  const pics = p.items.reduce((n, it) => n + it.pictures.length, 0);
  if (pics > ROLLUP_MAX_PICTURES) out.push(`${pics} pictures; keep it to ${ROLLUP_MAX_PICTURES}`);
  return out;
}

/**
 * What "## Needs from Mitchell" may carry (1:1 mt_uf1bwd3exq): only what has no other channel. `submit_report` refuses
 * a Needs section that names an item already waiting for a human elsewhere, and appends the generated in-tray line.
 */
export const ROLLUP_MAX_NEEDS = 2;
export const ROLLUP_NEEDS_RULE = `"## Needs from Mitchell" carries at most ${ROLLUP_MAX_NEEDS} items, and only what has no other channel: a decision Mitchell reserved, a question needing an answer in words, a 1:1 invite, or a real-world action with no outbox request. Never an open grant proposal or checkpoint (gr_…), an open outbox request or a report already in the Town Hall in-tray (dc_…): Mitchell sees those there, and the town appends an "Already waiting in your in-tray" line listing them.`;

const NEEDS_ID = /\b(?:gr|dc)_[a-z0-9]+\b/g;

/** The line range [start, end) of the "## Needs from …" section (start = the heading), or null. */
function needsRange(lines: string[]): [number, number] | null {
  let fence = false, start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) fence = !fence;
    const h = fence ? null : HEADING.exec(lines[i]!);
    if (!h) continue;
    if (start >= 0) return [start, i];
    if (sectionOf(h[1]!) === "Needs from") start = i;
  }
  return start >= 0 ? [start, lines.length] : null;
}

/** The text of the Needs section (without its heading); "" when there is none. */
function rollupNeeds(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const r = needsRange(lines);
  return r ? lines.slice(r[0] + 1, r[1]).join("\n").trim() : "";
}

/** The gr_/dc_ ids the Needs section names, in order, once each. */
export function rollupNeedsIds(body: string): string[] {
  return [...new Set(rollupNeeds(body).match(NEEDS_ID) ?? [])];
}

/** The Needs section's list items (lines starting "- ", "* " or "1. "); 0 for prose or "Nothing needed". */
export function rollupNeedsCount(body: string): number {
  return rollupNeeds(body).split("\n").filter((l) => /^(?:[-*]|\d+[.)])\s+\S/.test(l)).length;
}

/** The body with `line` appended at the end of its Needs section (or at the end of the body when it has none). */
export function withNeedsLine(body: string, line: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const r = needsRange(lines);
  if (!r || r[1] === lines.length) return `${body.trimEnd()}\n\n${line}`;
  let end = r[1];
  while (end > r[0] + 1 && !lines[end - 1]!.trim()) end--;
  return [...lines.slice(0, end), "", line, "", ...lines.slice(r[1])].join("\n");
}
