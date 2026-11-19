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
import { checkAskCards, LINT_FAILED, liveAskOn, rankOnFiling, refuseMissingStructure, vetted } from "./asks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { answererKind, appendEntry, entryOf, jobThread, setEntryLevel, threadSeq, type Entry } from "./jobs.ts";
import { fileNeed, liveAskForNeed, openNeedsOn, type NewNeed, type Need } from "./needs.ts";
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
  /** who filed it (an agent or user id, "system" by default) */
  by?: string;
  /** the entry on a job's thread that raised it: a need, a manager's `ask` entry or the entry passed up (a new card must have one; a fold may not) */
  sourceEntryId: string | null;
  /** step 9: the Planner's table change on a rule ask (deciding "Adopt" applies it, planner.ts) */
  proposal?: CalibrationProposal | null;
  /** the town's own need it renders: its live ask of the same kind on the same target is the same need's card */
  need?: Need;
}

/**
 * File an ask. One need, one ask (1:1 mt_dwsxo7oms8 decisions 2-3): a second ask on the same need is refused at the door.
 * The key is the entry it views (`sourceEntryId`), and for the town's own needs (a proposal, a gate, a request, a
 * retainer, a captain or access request, a rule) the live ask of the same kind on the same target (`liveAskForNeed`). A
 * refused ask makes no second card and appends nothing to the first: its words go on the thread as an entry, which marks
 * the card behind for whoever owns its words to write again whole. Returns the ask (the first one, when it folded).
 */
export function createAsk(world: World, n: NewAsk): { ask: Ask; folded: boolean } {
  const at = nowIso();
  const by = n.by ?? "system";
  const kind = n.targetId ? n.targetKind ?? null : null;
  const entryId = n.sourceEntryId;
  const have = (entryId ? world.asks.first(`sourceEntryId = ? AND status IN ('open', 'deferred')`, [entryId], "ORDER BY createdAt, rowid") : undefined)
    ?? (n.need ? liveAskForNeed(world, n.need) : undefined);
  if (have) return refuseSecondAsk(world, have, n, at, by);
  const card = vetted(world, n.type, { title: n.title, body: n.body ?? "", recommendation: n.recommendation ?? "", claims: n.claims ?? [], branches: n.branches, targetKind: kind }, at, by);
  // every new card views an entry on a job's thread: a need, a manager's `ask` entry or the entry passed up
  if (!entryId) throw new AppError("conflict", "An ask needs the entry it views (asks.sourceEntryId): file it through `ask`, `review` with `ask` or a need.");
  const raisedOn = entryOf(world, entryId)?.jobId;
  const ask = world.asks.upsert(Ask.parse({
    sourceEntryId: entryId, renderedSeq: raisedOn ? threadSeq(world, raisedOn) : null,
    id: newId("ak"), type: n.type, targetKind: kind, targetId: kind ? n.targetId : null, buildingId: n.buildingId, sourceDocId: n.sourceDocId,
    title: clipWords(n.title, 200), body: n.body ?? "", branches: n.branches, recommendation: n.recommendation ?? "", claims: n.claims ?? [],
    status: "open", createdAt: at, updatedAt: at, history: [{ at, action: "create", by, note: "" }, ...card.lint], tags: card.tags, proposal: n.proposal ?? null,
  }));
  world.events.append({ type: "ask.created", buildingId: n.buildingId, text: `Ask (${n.type}): ${oneLine(ask.title, 120)}`, payload: { askId: ask.id, type: n.type, targetKind: kind, targetId: ask.targetId, sourceDocId: n.sourceDocId } });
  queueClaimChecks(world, ask.id);
  // Mitchell, 1:1 mt_mjxwzdhhd7: a new ask is ranked when it is filed (by its goal's nearness to the root), not at the next daily run
  rankOnFiling(world, ask);
  return { ask: world.asks.require(ask.id, "ask"), folded: false };
}

/**
 * The door's answer to a second ask on a need that already has one. A town placeholder (a card with no recommendation or
 * missing structure) is replaced whole by an author's card with a recommendation (one author, one time). Otherwise the
 * card is left as it is and the second filer's words become one entry on the card's thread (once: the same words again
 * write nothing), pointing at the ask; the thread moved, so the card is marked behind for its owner to write again.
 */
