/**
 * The one entry point to the human decision queue (1:1 mt_t65exni4et decisions 7-8). Every card a human sees is filed
 * here, so `vetted` (the lint: structure refused by the callers, style kept as warnings) runs on every card:
 *
 * - `askHumans`: the `ask` verb. A manager's card, or the render of an open need on its target.
 * - `passUpWithAsk`: `review` with `ask`, a card on the entry it passes up.
 * - `renderNeed`: a need rendered as its ask (the manager's `ask`, `propose_grant` with `ask`, the Secretary's `rank` render).
 * - `askOnOwnNeed`: code that is its own author (the Planner's calibration, the Secretary's ledger rule) writes its need
 *   and renders it at once.
 *
 * `createAsk` (the asks table insert) is private to this path: test/ask-entry-point.test.ts fails any other source file
 * that names it or inserts a new ask row (docs/invariants/asks.md 18). Tests seed asks through test/helpers.ts `seedAsk`.
 */
import { askStructure, askWarnings, clipWords, Ask, type Agent, type AskBranch, type AskCardInput, type AskClaim, type AskTargetKind, type AskType, type CalibrationProposal } from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { queueClaimChecks } from "./ask-checks.ts";
import { checkAskCards, LINT_FAILED, liveAskOn, refuseMissingStructure, vetted } from "./asks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { appendEntry, entryOf, jobThread, setEntryLevel, threadSeq, type Entry } from "./jobs.ts";
import { fileNeed, openNeedsOn, type NewNeed, type Need } from "./needs.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

const oneLine = (s: string, max = 160) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** What a source files: the ask's fields, plus the source line it brings (the record's own words) and who filed it. */
export interface NewAsk {
  type: AskType;
  targetKind?: AskTargetKind | null;
  targetId?: string | null;
  buildingId: string | null;
  sourceDocId: string | null;
  title: string;
  body?: string;
  branches: AskBranch[];
  recommendation?: string;
  claims?: AskClaim[];
  /** the source's own line (default: the title) */
  line?: string;
  /** who filed it (an agent or user id, "system" by default) */
  by?: string;
  /** the entry on a job's thread that raised it: a need, a manager's `ask` entry or the entry passed up (a new card must have one; a fold may not) */
  sourceEntryId: string | null;
  /** step 9: the Planner's table change on a rule ask (deciding "Adopt" applies it, planner.ts) */
  proposal?: CalibrationProposal | null;
}

/**
 * File an ask. With a target that already has a live ask, it folds in: the source line is appended to that ask (once:
 * the same record and line again changes nothing) and no second ask is made. Returns the ask and whether it folded.
 */
export function createAsk(world: World, n: NewAsk): { ask: Ask; folded: boolean } {
  const at = nowIso();
  const by = n.by ?? "system";
  const kind = n.targetId ? n.targetKind ?? null : null;
  const line = oneLine(n.line ?? n.title, 400);
  const entryId = n.sourceEntryId;
  const sourceOf = () => (n.sourceDocId || entryId ? [{ docId: n.sourceDocId ?? null, entryId, buildingId: n.buildingId, line, at }] : []);
  const source = sourceOf();
  const have = kind && n.targetId ? liveAskOn(world, kind, n.targetId) : undefined;
  if (have) {
    if (!source.length || have.sources.some((s) => s.docId === (n.sourceDocId ?? null) && (s.entryId ?? null) === entryId && s.line === line)) return { ask: have, folded: true };
    // step 3: a manager's card (one with a recommendation) replaces the words of an ask that has none or lacks structure
    const adopt = (!have.recommendation.trim() || have.tags.includes(LINT_FAILED) || askStructure(have.type, have).length > 0) && !!n.recommendation?.trim();
    const card = adopt ? vetted(world, have.type, { title: have.title, body: n.body ?? "", recommendation: n.recommendation, claims: n.claims ?? [], branches: have.branches, targetKind: have.targetKind }, at, by) : null;
    const next = world.asks.upsert({
      ...have, ...(card ? { body: n.body ?? "", recommendation: n.recommendation!, claims: n.claims ?? [], tags: card.tags } : {}), sources: [...have.sources, ...source], updatedAt: at,
      history: [...have.history, { at, action: "fold", by, note: `${n.sourceDocId ?? entryId}: ${line}` }, ...(card?.lint ?? [])],
    });
    world.events.append({ type: "ask.folded", buildingId: n.buildingId, text: `Folded into "${oneLine(have.title, 80)}": ${oneLine(line, 120)}`, payload: { askId: have.id, sourceDocId: n.sourceDocId, targetKind: kind, targetId: n.targetId } });
    if (card) queueClaimChecks(world, next.id);
    return { ask: next, folded: true };
  }
  const card = vetted(world, n.type, { title: n.title, body: n.body ?? "", recommendation: n.recommendation ?? "", claims: n.claims ?? [], branches: n.branches, targetKind: kind }, at, by);
  // every new card views an entry on a job's thread: a need, a manager's `ask` entry or the entry passed up
  if (!entryId) throw new AppError("conflict", "An ask needs the entry it views (asks.sourceEntryId): file it through `ask`, `review` with `ask` or a need.");
  const raisedOn = entryOf(world, entryId)?.jobId;
  const ask = world.asks.upsert(Ask.parse({
    sourceEntryId: entryId, renderedSeq: raisedOn ? threadSeq(world, raisedOn) : null,
    id: newId("ak"), type: n.type, targetKind: kind, targetId: kind ? n.targetId : null, buildingId: n.buildingId, sourceDocId: n.sourceDocId,
    title: clipWords(n.title, 200), body: n.body ?? "", branches: n.branches, recommendation: n.recommendation ?? "", claims: n.claims ?? [],
    status: "open", sources: sourceOf(), createdAt: at, updatedAt: at, history: [{ at, action: "create", by, note: "" }, ...card.lint], tags: card.tags, proposal: n.proposal ?? null,
  }));
  world.events.append({ type: "ask.created", buildingId: n.buildingId, text: `Ask (${n.type}): ${oneLine(ask.title, 120)}`, payload: { askId: ask.id, type: n.type, targetKind: kind, targetId: ask.targetId, sourceDocId: n.sourceDocId } });
  queueClaimChecks(world, ask.id);
  return { ask, folded: false };
}

