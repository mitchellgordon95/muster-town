/**
 * Pins, the pure core (design dc_8194l8soj4 §5; AGENTS.md standing rule 8): a pin places one doc into the sessions
 * of a scope (one agent, a building, the town), `always` (its full text) or `listed` (one line; the agent `read`s it).
 * Data in, data out: no World, DB or clock. The shell (skills.ts `forAgent`) gathers the pin rows and their docs, calls
 * `resolvePins`, and a session prompt renders the result with `pinnedPagesBlock` as one "## Pinned pages" block.
 */
import type { Doc, Pin, PinScope, SkillFileInfo } from "@muster-town/schema";
import { dictionaryGist } from "./dictionary.ts";
import { parseSkillMd } from "./skills.ts";
import { docGist } from "./text.ts";

/** One cap for the always-on text of every pinned page together (today's two 8,000-char caps, manual + skills). */
const PINS_ALWAYS_CAP = 16_000;

/**
 * Most listed lines per scope (the old topic index's cap, TOPIC_INDEX_MAX; design dc_8194l8soj4 §10): past it the oldest
 * pins of that scope give way to the newest, and one line says how many more `search` finds.
 */
const PINS_LISTED_PER_SCOPE = 50;

/** Scope order in the block: the town first, so the most stable text sits at the top of the prompt (docs/prompt-caching.md). */
const SCOPE_RANK: Record<PinScope, number> = { town: 0, building: 1, agent: 2 };

/** The pin fields the core reads. */
export type PinRow = Pick<Pin, "id" | "docId" | "scope" | "targetId" | "mode" | "pinnedBy" | "byHuman" | "createdAt">;

/** A pinned doc with its bundled files (skills; [] for any other doc). */
export interface PinnedDoc { doc: Doc; files: SkillFileInfo[] }

/**
 * Whose sessions: the agent (a fork passes its manager), its home building, which docs it may see, and which it may
 * rewrite (an always entry it may write says so: "you keep this page"; design dc_8194l8soj4 §5).
 */
export interface PinViewer { agentId: string; buildingId: string | null; canSee: (doc: Doc) => boolean; canWrite?: (doc: Doc) => boolean }

/** How a doc shows in the block: its title, a one-line gist (listed) and its text (always). */
interface PinPage { title: string; gist: string; text: string; heading: string }

/** One doc as it reaches a session: the strongest pin that reaches the viewer, and how the doc shows. */
export interface PinEntry extends PinPage { doc: Doc; files: SkillFileInfo[]; scope: PinScope; mode: Pin["mode"]; createdAt: string; writable: boolean }

const filePaths = (files: SkillFileInfo[]) => `${files.slice(0, 6).map((f) => f.path).join(", ")}${files.length > 6 ? ", …" : ""}`;
const fileNote = (files: SkillFileInfo[]) => (files.length ? ` [${files.length} file${files.length === 1 ? "" : "s"}: ${filePaths(files)}]` : "");

const LEDGER_HEADING = "Policy ledger (rules the humans set; follow them and don't ask what a rule already answers)";