function refuseSecondAsk(world: World, have: Ask, n: NewAsk, at: string, by: string): { ask: Ask; folded: boolean } {
  const adopt = (!have.recommendation.trim() || have.tags.includes(LINT_FAILED) || askStructure(have.type, have).length > 0) && !!n.recommendation?.trim();
  if (adopt) {
    const words = { title: clipWords(n.title, 200), body: n.body ?? "", recommendation: n.recommendation!, claims: n.claims ?? [] };
    const card = vetted(world, have.type, { ...words, branches: have.branches, targetKind: have.targetKind }, at, by);
    const on = have.sourceEntryId ? entryOf(world, have.sourceEntryId)?.jobId : undefined;
    const next = world.asks.upsert({ ...have, ...words, tags: card.tags, renderedSeq: on ? threadSeq(world, on) : have.renderedSeq, updatedAt: at, history: [...have.history, { at, action: "rewritten", by, note: `the town's wording replaced whole by ${n.sourceEntryId ?? by}'s card; was: ${have.title}`.slice(0, 500) }, ...card.lint] });
    queueClaimChecks(world, next.id);
    // the author's card replaced a placeholder: it is the card now, nothing was refused
    return { ask: next, folded: false };
  }
  const jobId = (have.sourceEntryId ? entryOf(world, have.sourceEntryId)?.jobId : undefined) ?? (n.sourceEntryId ? entryOf(world, n.sourceEntryId)?.jobId : undefined);
  const note = oneLine(`A second ask on this need was refused; it points at ${have.id}: ${n.title}`, 400);
  const said = [n.body?.trim() ?? "", n.recommendation?.trim() ? `Recommendation: ${n.recommendation.trim()}` : ""].filter(Boolean).join("\n\n");
  const same = (n.title.trim() === have.title.trim() && (n.body ?? "").trim() === have.body.trim())
    || (jobId && world.db.prepare("SELECT 1 FROM entries WHERE jobId = ? AND note = ? AND body = ?").get(jobId, note, said));
  if (same) return { ask: have, folded: true };
  if (jobId) {
    appendEntry(world, { jobId, authorKind: answererKind(world, { kind: by === "system" ? "system" : "agent", id: by }), authorId: by, level: "none", note, body: said, moved: { kind: "ask-refused", askId: have.id, ...(n.sourceEntryId ? { entryId: n.sourceEntryId } : {}) } });
  }
  world.events.append({ type: "ask.folded", buildingId: n.buildingId, text: `A second ask on "${oneLine(have.title, 80)}" was refused at the door: ${oneLine(n.title, 120)}`, payload: { askId: have.id, sourceDocId: n.sourceDocId, sourceEntryId: n.sourceEntryId, targetKind: n.targetKind ?? null, targetId: n.targetId ?? null } });
  return { ask: have, folded: true };
}

/**
 * The error a caller throws when its card was refused at the door (decision-5 audit rank 1, grant gr_eztubyh7nf): the
 * call fails and names the live ask, never answers as if a card were filed. `recorded`: the words were kept as an entry
 * on the thread (the `ask` verb throws after its transaction commits); otherwise nothing was written.
 */
export function secondCardRefused(askId: string, recorded: boolean): AppError {
  return new AppError("conflict", `Refused: this need already has a live card, ask ${askId}. No second card was filed and ${askId} was not changed.${recorded ? " Your words are kept as one entry on its thread." : " Nothing was written."} To change that card, \`ask\` again with askId ${askId} and the whole card (title, body, recommendation); to take it back, askId with withdraw: true.`);
}

/** The card fields an author gives (`ask`, `propose_grant` with `ask`, the Secretary's backstop). */
type Card = Required<Pick<NewAsk, "body" | "recommendation" | "claims">>;

/**
 * Render a need as its ask (1:1 mt_t65exni4et decision 2 point 3): the card's words are the author's (a manager, an
 * explorer at `propose_grant`, or the Secretary as the backstop); its type and branches are the need's, because they map
 * onto the target's own verbs. Refused when the card lacks structure. A second render of the same need is refused at the door (`createAsk`).
 */