/** The card fields an author gives (`ask`, `propose_grant` with `ask`, the Secretary's backstop). */
type Card = Required<Pick<NewAsk, "body" | "recommendation" | "claims">>;

/**
 * Render a need as its ask (1:1 mt_t65exni4et decision 2 point 3): the card's words are the author's (a manager, an
 * explorer at `propose_grant`, or the Secretary as the backstop); its type and branches are the need's, because they map
 * onto the target's own verbs. Refused when the card lacks structure. Folds into a live ask on the target, as any ask does.
 */
export function renderNeed(world: World, n: Need, card: { title: string } & Partial<Card>, by: string, proposal: CalibrationProposal | null = null, refuse = true): { ask: Ask; folded: boolean } {
  if (refuse) refuseMissingStructure("ask", askStructure(n.type, { title: card.title, body: card.body ?? "", recommendation: card.recommendation ?? "", claims: card.claims ?? [], branches: n.branches, targetKind: n.targetKind }));
  return createAsk(world, {
    type: n.type, targetKind: n.targetKind, targetId: n.targetId, buildingId: n.buildingId, sourceDocId: n.entry.docId ?? n.targetId, sourceEntryId: n.entry.id, by,
    title: card.title, body: card.body ?? "", branches: n.branches, recommendation: card.recommendation ?? "", claims: card.claims ?? [], line: n.entry.note, proposal,
  });
}

/**
 * Code that is its own author (the Planner's `calibrate`, the Secretary's ledger rule) writes its need on the job's
 * thread and renders it at once with its own card: the same path as a manager's render. Its caller checks the card's
 * structure (calibrate refuses; the ledger rule's card is the town's own line), so a gap is kept as a lint warning here.
 * Null when the thread is missing.
 */
export function askOnOwnNeed(world: World, need: NewNeed, card: { title: string } & Partial<Card>, by: string, proposal: CalibrationProposal | null = null): Ask | null {
  const e = fileNeed(world, { ...need, authorId: need.authorId ?? by });
  const n = e ? openNeedsOn(world, need.targetKind, need.targetId).find((x) => x.entry.id === e.id) : undefined;
  return n ? renderNeed(world, n, card, by, proposal, false).ask : null;
}

/**
 * Pass an entry up to the human (plan A2: "passing an entry up spawns nothing: it carries a note"). The manager can't
 * settle it, so its level becomes `human` and the manager's card is the ask in the Town Hall queue (structure checked
 * before it is filed). The human's decision comes back on the same thread (`askDecidedOnThread`).
 */