/** How a doc shows, per type; null when it can't show (a skill whose SKILL.md doesn't parse, a ledger with no rule yet). */
function pinView({ doc, files }: PinnedDoc): PinPage | null {
  if (doc.type === "skill") {
    let md;
    try { md = parseSkillMd(doc.body); } catch { return null; }
    return {
      title: md.name, gist: `${md.description}${fileNote(files)}`, heading: `Skill: ${md.name}`,
      text: `${md.instructions}${files.length ? `\n(Bundled files: ${filePaths(files)}; \`read\` with \`file\` opens one.)` : ""}`,
    };
  }
  if (doc.type === "policy") {
    // only its rule lines: the head says how the ledger works, which the rules don't need repeated in every session
    const rules = doc.body.split("\n").filter((l) => l.startsWith("- "));
    if (!rules.length) return null;
    return { title: doc.title, gist: `${rules.length} rule${rules.length === 1 ? "" : "s"} the humans set`, heading: LEDGER_HEADING, text: rules.join("\n") };
  }
  if (doc.type === "dictionary") return { title: doc.title, gist: dictionaryGist(doc.body), heading: doc.title, text: doc.body.trim() };
  // a wiki page (a topic page, a manager's page) is rewritten every few sessions: its listed line is its title alone, so
  // a rewrite doesn't change the cached system prompt (docs/prompt-caching.md); only a new page does
  if (doc.type === "wiki") return { title: doc.title, gist: "", heading: doc.title, text: doc.body.trim() };
  return { title: doc.title, gist: docGist(doc), heading: doc.title, text: doc.body.trim() };
}

/** A pin reaches others' sessions unless it is an agent's pin into its own. */
const reachesOthers = (p: Pick<PinRow, "scope" | "targetId" | "pinnedBy">) => !(p.scope === "agent" && p.targetId === p.pinnedBy);

/** Why a pin doesn't load (null = it loads): files were added to the skill after an agent pinned it into others' sessions. */
export function pinSuspended(p: Pick<PinRow, "scope" | "targetId" | "pinnedBy" | "byHuman">, fileCount: number): string | null {
  if (fileCount > 0 && !p.byHuman && reachesOthers(p)) return "The skill now bundles files; a human must pin it again for it to load in others' sessions.";
  return null;
}

/** Does the pin reach this viewer's sessions? */
const reaches = (p: PinRow, v: PinViewer) =>
  p.scope === "town" || (p.scope === "building" && v.buildingId != null && p.targetId === v.buildingId) || (p.scope === "agent" && p.targetId === v.agentId);

/** Block order: always before listed, then town → building → agent, then oldest first; ids break ties. */
const order = (a: Pick<PinRow, "mode" | "scope" | "createdAt" | "docId" | "id">, b: typeof a) =>
  (a.mode === b.mode ? 0 : a.mode === "always" ? -1 : 1) || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]
  || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The pages pinned into a viewer's sessions, in block order: one entry per doc (its strongest pin: always beats listed),
 * leaving out pins that don't reach the viewer, docs it can't see or that are missing, and suspended pins.
 */
export function resolvePins(pins: readonly PinRow[], docs: ReadonlyMap<string, PinnedDoc>, viewer: PinViewer): PinEntry[] {
  const best = new Map<string, PinRow>();
  for (const p of pins) {
    if (!reaches(p, viewer)) continue;
    const d = docs.get(p.docId);
    if (!d || !viewer.canSee(d.doc) || pinSuspended(p, d.files.length)) continue;
    const cur = best.get(p.docId);
    if (!cur || order(p, cur) < 0) best.set(p.docId, p);
  }
  const out: PinEntry[] = [];
  for (const p of [...best.values()].sort(order)) {
    const d = docs.get(p.docId)!;
    const page = pinView(d);
    if (page) out.push({ ...page, doc: d.doc, files: d.files, scope: p.scope, mode: p.mode, createdAt: p.createdAt, writable: viewer.canWrite?.(d.doc) ?? false });
  }
  return out;
}

/**
 * "## Pinned pages" for a session prompt: `always` entries in full, in order, until their text reaches `cap` (an always
 * entry that doesn't fit is listed instead, and the count is named); then one line per listed entry. "" when none.
 */
export function pinnedPagesBlock(entries: readonly PinEntry[], cap: number = PINS_ALWAYS_CAP, listedPerScope: number = PINS_LISTED_PER_SCOPE): string {
  if (!entries.length) return "";
  const full: string[] = [];
  const listed: string[] = [];
  let used = 0;
  let overflow = 0;
  // listed pins past the per-scope cap: the oldest of the scope drop out (entries are oldest first within a scope)
  const listedIn = (scope: PinScope) => entries.filter((e) => e.mode === "listed" && e.scope === scope).length;
  const skip = new Map<PinScope, number>((["town", "building", "agent"] as const).map((sc) => [sc, Math.max(0, listedIn(sc) - listedPerScope)]));
  const dropped = [...skip.values()].reduce((n, k) => n + k, 0);
  for (const e of entries) {
    if (e.mode === "listed" && skip.get(e.scope)! > 0) { skip.set(e.scope, skip.get(e.scope)! - 1); continue; }
    if (e.mode === "always") {
      const keep = e.writable ? `\nYou keep this page: when what it says changes, rewrite it whole with \`write\` (id ${e.doc.id}).` : "";
      const text = `### ${e.heading} (${e.doc.id}, ${e.scope} pin, always on)${keep}\n${e.text}`;
      if (used + text.length <= cap) { full.push(text); used += text.length; continue; }
      overflow++;
    }
    listed.push(`- ${e.title} (${e.doc.id}, ${e.scope} pin)${e.gist ? `: ${e.gist}` : ""}`);
  }
  if (dropped) listed.push(`- (${dropped} older listed page${dropped === 1 ? "" : "s"} not shown: \`search\` finds ${dropped === 1 ? "it" : "them"})`);
  const out = ["## Pinned pages", "Pages pinned into your sessions: always-on ones in full, listed ones one line each. Before you use a listed one, load it with `read` (its id); `read` with `file` opens a skill's bundled file (on a desk you can save it and run it). `skills` lists every skill you can use."];
  if (full.length) out.push(full.join("\n\n"));
  if (listed.length) {
    out.push(`Listed:${overflow ? ` (${overflow} always-on page${overflow === 1 ? "" : "s"} didn't fit the ${cap}-char cap and ${overflow === 1 ? "is" : "are"} listed instead.)` : ""}`);
    out.push(listed.join("\n"));
  }
  return out.join("\n");
}
