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
/** "What it is" is read in a glance: over this many words the filing warns (the detail belongs in the covered reports). */
export const ROLLUP_MAX_WHAT_WORDS = 80;

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
  /** The three sections after Shipped, each without its heading ("" when absent); `other` is any heading in between that isn't one of them. */
  sections: { decided: string; keyResults: string; needs: string; other: string };
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
  const sections = splitSections(lines.slice(shippedAt < 0 ? 0 : shippedEnd));
  if (shippedAt < 0) return { before: body.trim(), shippedIntro: "", items: [], after: "", sections, missingSections };
  const section = lines.slice(shippedAt + 1, shippedEnd);
  const starts = section.flatMap((l, i) => ITEM.test(l) && itemTitle(l) ? [i] : []);
  const items = starts.map((s, n) => parseItem(section.slice(s, starts[n + 1] ?? section.length)));
  return {
    before: lines.slice(0, shippedAt).join("\n").trim(),
    shippedIntro: section.slice(0, starts[0] ?? section.length).join("\n").trim(),
    items,
    after: lines.slice(shippedEnd).join("\n").trim(),
    sections,
    missingSections,
  };
}

/** The Decided / Key results / Needs sections of the lines after Shipped, each without its heading; other "##" headings keep theirs under `other`. */
function splitSections(lines: string[]): ParsedRollup["sections"] {
  const out = { decided: [] as string[], keyResults: [] as string[], needs: [] as string[], other: [] as string[] };
  let cur: keyof typeof out = "other", fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    const h = fence ? null : HEADING.exec(l);
    const s = h ? sectionOf(h[1]!) : undefined;
    if (s === "Decided" || s === "Key results" || s === "Needs from") { cur = s === "Decided" ? "decided" : s === "Key results" ? "keyResults" : "needs"; continue; }
    if (h) cur = "other";
    out[cur].push(l);
  }
  const join = (ls: string[]) => ls.join("\n").trim();
  return { decided: join(out.decided), keyResults: join(out.keyResults), needs: join(out.needs), other: join(out.other) };
}