export function renderNeed(world: World, n: Need, card: { title: string } & Partial<Card>, by: string, proposal: CalibrationProposal | null = null): { ask: Ask; folded: boolean } {
  refuseMissingStructure("ask", askStructure(n.type, { title: card.title, body: card.body ?? "", recommendation: card.recommendation ?? "", claims: card.claims ?? [], branches: n.branches, targetKind: n.targetKind }));
  return createAsk(world, {
    type: n.type, targetKind: n.targetKind, targetId: n.targetId, buildingId: n.buildingId, sourceDocId: n.entry.docId ?? n.targetId, sourceEntryId: n.entry.id, by,
    title: card.title, body: card.body ?? "", branches: n.branches, recommendation: card.recommendation ?? "", claims: card.claims ?? [], proposal, need: n,
  });
}

/**
 * Code that is its own author (the Planner's `calibrate`, the Secretary's ledger rule) writes its need on the job's
 * thread and renders it at once with its own card: the same path as a manager's render, and the same door. A card that
 * lacks structure is refused, and so is a second card on a need that already has one (decision-5 audit rank 2: no ask
 * is written by code).
 */
export function askOnOwnNeed(world: World, need: NewNeed, card: { title: string } & Partial<Card>, by: string, proposal: CalibrationProposal | null = null): Ask {
  const e = fileNeed(world, { ...need, authorId: need.authorId ?? by });
  if (!e) throw new AppError("conflict", `The need ${need.id ?? "for " + need.targetId} is already on the thread of ${need.jobId}: it was filed once, so no second card is written.`);
  const n = openNeedsOn(world, need.targetKind, need.targetId).find((x) => x.entry.id === e.id);
  if (!n) throw new AppError("conflict", `The need ${e.id} on ${need.jobId} is not open after it was written.`);
  const r = renderNeed(world, n, card, by, proposal);
  if (r.folded) throw secondCardRefused(r.ask.id, false);
  return r.ask;
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
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims,
    // the ask remembers the entry it came from, so its decision lands back on that thread
    sourceEntryId: e.id,
  });
  // the entry already has a live card: the whole pass-up fails and is rolled back (decision-5 audit rank 1)
  if (folded) throw secondCardRefused(ask.id, false);
  setEntryLevel(world, e.id, "human");
  return { askId: ask.id, folded };
}

/**
 * `ask` (plan dc_uwx045472m step 7: it replaces a rollup's Needs): a manager asks the humans the one thing only they can
 * settle, when the need appears. One manager entry at level human on a job's thread (the job named, else the grant or
 * retainer the card targets, else the building's own), and its card as an ask in the decision queue (structure checked).
 * The human's decision comes back on the same thread (`askDecidedOnThread`). A real-world act is `request_human`.
 * When the card's target has an open need of the card's type (a proposal, a gate, a request: 1:1 mt_t65exni4et decision 2),
 * the card renders that need: it takes the need's type and branches, it is filed on the need's entry, and no second entry is written.
 */
export function askHumans(world: World, me: Agent, buildingId: string, input: AskCardInput & { jobId?: string; note?: string }): { askId: string; entryId: string; jobId: string; folded: boolean; warnings: string[] } {
  const [a] = checkAskCards(world, [input]);
  // a card of the need's own type renders it; another type on the same target is a need of its own (1:1 mt_dwsxo7oms8 decision 3)
  const need = a!.targetId && a!.targetKind ? openNeedsOn(world, a!.targetKind, a!.targetId).filter((n) => n.type === a!.type).at(-1) : undefined;
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
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims,
    sourceEntryId: entry.id,
  });
  // style rules never refuse a card: what it breaks is kept in the ask's history and said back to its author
  const warnings = askWarnings(a!.type, { ...a!, targetKind: a!.targetKind ?? null, dictionary: dictionaryPairs(world) });
  return { askId: ask.id, entryId: entry.id, jobId: job.id, folded, warnings };
}