export function passUpWithAsk(world: World, me: Agent, e: Entry, buildingId: string, input: AskCardInput, note: string): { askId: string; folded: boolean } {
  const [a] = checkAskCards(world, [input]);
  refuseMissingStructure("pass-up", askStructure(a!.type, { ...a!, targetKind: a!.targetKind ?? null }));
  const { ask, folded } = createAsk(world, {
    type: a!.type, targetKind: a!.targetKind ?? null, targetId: a!.targetId ?? null, buildingId, sourceDocId: e.docId, by: me.id,
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims, line: note || a!.title,
    // the ask remembers the entry it came from, so its decision lands back on that thread
    sourceEntryId: e.id,
  });
  setEntryLevel(world, e.id, "human");
  return { askId: ask.id, folded };
}

/**
 * `ask` (plan dc_uwx045472m step 7: it replaces a rollup's Needs): a manager asks the humans the one thing only they can
 * settle, when the need appears. One manager entry at level human on a job's thread (the job named, else the grant or
 * retainer the card targets, else the building's own), and its card as an ask in the decision queue (structure checked).
 * The human's decision comes back on the same thread (`askDecidedOnThread`). A real-world act is `request_human`.
 * When the card's target has an open need (a proposal, a gate, a request: 1:1 mt_t65exni4et decision 2), the card renders
 * that need: it takes the need's type and branches, it is filed on the need's entry, and no second entry is written.
 */
export function askHumans(world: World, me: Agent, buildingId: string, input: AskCardInput & { jobId?: string; note?: string }): { askId: string; entryId: string; jobId: string; folded: boolean; warnings: string[] } {
  const [a] = checkAskCards(world, [input]);
  const need = a!.targetId && a!.targetKind ? openNeedsOn(world, a!.targetKind, a!.targetId).at(-1) : undefined;
  if (need) {
    if (need.buildingId !== buildingId) throw badRequest(`${a!.targetId}'s need (${need.entry.id}) is on another building's thread: its own manager renders it.`);
    const { ask, folded } = renderNeed(world, need, { title: a!.title, body: a!.body, recommendation: a!.recommendation, claims: a!.claims ?? [] }, me.id);
    const warnings = askWarnings(need.type, { ...a!, branches: need.branches, targetKind: need.targetKind, dictionary: dictionaryPairs(world) });
    return { askId: ask.id, entryId: need.entry.id, jobId: need.entry.jobId, folded, warnings };
  }
  if (a!.type === "do") throw badRequest("A real-world act a human must carry out is `request_human` (it says why it is worth leaving the queue), not `ask`.");
  refuseMissingStructure("ask", askStructure(a!.type, { ...a!, targetKind: a!.targetKind ?? null }));
  const named = input.jobId ? jobThread(world, input.jobId)?.job : null;
  if (input.jobId && !named) throw badRequest(`${input.jobId} names no job: give a job id (jb_…), a grant, a schedule or an assignment, or leave jobId out.`);
  const onTarget = !named && a!.targetId && (a!.targetKind === "grant" || a!.targetKind === "retainer") ? jobThread(world, a!.targetId)?.job : null;
  const job = named ?? onTarget ?? jobThread(world, buildingId)?.job;
  if (!job) throw new AppError("conflict", "Your building has no thread to file the ask on.");
  if (job.buildingId !== buildingId) throw badRequest(`${job.id} is another building's job: an ask goes on a thread of your own building.`);
  const note = (input.note ?? "").trim();
  const entry = appendEntry(world, {
    jobId: job.id, authorKind: "manager", authorId: me.id, level: "human", note: a!.title,
    body: [note, a!.body.trim(), a!.recommendation.trim() ? `Recommendation: ${a!.recommendation.trim()}` : ""].filter(Boolean).join("\n\n"),
    moved: { kind: "ask", type: a!.type, ...(a!.targetId ? { targetId: a!.targetId } : {}) },
  });
  if (!entry) throw new AppError("conflict", `Could not write the ask on ${job.id}.`);
  const { ask, folded } = createAsk(world, {
    type: a!.type, targetKind: a!.targetKind ?? null, targetId: a!.targetId ?? null, buildingId, sourceDocId: null, by: me.id,
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims, line: note || a!.title,
    sourceEntryId: entry.id,
  });
  // style rules never refuse a card: what it breaks is kept in the ask's history and said back to its author
  const warnings = askWarnings(a!.type, { ...a!, targetKind: a!.targetKind ?? null, dictionary: dictionaryPairs(world) });
  return { askId: ask.id, entryId: entry.id, jobId: job.id, folded, warnings };
}