/** A "Your call" that asks nothing: empty or "None…" (markdown stripped). The deck's isNoCall says the same. */
const noCall = (call: string) => !call.trim() || /^none\b/i.test(call.replace(/[*_`]/g, "").trim());

/**
 * What the rollup asks the human, in the order they read it (the report view and the deck put these first): each Shipped
 * item whose "Your call" is not None (with its number and title), then the Needs section's own lines, the generated
 * "Already waiting" line and "Nothing needed" left out. Empty = for the record.
 */
export function rollupAsks(p: ParsedRollup): { n: number | null; title: string; call: string }[] {
  const items = p.items.flatMap((it, i) => noCall(it.yourCall) ? [] : [{ n: i + 1, title: it.title, call: it.yourCall.replace(/\s+/g, " ").trim() }]);
  const needs = withoutWaitingLine(p.sections.needs).split("\n").map((l) => l.trim()).filter((l) => l && !NOTHING.test(plainLine(l)))
    .map((l) => ({ n: null, title: "", call: l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "") }));
  return [...items, ...needs];
}

/** True when every Shipped item carries the three labels (the in-tray then shows cards). */
export function rollupHasCards(p: ParsedRollup): boolean {
  return p.items.length > 0 && p.items.every((it) => !it.missing.length);
}

/** What `submit_report` tells a manager about a rollup's format: missing labels, too many items or pictures. Headings are checked separately (refused). */
export function rollupWarnings(p: ParsedRollup): string[] {
  const out = p.items.flatMap((it, i) => it.missing.length ? [`Shipped item ${i + 1} ("${it.title.slice(0, 60)}") lacks ${it.missing.map((l) => `**${l}:**`).join(", ")}`] : []);
  for (const [i, it] of p.items.entries()) {
    const words = it.whatItIs.split(/\s+/).filter(Boolean).length;
    if (words > ROLLUP_MAX_WHAT_WORDS) out.push(`Shipped item ${i + 1} ("${it.title.slice(0, 60)}"): "What it is" is ${words} words; keep it under ${ROLLUP_MAX_WHAT_WORDS} (two or three sentences; the detail is in the covered reports)`);
  }
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
export function rollupNeedsRule(captain: string): string {
  return `"## Needs from ${captain}" carries at most ${ROLLUP_MAX_NEEDS} items, and only what has no other channel: a decision ${captain} reserved, a question needing an answer in words, a 1:1 invite, or a real-world action with no outbox request. Never an open grant proposal or checkpoint (gr_…), an open outbox request or a report already in the Town Hall in-tray (dc_…): ${captain} sees those there, and the town appends an "Already waiting in your in-tray" line listing them.`;
}
export const ROLLUP_NEEDS_RULE = rollupNeedsRule("Mitchell");

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

/**
 * Folding "go fund gr_xxx" rollups into the item's own row (1:1 mt_7b4zc7yja3): a rollup's ask about a decision that
 * already has its own Town Hall in-tray row (a grant proposal, a checkpoint, a grant closed as done, a retainer ask) is
 * shown on that row, and a rollup that asks nothing else is acknowledged on submit instead of becoming its own card.
 */
const WAITING_LINE = /^_(?:Already waiting in your in-tray|Nothing else waiting in your in-tray)[^\n]*_\s*$/gm;

/** The body without the town's generated "Already waiting in your in-tray" line (it names every open proposal). */
export function withoutWaitingLine(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(WAITING_LINE, "");
}

// a Key results table row ("| gr_x, 10 / 20 | kr_y | at-risk | note |") reads as "gr_x, 10 / 20 · kr_y · at-risk · note"
const tableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l) ? l.trim().replace(/^\|\s*|\s*\|$/g, "").split(/\s*\|\s*/).filter(Boolean).join(" · ") : l;
const plainLine = (l: string) => tableRow(l).replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/** The rollup's own words about `id`: its Needs line naming it, else its first other line naming it outside "## Decided" (as plain text), else its title when that names it; null if neither does. */
export function askLineFor(title: string, body: string, id: string): string | null {
  const re = new RegExp(`\\b${id}\\b`);
  // the Needs section's line first; a "## Decided" line ("dc_x → approve (checkpoint for gr_y)") reports a decision, it asks nothing
  const lines: { text: string; section: string | undefined }[] = [];
  let section: string | undefined;
  for (const l of withoutWaitingLine(body).split("\n")) {
    const h = HEADING.exec(l);
    if (h) { section = sectionOf(h[1]!); continue; }
    if (section !== "Decided" && re.test(l) && plainLine(l)) lines.push({ text: l, section });
  }
  const hit = lines.find((l) => l.section === "Needs from") ?? lines[0];
  if (hit) return plainLine(hit.text);
  return re.test(title) ? plainLine(title) : null;
}

/** "Nothing", "None", "Nothing needed." and the like: a Needs line that asks nothing. */
const NOTHING = /^(?:_?\s*)?(?:nothing|none|no(?:thing)? (?:new|needed|asks?)|n\/a)\b/i;

/**
 * True when a rollup asks a human nothing beyond the items in `waitingIds` (which have their own in-tray rows): it has
 * no Shipped items, and every line of its Needs section (the generated waiting line aside) says nothing or names one of
 * those items. Such a rollup is folded into those rows.
 */
export function rollupAsksOnly(body: string, waitingIds: Iterable<string>): boolean {
  const p = parseRollup(body);
  if (p.items.length || p.missingSections.length) return false;
  const ids = [...waitingIds];
  const lines = rollupNeeds(withoutWaitingLine(body)).split("\n").map(plainLine).filter(Boolean);
  return lines.every((l) => NOTHING.test(l) || ids.some((id) => new RegExp(`\\b${id}\\b`).test(l)));
}

/** The verb a rollup's ask reads with on its row, by the item's state: "<building> asks you to fund this". */
export function askVerb(status: string): string {
  return status === "checkpoint" ? "continue" : status === "closed" ? "mark" : status === "asked" ? "approve" : "fund";
}
