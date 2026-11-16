/**
 * Asks (docs/legible-delegation.md §4, build steps 1-2): something only a human can do, stored as a row of `asks`
 * instead of parsed out of a report's prose. Everything that needs a human writes a need (needs.ts: a fact on the job's
 * thread) and no card: a grant proposed or at its gate, an outbox request, a retainer asked, a captain or access
 * request. Its manager renders the card from it, and every card is filed by ask-verb.ts, the one entry point (1:1
 * mt_t65exni4et decisions 2 and 7). One need, one ask (1:1 mt_dwsxo7oms8): a second ask on the same need is refused at
 * the door and its words go on the thread; the Secretary folds a dupe raised on another job (`foldAsk`). Here: retired by the event that decides its target (`retireAsks`, called next to each
 * state change: grant decided, closed or withdrawn, access granted or declined, captain accepted or declined, request
 * claimed, declined or withdrawn, retainer decided or ended, key result marked by a human), and decided only by a human
 * (`decideAsk`). Nothing here decides a target: the ask is the human's to answer. `backfillAsks` (boot) writes the
 * needs of everything already open.
 */
import {
  askStructure, askWarnings, clipWords, grantName, grantPricingOf, kTokens, nameWithin, vetAsk, withoutEllipsis, Ask, AskCardInput, type AccessRequest, type Agent, type AskBranch, type AskClaim, type AskTargetKind,
  type AskType, type CalibrationProposal, type CaptainRequest, type Doc, type Event, type Grant, type Schedule, type StepSize,
} from "@muster-town/schema";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { queueClaimChecks } from "./ask-checks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { managerAgentOf, sendMessage } from "./domain.ts";
import { maySettle } from "./overtake.ts";
import { answerEntry, appendEntry, entryOf, jobThread, threadSeq } from "./jobs.ts";
import { cardShown, DO_BRANCHES, fileGoalProposal, fileNeed, GATE_BRANCHES, openNeedsOn, PROPOSAL_BRANCHES, requestType, settleNeeds, type Need } from "./needs.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import { onRuleAskDecided, requireRuleDecider } from "./planner.ts";
import { askDecidedOnThread } from "./review-entry.ts";
import { holderOf } from "./permissions.ts";
import { scheduleView, retainerLine } from "./retainers.ts";
import { onAskDecided } from "./secretary.ts";
import { stamp, utcDate } from "./time.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const oneLine = (s: string, max = 160) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const LIVE_ASK = "status IN ('open', 'deferred')";

/** The human behind an act, for `retireAsks`: the user id of a human's avatar; false for an agent or the system. */
function humanBehind(world: World, agentId: string | null | undefined): string | false {
  const a = agentId ? world.agents.get(agentId) : undefined;
  return a?.kind === "human" ? a.ownerUserId ?? a.id : false;
}

/** The live (open or deferred) ask on a target, if any. */
export function liveAskOn(world: World, kind: AskTargetKind, id: string): Ask | undefined {
  return world.asks.first(`targetKind = ? AND targetId = ? AND ${LIVE_ASK}`, [kind, id], "ORDER BY createdAt, rowid");
}

/**
 * Keep the live asks' links to their threads (plan dc_uwx045472m step 6; all of them, or those raised on `jobId`). It
 * never writes words on a card (1:1 mt_t65exni4et decision 2 point 2): a card is a manager's or the Secretary's view
 * of its need, and when the thread moves `entriesSinceCard` marks it behind for the Secretary to rewrite. It only names
 * the source entry of an ask filed before migration 115 and gives a card with no `renderedSeq` the thread's length.
 * Returns how many asks it changed.
 */
export function rerenderAsks(world: World, jobId?: string): number {
  const live = jobId
    ? world.asks.where(`${LIVE_ASK} AND sourceEntryId IN (SELECT id FROM entries WHERE jobId = ?) AND renderedSeq IS NULL`, [jobId], "ORDER BY createdAt, rowid")
    : world.asks.where(`${LIVE_ASK} AND (sourceEntryId IS NULL OR renderedSeq IS NULL)`, [], "ORDER BY createdAt, rowid");
  let changed = 0;
  for (const a of live) {
    const sourceEntryId = a.sourceEntryId ?? knownEntryOf(world, a);
    const on = sourceEntryId ? entryOf(world, sourceEntryId)?.jobId : undefined;
    const renderedSeq = on && a.renderedSeq === null ? threadSeq(world, on) : a.renderedSeq;
    if (sourceEntryId === a.sourceEntryId && renderedSeq === a.renderedSeq) continue;
    world.asks.upsert({ ...a, sourceEntryId, renderedSeq });
    changed++;
  }
  return changed;
}

/**
 * How far an ask's thread has moved since its card was written: the entries added since. 0 when it is current. The
 * Secretary's read marks such a card behind; nothing writes it again by itself.
 */
export function entriesSinceCard(world: World, a: Ask): number {
  if (a.renderedSeq === null || !a.sourceEntryId) return 0;
  const on = entryOf(world, a.sourceEntryId)?.jobId;
  return on ? Math.max(0, threadSeq(world, on) - a.renderedSeq) : 0;
}

/**
 * The Secretary writes an ask's card again from its thread (plan dc_uwx045472m step 6: the words come from the entry
 * that raised it or from the Secretary): title, body and recommendation only, never its type, branches or target. The
 * card is vetted like any other (warnings into its history) and its `renderedSeq` moves to the thread's length.
 */
export function rewriteAsk(world: World, by: Agent, id: string, card: { title?: string; body?: string; recommendation?: string }): Ask {
  if (!world.secretary.isSecretary(by)) throw forbidden("building.fund", "Only the Town Hall's Secretary rewrites an ask's card.");
  const a = world.asks.require(id, "ask");
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `Ask ${id} is already ${a.status}.`);
  if (card.title === undefined && card.body === undefined && card.recommendation === undefined) throw badRequest(`rewrite: give ${id} a title, a body or a recommendation.`);
  const at = nowIso();
  const next = { title: clipWords(card.title ?? a.title, 200), body: card.body ?? a.body, recommendation: card.recommendation ?? a.recommendation };
  const v = vetted(world, a.type, { ...next, claims: a.claims, branches: a.branches, targetKind: a.targetKind }, at, by.id);
  const on = a.sourceEntryId ? entryOf(world, a.sourceEntryId)?.jobId : undefined;
  return world.asks.upsert({ ...a, ...next, renderedSeq: on ? threadSeq(world, on) : a.renderedSeq, updatedAt: at, history: [...a.history, { at, action: "rewritten", by: by.id, note: `was: ${a.title}`.slice(0, 500) }, ...v.lint] });
}

/** A manager may change only its own building's live ask (1:1 mt_dwsxo7oms8 decision 2 point 5). */
function ownLiveAsk(world: World, by: Agent, id: string, verb: string): Ask {
  const a = world.asks.require(id, "ask");
  if (!a.buildingId || !world.permissions.can(by, "building.manage", a.buildingId)) throw forbidden("building.manage", `${verb}: ${id} is not an ask of your building; only its own manager ${verb === "rewrite" ? "writes its card again" : "withdraws it"}.`);
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `Ask ${id} is already ${a.status}.`);
  return a;
}

/**
 * A manager writes its own building's card again, whole (1:1 mt_dwsxo7oms8 decision 2 point 5): title, body and
 * recommendation together (claims too, when given), never its type, branches or target. Refused when the card lacks
 * structure; style rules are kept as warnings, as on any card. Its `renderedSeq` moves to the thread's length.
 */
export function rewriteOwnAsk(world: World, by: Agent, id: string, card: { title: string; body: string; recommendation: string; claims?: Ask["claims"] }): Ask {
  const a = ownLiveAsk(world, by, id, "rewrite");
  const words = { title: clipWords(card.title, 200), body: card.body, recommendation: card.recommendation, claims: card.claims ?? a.claims };
  refuseMissingStructure("ask", askStructure(a.type, { ...words, branches: a.branches, targetKind: a.targetKind }));
  const at = nowIso();
  const v = vetted(world, a.type, { ...words, branches: a.branches, targetKind: a.targetKind }, at, by.id);
  const on = a.sourceEntryId ? entryOf(world, a.sourceEntryId)?.jobId : undefined;
  const next = world.asks.upsert({ ...a, ...words, renderedSeq: on ? threadSeq(world, on) : a.renderedSeq, updatedAt: at, history: [...a.history, { at, action: "rewritten", by: by.id, note: `was: ${a.title}`.slice(0, 500) }, ...v.lint] });
  if (card.claims) queueClaimChecks(world, next.id);
  return next;
}

/**
 * A manager withdraws its own building's ask with a note (1:1 mt_dwsxo7oms8 decision 2 point 5): it retires (never
 * deleted), the note on the ask and on its thread. Its own `ask` entry is answered by the note; a need of the town's stays
 * open (the manager renders it again). It wakes nobody: no Secretary run, no human, the entry is a record.
 */
export function withdrawAsk(world: World, by: Agent, id: string, note: string): Ask {
  const a = ownLiveAsk(world, by, id, "withdraw");
  if (!note.trim()) throw badRequest("withdraw: say why in note.");
  const at = nowIso();
  const reason = `Withdrawn by ${by.name}: ${oneLine(note, 400)}`;
  const next = world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "withdraw", by: by.id, note: oneLine(note, 500) }] });
  world.events.append({ type: "ask.retired", agentId: by.id, buildingId: a.buildingId, text: `${by.name} withdrew "${oneLine(a.title, 80)}": ${oneLine(note, 160)}`, payload: { askId: a.id, targetKind: a.targetKind, targetId: a.targetId, reason, withdrawn: true, human: false } });
  const raised = a.sourceEntryId ? entryOf(world, a.sourceEntryId) : null;
  if (raised?.moved.kind === "ask") answerEntry(world, raised.id, { kind: "agent", id: by.id }, "withdrawn", reason);
  else if (raised) appendEntry(world, { jobId: raised.jobId, authorKind: "manager", authorId: by.id, level: "none", note: `Withdrew ask ${a.id}: ${oneLine(note, 300)}`, body: "", moved: { kind: "ask-withdrawn", askId: a.id } });
  reopenDeferred(world, [a.id], reason);
  return next;
}

/** The entry an ask filed before migration 115 came from, when its id can be named: a request's, a proposal's last propose. */
function knownEntryOf(world: World, a: Ask): string | null {
  const id = a.targetKind === "request" && a.targetId ? `en_${a.targetId}`
    : a.targetKind === "grant" && a.targetId ? proposeEntryId(world.grants.get(a.targetId)) : null;
  return id && entryOf(world, id) ? id : null;
}

/** A grant's latest propose, as its entry on the grant's job (jobs.ts writes history entries as `en_<grant>_h<index>`). */
function proposeEntryId(g: Grant | undefined): string | null {
  if (!g) return null;
  const i = g.history.map((h) => h.action).lastIndexOf("propose");
  return i < 0 ? null : `en_${g.id}_h${i}`;
}

/**
 * Every card is vetted as it is stored (1:1 mt_ewxnhs90cq decision 5): its missing structure and the style rules it
 * breaks go into its history as one "lint" entry of warnings. Nothing is refused here and nothing is tagged: an author's
 * card already passed `refuseMissingStructure`, and a card the town wrote from a source's own words is filed as is.
 */
export function vetted(world: World, type: AskType, card: Parameters<typeof vetAsk>[1], at: string, by: string): { tags: string[]; lint: Ask["history"] } {
  const c = { ...card, dictionary: dictionaryPairs(world) };
  const problems = [...askStructure(type, c), ...askWarnings(type, c)];
  return { tags: [], lint: problems.length ? [{ at, action: "lint", by, note: `warnings: ${problems.join("\n")}`.slice(0, 4000) }] : [] };
}

/** The tag the old three-tries path put on a card filed failing the linter; cards that carry it lose it when rewritten. */
export const LINT_FAILED = "lint-failed";

/**
 * An author's card (a rollup's typed asks, a proposal's money ask, the Planner's calibration card) is refused only when
 * it lacks structure: two branches, a recommendation, its type's hard contract fields (`askStructure`). Style rules
 * never refuse (Mitchell, 1:1 mt_ewxnhs90cq 2026-11-10 18:58: "i don't think we need the linter for text"): the card is
 * filed and `vetted` records them as warnings. `what` names the card in the message ("rollup", "proposal").
 */
export function refuseMissingStructure(what: string, problems: string[]): void {
  if (!problems.length) return;
  throw badRequest(`Your ${what}'s ask card lacks ${problems.length} required part${problems.length === 1 ? "" : "s"} (docs/legible-delegation.md §4). Add ${problems.length === 1 ? "it" : "them"} and resubmit:\n- ${problems.join("\n- ")}`);
}

/**
 * Retire every live ask on a target: its deciding event fired. `reason` is that event's text. Returns the asks retired.
 * `human`: a human's decision retired them (their user or avatar id when known): the Secretary runs after it (decision 10),
 * and the retire entry in each ask's history carries `by` = that id (queue health tells a human's decision from a moot retire).
 */
export function retireAsks(world: World, kind: AskTargetKind, id: string, reason: string, human: string | boolean = false): Ask[] {
  const at = nowIso();
  const retired = world.asks.where(`targetKind = ? AND targetId = ? AND ${LIVE_ASK}`, [kind, id], "ORDER BY createdAt, rowid").map((a) => {
    const next = world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "retire", by: typeof human === "string" ? human : "system", note: reason }] });
    world.events.append({ type: "ask.retired", buildingId: a.buildingId, text: `Retired "${oneLine(a.title, 80)}": ${oneLine(reason, 160)}`, payload: { askId: a.id, targetKind: kind, targetId: id, reason, human: !!human } });
    return next;
  });
  // the need behind it is settled too; a human's decision keeps the card they saw on its answer entry (mt_t65exni4et decision 2 point 5)
  const shown = human ? retired.find((a) => a.sourceEntryId && openNeedsOn(world, kind, id).some((n) => n.entry.id === a.sourceEntryId)) ?? retired[0] : undefined;
  settleNeeds(world, kind, id, reason, typeof human === "string" ? human : false, shown ? cardShown(shown) : null);
  // a human's decision also lands on the threads of the asks the Secretary folded into these (1:1 mt_dwsxo7oms8 decision 2)
  if (typeof human === "string") for (const a of retired) askDecidedOnThread(world, a, human, reason, true);
  reopenDeferred(world, [id, ...retired.map((a) => a.id)], reason);
  // 1:1 mt_msnjkpgwdb decision 10: a human's decision on an ask wakes the Secretary (debounced) to settle what it made moot and re-rank
  if (human && retired.length) world.secretary.afterDecision({ targetKind: kind, targetId: id, text: reason, by: typeof human === "string" ? human : null });
  return retired;
}

/**
 * The Secretary closes a live ask a human's decision made moot (1:1 mt_msnjkpgwdb decisions 10, 20a): only a click or
 * policy ask that is not a Do (`maySettle`, overtake.ts); money, credential and meeting asks stay the humans'. `because`
 * cites the human's decision, `note` says why it is moot. The ask retires (asks deferred behind it open again); it
 * decides nothing else and wakes no further Secretary run.
 */
export function overtakeAsk(world: World, by: Agent, id: string, because: string, note: string): Ask {
  if (!world.secretary.isSecretary(by)) throw forbidden("building.fund", "Only the Town Hall's Secretary closes an ask as overtaken.");
  const a = world.asks.require(id, "ask");
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `Ask ${id} is already ${a.status}.`);
  if (!maySettle(a)) throw badRequest(`overtaken: ${id} is ${a.targetKind === "request" ? "a request a human must carry out" : `a ${a.type} ask`}; only a human settles it. Rank or defer it instead.`);
  const at = nowIso();
  const reason = `Overtaken by ${oneLine(because, 200)}: ${oneLine(note, 300)}`;
  const next = world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "retire", by: by.id, note: reason }] });
  world.events.append({ type: "ask.retired", agentId: by.id, buildingId: a.buildingId, text: `${by.name} closed "${oneLine(a.title, 80)}" as overtaken: ${oneLine(note, 160)}`, payload: { askId: a.id, targetKind: a.targetKind, targetId: a.targetId, reason, overtaken: true, because, human: false } });
  reopenDeferred(world, [a.id], reason);
  return next;
}

/**
 * The Secretary folds a duplicate raised as its own need on another job (1:1 mt_dwsxo7oms8 decision 2 point 4): `id`
 * goes to status folded with `foldedInto` the survivor and leaves the queue (never deleted). An entry on its thread says
 * where it went; the human's decision on the survivor is written on both threads (`askDecidedOnThread`, `retireAsks`).
 * Any type: a dupe is identity, not judgment of what a decision made moot. Wakes nobody.
 */
export function foldAsk(world: World, by: Agent, id: string, into: string, note: string): Ask {
  if (!world.secretary.isSecretary(by)) throw forbidden("building.fund", "Only the Town Hall's Secretary folds one ask into another.");
  if (id === into) throw badRequest(`fold: ${id} can't fold into itself.`);
  const a = world.asks.require(id, "ask");
  const survivor = world.asks.require(into, "ask");
  for (const x of [a, survivor]) if (x.status !== "open" && x.status !== "deferred") throw new AppError("conflict", `fold: ${x.id} is already ${x.status}.`);
  const at = nowIso();
  const reason = `Folded into ${survivor.id} ("${oneLine(survivor.title, 80)}"): ${oneLine(note, 300)}`;
  const next = world.asks.upsert({ ...a, status: "folded", foldedInto: survivor.id, rank: null, updatedAt: at, history: [...a.history, { at, action: "fold", by: by.id, note: reason.slice(0, 500) }] });
  world.events.append({ type: "ask.folded", agentId: by.id, buildingId: a.buildingId, text: `${by.name} folded "${oneLine(a.title, 80)}" into "${oneLine(survivor.title, 80)}": ${oneLine(note, 160)}`, payload: { askId: a.id, into: survivor.id, targetKind: a.targetKind, targetId: a.targetId } });
  const raised = a.sourceEntryId ? entryOf(world, a.sourceEntryId) : null;
  if (raised) appendEntry(world, { jobId: raised.jobId, authorKind: "secretary", authorId: by.id, level: "none", note: reason, body: "", moved: { kind: "ask-folded", askId: a.id, into: survivor.id } });
  // asks folded into this one follow it to the survivor
  for (const f of world.asks.where("status = 'folded' AND foldedInto = ?", [a.id], "ORDER BY createdAt, rowid")) world.asks.upsert({ ...f, foldedInto: survivor.id, updatedAt: at });
  reopenDeferred(world, [a.id], reason);
  return next;
}

const ID_CHARS = /[a-z0-9_]/;
/** Whether the words of a deferral (`until`) name `id` as a whole id, not inside a longer one. */
function names(until: string, id: string): boolean {
  for (let i = until.indexOf(id); i >= 0; i = until.indexOf(id, i + 1)) {
    if (!ID_CHARS.test(until[i - 1] ?? "") && !ID_CHARS.test(until[i + id.length] ?? "")) return true;
  }
  return false;
}

/**
 * The wait of a deferred ask ended (§6 defer): what it waits behind (`deferredUntil` names an ask or a target id) was
 * decided or retired, so it is open again, stamped `reopen` with `reason`, and `ask.reopened` is appended. A deferral
 * in words that names no such id waits for a human or the Secretary. Returns the asks reopened.
 */
function reopenDeferred(world: World, ids: (string | null | undefined)[], reason: string): Ask[] {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return [];
  const at = nowIso();
  const out: Ask[] = [];
  for (const a of world.asks.where("status = 'deferred' AND deferredUntil IS NOT NULL", [], "ORDER BY createdAt, rowid")) {
    const hit = want.find((id) => id !== a.id && names(a.deferredUntil!, id));
    if (!hit) continue;
    const next = world.asks.upsert({ ...a, status: "open", deferredUntil: null, updatedAt: at, history: [...a.history, { at, action: "reopen", by: "system", note: oneLine(`${hit}: ${reason}`, 500) }] });
    world.events.append({ type: "ask.reopened", buildingId: a.buildingId, text: `"${oneLine(a.title, 80)}" is open again: ${hit} it waited behind was settled`, payload: { askId: a.id, behind: hit, reason } });
    out.push(next);
  }
  return out;
}

/** Who answers an ask: a human who can fund its building (an admin anywhere). Never an agent. */
function requireDecider(world: World, actor: Agent | null, a: Ask): string {
  if (!actor || holderOf(actor).kind !== "user") throw forbidden("building.fund", "Only a human decides an ask.");
  if (!world.permissions.can(actor, "building.fund", a.buildingId)) throw forbidden("building.fund");
  return holderOf(actor).id;
}

/** A branch label and the human's optional note as the decision's words: "Decline. I edited the token instead." */
function decisionWords(label: string, note?: string | null): string {
  const l = label.trim(), n = (note ?? "").trim();
  return !n ? l : `${l}${/[.!?:]$/.test(l) ? "" : "."} ${n}`;
}

/**
 * A human answers a live ask (`decision`: the branch label or their words; `note`: their optional words beside the
 * label, kept as "<label>. <note>"). Decides nothing else: a target keeps its own verb. The ask's building manager
 * hears the decision, note included, in their inbox.
 */
export function decideAsk(world: World, actor: Agent | null, id: string, decision: string, note?: string | null): Ask {
  const a = world.asks.require(id, "ask");
  const by = requireDecider(world, actor, a);
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `This ask is already ${a.status}.`);
  if (!decision.trim()) throw badRequest("Say what you decided (decision).");
  // a goal proposal's ask is decided on the proposal itself, which edits the tree and then retires this ask (decision 4)
  if (a.targetKind === "goalProposal") throw badRequest(`Ask ${id} is about goal proposal ${a.targetId}: decide it with Accept, Edit and accept or Cut (POST /api/goal-proposals/${a.targetId}/decide), which edits the tree.`);
  const said = decisionWords(decision, note);
  // step 9: adopting the Planner's table change is an admin's (it is PUT /api/town/defaults' change)
  requireRuleDecider(world, actor!, a, said);
  const at = nowIso();
  const next = world.asks.upsert({ ...a, status: "decided", decidedBy: by, decidedAt: at, decision: said.slice(0, 2000), updatedAt: at, history: [...a.history, { at, action: "decide", by, note: said.slice(0, 500) }] });
  world.events.append({ type: "ask.decided", agentId: actor?.id ?? null, buildingId: a.buildingId, text: `Decided "${oneLine(a.title, 80)}": ${oneLine(said, 160)}`, payload: { askId: a.id, decision: said, by } });
  // step 5: a decided policy ask proposes its rule for the ledger; a decided "Add this rule?" ask appends it (secretary.ts)
  onAskDecided(world, next);
  // step 9: a rule ask carrying the Planner's table change, decided "Adopt", applies it (planner.ts)
  onRuleAskDecided(world, actor!, next);
  // an ask passed up from an entry: the human's words are their entry on that thread, and the manager moves on it
  askDecidedOnThread(world, next, by, said);
  // the building that filed it hears the human's words (the event alone reaches no one's inbox)
  const manager = managerAgentOf(world, a.buildingId ? world.buildings.get(a.buildingId) : undefined);
  if (manager) sendMessage(world, { kind: "system", fromId: by, fromKind: "user", toId: manager.id, body: `${world.nameOf(by)} decided your ask "${oneLine(a.title, 120)}" (${a.id}): ${said.slice(0, 2000)}` });
  // asks deferred behind this ask (or behind its target) are open again
  reopenDeferred(world, [a.id, a.targetId], `Decided "${oneLine(a.title, 80)}": ${oneLine(said, 160)}`);
  // 1:1 mt_msnjkpgwdb decision 10: the Secretary runs after every human decision (debounced): settle what it made moot, re-rank
  world.secretary.afterDecision({ askId: a.id, targetKind: a.targetKind, targetId: a.targetId, text: `${world.nameOf(by)} decided "${oneLine(a.title, 100)}": ${oneLine(said, 200)}`, by });
  return next;
}

/** Park an open ask behind the event or id it is moot without (§6 defer). A human or the Secretary; it stays listed, stamped. */
export function deferAsk(world: World, actor: Agent | null, id: string, until: string): Ask {
  const a = world.asks.require(id, "ask");
  const by = actor && world.secretary.isSecretary(actor) ? actor.id : requireDecider(world, actor, a);
  if (a.status !== "open") throw new AppError("conflict", `Only an open ask is deferred; this one is ${a.status}.`);
  if (!until.trim()) throw badRequest("Say what it waits behind (until).");
  const at = nowIso();
  const next = world.asks.upsert({ ...a, status: "deferred", deferredUntil: until.trim(), updatedAt: at, history: [...a.history, { at, action: "defer", by, note: until.trim() }] });
  world.events.append({ type: "ask.deferred", buildingId: a.buildingId, text: `Deferred "${oneLine(a.title, 80)}" until ${oneLine(until, 120)}`, payload: { askId: a.id, until: until.trim(), by } });
  return next;
}

/** Every live ask (open and deferred), oldest first: the Town Hall in-tray's `asks`. */
export function openAsks(world: World): Ask[] {
  return world.asks.where(LIVE_ASK, [], "ORDER BY createdAt, rowid");
}

/** Every ask ever filed on a target, oldest first, whatever its status. */
export function asksFor(world: World, target: { kind: AskTargetKind; id: string }): Ask[] {
  return world.asks.where("targetKind = ? AND targetId = ?", [target.kind, target.id], "ORDER BY createdAt, rowid");
}

// ---- the sources ----

const GRANT_DECIDED: Record<string, true> = { "grant.funded": true, "grant.countered": true, "grant.rejected": true, "grant.closed": true };

/**
 * The grant's hook (`Grants.event`, every grant state change): a proposal writes its need (`needForProposal`), never a
 * card; funded, continued, adjusted, countered (it waits on the manager now), rejected, cut, closed, withdrawn or
 * stopping retires the live ask on it and settles its need with the event's text.
 */
export function onGrantEvent(world: World, g: Grant, e: Pick<Event, "type" | "text" | "payload"> & { agentId?: string | null }): void {
  if (e.type === "grant.proposed") needForProposal(world, g);
  else if (GRANT_DECIDED[e.type] || (e.type === "grant.updated" && (e.payload as { stopping?: unknown }).stopping)) retireAsks(world, "grant", g.id, e.text, humanBehind(world, e.agentId));
}

/**
 * A grant proposal's need (1:1 mt_t65exni4et decision 2): "Grant gr_x wants funding", with the plan's facts in its body.
 * Its manager renders the money ask (fund / counter / reject) from it with `ask`, or the explorer did at `propose_grant`.
 */
function needForProposal(world: World, g: Grant): Need | null {
  const kr = world.grantDesk.keyResultsOf(g.id);
  const countered = lastCounterAt(g);
  const e = fileNeed(world, {
    need: "proposal", targetKind: "grant", targetId: g.id, type: "money", branches: PROPOSAL_BRANCHES,
    id: `en_${g.id}_need${g.history.length}`, jobId: `jb_${g.id}`, authorKind: "code", authorId: g.proposedBy,
    note: `Grant ${g.id} "${grantName(g)}" wants funding: ${fmt(g.askTokens)} tokens, ${g.steps.length} step${g.steps.length === 1 ? "" : "s"}.`,
    body: [
      countered ? `The human countered it at ${stamp(countered)}; this is the revised plan.` : "A new proposal: no human has decided on it before.",
      `Objective: ${g.objective}`,
      `Steps: ${g.steps.map((st, i) => `${i + 1}. ${st.title} (${st.size ?? "unsized: planned before step sizes"})`).join("; ")}`,
      kr.length ? `Key results: ${kr.map((k) => `${k.id}: ${k.text}`).join("; ")}` : "",
      "Nothing is spent yet.",
    ].filter(Boolean).join("\n"),
  });
  return e ? openNeedsOn(world, "grant", g.id).find((n) => n.entry.id === e.id) ?? null : null;
}

/** When a human last countered this grant (it is being re-proposed), or null. */
const lastCounterAt = (g: Pick<Grant, "history">): string | null => [...g.history].reverse().find((h) => h.action === "counter")?.at ?? null;


/** A grant's name as a sentence quotes it: in double quotes, so it reads as a name and not as words of the sentence around it. */
const quotedGrantName = (g: Pick<Grant, "title" | "objective">) => `"${grantName(g)}"`;

/** The recommendation of the town's old proposal card: how the boot repair tells a template card from an author's. */
const PROPOSAL_RECOMMENDATION = "Fund it: the building proposed it as its next piece of work.";

/**
 * A retainer asked (`askRetainer`): its need on the retainer's thread (its building's when it has none yet), approve /
 * counter / reject. Its building's manager renders the card (1:1 mt_t65exni4et decision 7).
 */
export function askForRetainer(world: World, s: Schedule, why: string): void {
  const v = scheduleView(world, s);
  fileNeed(world, {
    need: "retainer", targetKind: "retainer", targetId: s.id, type: "money", branches: RETAINER_BRANCHES,
    jobId: jobThread(world, s.id)?.job.id ?? `jb_${s.buildingId}`, docId: s.id,
    note: `Retainer ${s.id} "${nameWithin(s.title)}" wants approval at ${kTokens(v.askTokens)}`, body: `${withoutEllipsis(retainerLine(world, v))} (${why})`,
  });
}

const RETAINER_BRANCHES: AskBranch[] = [{ label: "Approve", action: "approve" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }];

/**
 * An outbox request's need (`request_human`): its entry on the thread of the job that asked, at level human. The
 * author's manager renders the credential or do ask from it (1:1 mt_t65exni4et decision 2 point 3).
 */
export function needForRequest(world: World, d: Doc, at: { jobId: string; authorKind: "manager" | "fork"; authorId: string; assignmentId: string | null }): void {
  fileNeed(world, {
    need: "request", targetKind: "request", targetId: d.id, type: requestType(d), branches: DO_BRANCHES,
    id: `en_${d.id}`, jobId: at.jobId, authorKind: at.authorKind, authorId: at.authorId, docId: d.id, assignmentId: at.assignmentId, createdAt: d.createdAt,
    note: `Request ${d.id} asks a human: ${d.title}`, body: d.body,
  });
}

/**
 * Boot repair for the end of the outbox (decisions 16-17), idempotent: a claimed request is open again (its claimer
 * and note stay on it; Done still takes their report), and every live ask on a request offers Done / Decline, typed
 * `do` unless it asks for a credential. Returns how many requests and asks it changed.
 */
export function requestsToDoAsks(world: World): { reopened: number; asks: number } {
  let reopened = 0, asks = 0;
  for (const d of world.docs.where("type = 'request' AND requestStatus = 'claimed'", [])) {
    world.docs.patch(d.id, { requestStatus: "open" });
    reopened++;
  }
  const at = nowIso();
  for (const a of world.asks.where(`targetKind = 'request' AND ${LIVE_ASK}`, [])) {
    const type = a.type === "click" ? "do" : a.type;
    if (type === a.type && a.branches.length === 2 && a.branches[0]!.action === "done") continue;
    world.asks.upsert({ ...a, type, branches: DO_BRANCHES, updatedAt: at, history: [...a.history, { at, action: "retyped", by: "system", note: "A request is a do ask: Done with the report back, or Decline (no Claim)." }] });
    asks++;
  }
  return { reopened, asks };
}

/**
 * A person's request on the Town Hall's thread (a captain or an access request): its need, which the Town Hall's
 * manager (the Secretary) renders at its next run (`overdueNeeds` has no wait for the Town Hall; decision 7).
 */
function needAtTownHall(world: World, n: { need: "captain" | "access"; targetKind: "captain" | "access"; targetId: string; userId: string; note: string; body: string; branches: AskBranch[] }): void {
  fileNeed(world, {
    need: n.need, targetKind: n.targetKind, targetId: n.targetId, type: "click", branches: n.branches,
    jobId: `jb_${TOWN_HALL_ID}`, authorKind: "human", authorId: n.userId, docId: n.targetId, note: n.note, body: n.body,
  });
}

const whoAsks = (world: World, userId: string) => { const who = world.users.get(userId); return who?.githubLogin ? `@${who.githubLogin}` : who?.name ?? userId; };

/** A member asks to captain a goal: its need, accept / decline. */
export function askForCaptain(world: World, r: CaptainRequest): void {
  const name = whoAsks(world, r.userId);
  const goal = world.goalTree.get(r.goalId)?.text ?? r.goalId;
  needAtTownHall(world, {
    need: "captain", targetKind: "captain", targetId: r.id, userId: r.userId, note: `${name} asks to captain "${oneLine(goal, 100)}" (${r.goalId})`,
    body: withoutEllipsis(r.note), branches: [{ label: "Accept", action: "accept" }, { label: "Decline", action: "decline" }],
  });
}

/** A signed-in visitor asks to join: its need, let in / decline. */
export function askForAccess(world: World, r: AccessRequest): void {
  const name = whoAsks(world, r.userId);
  needAtTownHall(world, {
    need: "access", targetKind: "access", targetId: r.id, userId: r.userId, note: `${name} asked to join`,
    body: withoutEllipsis(r.message), branches: [{ label: "Let in", action: "grant" }, { label: "Decline", action: "decline" }],
  });
}

// ---- an author's cards ----

const TARGET_PREFIX: Record<string, AskTargetKind> = { gr: "grant", sc: "retainer", dc: "request", cr: "captain", ar: "access", kr: "keyResult", mt: "meeting", gp: "goalProposal" };

/** The target kind of an id by its prefix (dc_ is a request only when the doc is one; any other doc reads as a rule's source). */
function kindOf(world: World, id: string): AskTargetKind | null {
  const k = TARGET_PREFIX[id.split("_")[0] ?? ""] ?? null;
  if (k === "request" && world.docs.get(id)?.type !== "request") return "rule";
  return k;
}

/** Whether the target a rollup ask names exists (rules and meetings are free text). */
function targetExists(world: World, kind: AskTargetKind, id: string): boolean {
  switch (kind) {
    case "grant": return !!world.grants.get(id);
    case "retainer": return !!world.schedules.get(id);
    case "request": return world.docs.get(id)?.type === "request";
    case "captain": return !!world.captainRequests.get(id);
    case "access": return !!world.accessRequests.get(id);
    case "keyResult": return !!world.keyResults.get(id);
    case "goalProposal": return world.goalProposals.get(id)?.status === "open";
    default: return true;
  }
}

/** An author's card, resolved: its target kind filled in. */
type ResolvedAskCard = AskCardInput & { targetKind?: AskTargetKind };

/**
 * Check an author's cards (`ask`, `review` with `ask`; refused with the reason, nothing filed): each target exists and
 * a money ask names a grant or retainer. Returns them with the target kind filled in.
 */
export function checkAskCards(world: World, input: AskCardInput[]): ResolvedAskCard[] {
  return input.map((raw, i): ResolvedAskCard => {
    const a = AskCardInput.parse(raw);
    const where = input.length > 1 ? `asks[${i}] ("${oneLine(a.title, 60)}")` : `"${oneLine(a.title, 60)}"`;
    if (!a.targetId) {
      if (a.type === "money") throw badRequest(`${where} is a money ask: name the grant or retainer it is about (targetId gr_… or sc_…).`);
      return a;
    }
    const kind = a.targetKind ?? kindOf(world, a.targetId);
    if (!kind) throw badRequest(`${where}: give targetKind for ${a.targetId} (grant, request, captain, access, retainer, keyResult, rule, meeting or goalProposal).`);
    if (a.type === "money" && kind !== "grant" && kind !== "retainer") throw badRequest(`${where} is a money ask: its target is a grant or a retainer, not a ${kind}.`);
    if (!targetExists(world, kind, a.targetId)) throw badRequest(`${where}: ${a.targetId} is not a ${kind} of this town.`);
    // 1:1 mt_msnjkpgwdb decision 9: a key result met on code and tests is shown as "met, unverified"; nobody is asked about it
    if (kind === "keyResult" && world.keyResults.get(a.targetId)?.status === "met-unverified") throw badRequest(`${where}: ${a.targetId} is "met, unverified" (its grant closed without a live check). The town shows it as such and asks no human about it: check it live and say so in your next report, or leave it; a human flips it to met or missed from the grant page.`);
    return { ...a, targetKind: kind };
  });
}

// ---- backfill ----

/** Whether a target already has an ask a backfill must not repeat: a live one, or one a human answered. */
const hasAsk = (world: World, kind: AskTargetKind, id: string) => world.asks.exists(`targetKind = ? AND targetId = ? AND status IN ('open', 'deferred', 'decided')`, [kind, id]);

/**
 * Boot repair (step 1): the asks and needs of everything already waiting for a human. An open proposal, a held grant
 * and an open request get their need when they have none open (1:1 mt_t65exni4et decision 2: their manager renders the
 * card); an asked retainer, a pending captain or access request gets its ask. Idempotent: a second run creates
 * nothing. Returns how many asks and needs it made.
 */
export function backfillAsks(world: World): number {
  const before = world.asks.count();
  let needs = 0;
  world.transaction(() => {
    for (const g of world.grants.where("status IN ('proposed', 'checkpoint')", [], "ORDER BY updatedAt, rowid")) {
      if (openNeedsOn(world, "grant", g.id).length || liveAskOn(world, "grant", g.id)) continue;
      if (g.status === "proposed") needForProposal(world, g);
      else needAtCheckpoint(world, g, world.grantDesk.spent(g.id));
      needs++;
    }
    for (const d of world.docs.where("type = 'request' AND requestStatus = 'open' AND buildingId IS NOT NULL", [], "ORDER BY createdAt, rowid")) {
      if (openNeedsOn(world, "request", d.id).length || liveAskOn(world, "request", d.id) || entryOf(world, `en_${d.id}`)) continue;
      const by = world.agents.get(d.authorId);
      needForRequest(world, d, { jobId: `jb_${d.buildingId}`, authorKind: world.buildings.get(d.buildingId!)?.managerAgentId === by?.id ? "manager" : "fork", authorId: d.authorId, assignmentId: null });
      needs++;
    }
    for (const s of world.schedules.where("status = 'active' AND retainer = 'asked'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "retainer", s.id) && !openNeedsOn(world, "retainer", s.id).length) { askForRetainer(world, s, "waiting when asks began"); needs++; }
    for (const r of world.captainRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "captain", r.id) && !openNeedsOn(world, "captain", r.id).length) { askForCaptain(world, r); needs++; }
    for (const r of world.accessRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "access", r.id) && !openNeedsOn(world, "access", r.id).length) { askForAccess(world, r); needs++; }
    // 1:1 mt_dwsxo7oms8 decision 4: a goal proposal filed before it joined the thread gets its entry and need, so none is stranded
    for (const p of world.goalProposals.where("status = 'open'", [], "ORDER BY createdAt, rowid")) {
      if (openNeedsOn(world, "goalProposal", p.id).length || entryOf(world, `en_${p.id}_need`)) continue;
      fileGoalProposal(world, p, world.goalTree.proposalWords(p));
      needs++;
    }
  });
  return world.asks.count() - before + needs;
}

/** Whether a live card is one the town wrote from a template (proposal, gate, request) that nobody rewrote since. */
function isTemplateCard(a: Ask): boolean {
  if (a.history.some((h) => h.action === "rewritten")) return false;
  // a request card the town copied whole from the request (its first source is the request itself). A card a manager
  // rendered from the request's need (`renderNeed`) also cites the request, but views the need entry `en_<request id>`
  // (`needForRequest`): that card is the manager's own and survives every boot.
  if (a.targetKind === "request") return a.sourceDocId === a.targetId && a.sourceEntryId !== `en_${a.targetId}`;
  if (a.targetKind !== "grant") return false;
  return a.recommendation === PROPOSAL_RECOMMENDATION || (isGateAsk(a) && !a.history.some((h) => h.action === "create" && h.by !== "system"));
}

/**
 * Boot repair (1:1 mt_t65exni4et decision 2, migration): a live card the town wrote from a template (a proposal's, a
 * gate's, a request copied whole) leaves the queue, and the need behind it waits for its manager to render it. A card
 * the Secretary rewrote, or an author's own, keeps its words. Idempotent. Returns how many cards it took back.
 */
export function templateCardsToNeeds(world: World): number {
  let n = 0;
  world.transaction(() => {
    for (const a of world.asks.where(`${LIVE_ASK} AND targetKind IN ('grant', 'request')`, [], "ORDER BY createdAt, rowid")) {
      if (!isTemplateCard(a) || !a.targetId) continue;
      const g = a.targetKind === "grant" ? world.grants.get(a.targetId) : undefined;
      // the need it goes back to (written now when the target has none open)
      if (!openNeedsOn(world, a.targetKind!, a.targetId).length) {
        if (g?.status === "proposed") needForProposal(world, g);
        else if (g?.status === "checkpoint" || (g && isGateAsk(a))) needAtCheckpoint(world, g, world.grantDesk.spent(g.id), g.status !== "checkpoint");
      }
      if (!openNeedsOn(world, a.targetKind!, a.targetId).length) continue;
      const at = nowIso();
      const reason = "The town wrote this card from a template. Its need now waits for its manager to render it (1:1 mt_t65exni4et).";
      world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "retire", by: "system", note: reason }] });
      world.events.append({ type: "ask.retired", buildingId: a.buildingId, text: `Took back the template card "${oneLine(a.title, 80)}": its manager renders it from its need`, payload: { askId: a.id, targetKind: a.targetKind, targetId: a.targetId, reason, human: false } });
      n++;
    }
  });
  return n;
}

// ---- the retitle repair (migration 105: cards lose their clipping) ----

/** A card with an ellipsis: its words kept, the clipping dropped. The title is its first clause; the body and recommendation lose every ellipsis. */
function ownCardOf(a: Ask): { title: string; body: string; recommendation: string; claims: Ask["claims"] } | null {
  if (!a.title.includes("\u2026") && !a.body.includes("\u2026") && !a.recommendation.includes("\u2026")) return null;
  return { title: nameWithin(a.title, 120), body: withoutEllipsis(a.body), recommendation: withoutEllipsis(a.recommendation), claims: a.claims };
}

/**
 * Boot repair (migration 105): every live ask whose title or body carries "…" loses the clipping (`ownCardOf`), keeping
 * its id, rank, status and history, with a "retitled" history entry, and is vetted again. Idempotent. Returns
 * how many asks it rewrote.
 */
export function retitleClippedAsks(world: World): number {
  const done: string[] = [];
  world.transaction(() => {
    for (const a of world.asks.where(`${LIVE_ASK} AND (title LIKE '%…%' OR body LIKE '%…%')`, [], "ORDER BY createdAt, rowid")) {
      const card = ownCardOf(a);
      if (!card) continue;
      const next = { ...a, ...card, title: clipWords(card.title, 200) };
      if (next.title === a.title && next.body === a.body && next.recommendation === a.recommendation && JSON.stringify(next.claims) === JSON.stringify(a.claims)) continue;
      const at = nowIso();
      const v = vetted(world, a.type, { title: next.title, body: next.body, recommendation: next.recommendation, claims: next.claims, branches: a.branches, targetKind: a.targetKind }, at, "system");
      world.asks.upsert({ ...next, tags: [...a.tags.filter((t) => t !== LINT_FAILED), ...v.tags], updatedAt: at, history: [...a.history, { at, action: "retitled", by: "system", note: `was: ${a.title}`.slice(0, 500) }, ...v.lint] });
      done.push(a.id);
    }
  });
  for (const id of done) queueClaimChecks(world, id);
  return done.length;
}

// ---- legible delegation step 7: the gate's need (an over-ceiling forecast, a hold at the ceiling) ----

/** A live ask rendered at a gate: its branches are exactly Adjust and Cut. A manager's own money ask on the grant is not one. */
const isGateAsk = (a: Ask) => a.branches.length === 2 && a.branches[0]?.action === "adjust" && a.branches[1]?.action === "cut";
const word = (n: number) => (["no", "one", "two", "three", "four", "five"][n] ?? String(n));
const Word = (n: number) => word(n).replace(/^./, (c) => c.toUpperCase());
// an unsized step (planned before sizes) is counted as unsized, never priced as M (decision-5 audit rank 7)
const sizesLine = (sizes: (StepSize | undefined)[]) => ([["S", "S"], ["M", "M"], ["L", "L"], [undefined, "unsized"]] as const).flatMap(([z, label]) => { const n = sizes.filter((s) => s === z).length; return n ? [`${word(n)} ${label}`] : []; }).join(", ");

/**
 * What a top-up of `n` tokens rounds up to: the smallest step size of the collective's table that covers it, or past the
 * largest, `n` rounded up to a whole number of the smallest size.
 */
function roundUpToStep(n: number, table: Record<StepSize, number>): number {
  const sizes = Object.values(table).filter((s) => s > 0).sort((a, b) => a - b);
  if (n <= 0 || !sizes.length) return Math.max(0, n);
  return sizes.find((s) => s >= n) ?? Math.ceil(n / sizes[0]!) * sizes[0]!;
}

/** The report of the grant's latest done step, else of its latest grant-lane session; null when it has none. */
function latestStepReport(world: World, g: Grant): Doc | null {
  const done = world.grantDesk.stepStates(g).filter((s) => s?.status === "done" && s.reportId);
  const fromStep = done.length ? world.docs.get(done.at(-1)!.reportId!) : undefined;
  if (fromStep) return fromStep;
  const s = world.sessions.first("grantId = ? AND reportId IS NOT NULL", [g.id], "ORDER BY startedAt DESC, rowid DESC");
  return (s?.reportId && world.docs.get(s.reportId)) || null;
}

/**
 * The facts of a grant's gate (docs/legible-delegation.md §7.3 point 4), written on its need for the manager who renders
 * the card: the human's prior decision and when, spent against the ceiling, steps done and left by size, the
 * projection and the shortfall, what each branch does, a suggested branch (adjust by the shortfall rounded up to a step
 * size; cut when the latest step report's verdict is stop or pivot, or nothing is left) and the latest step report.
 * `held`: the grant is at its ceiling now; `spent`: its spend now. Facts the town lacks are left out, never guessed.
 */
function gateFacts(world: World, g: Grant, o: { held: boolean; spent: number; report?: Doc | null }): { note: string; body: string } {
  const ceiling = g.grantTokens ?? 0;
  const f = g.forecast ?? null;
  const report = o.report === undefined ? latestStepReport(world, g) : o.report;
  const table = grantPricingOf(world.town.get()).stepSizes;
  // the prior decision: the fund, then the latest adjust or continue
  const funded = g.history.find((h) => h.action === "fund");
  const since = [...g.history].reverse().find((h) => h.action === "adjust" || h.action === "continue");
  const prior = [
    `You funded this at ${fmt(funded?.tokens ?? g.askTokens)} tokens on ${utcDate(funded?.at ?? g.fundedAt ?? g.createdAt)}.`,
    since ? (since.action === "adjust" ? `You last adjusted it to ${fmt(since.tokens ?? ceiling)} tokens on ${utcDate(since.at)}.` : `You last continued it on ${utcDate(since.at)}.`) : "",
  ];
  // steps done and left, by size
  const states = world.grantDesk.stepStates(g);
  const doneSizes = g.steps.flatMap((s, i) => (states[i]?.status === "done" ? [s.size] : []));
  const leftSizes = g.steps.flatMap((s, i) => (states[i]?.status === "done" ? [] : [s.size]));
  const steps = !g.steps.length ? ["It has no plan steps, so none are left to price."] : [
    `${doneSizes.length ? Word(doneSizes.length) : "None"} of ${g.steps.length} steps ${doneSizes.length === 1 ? "is" : "are"} done${doneSizes.length ? `: ${sizesLine(doneSizes)}` : ""}.`,
    leftSizes.length ? `${Word(leftSizes.length)} step${leftSizes.length === 1 ? " is" : "s are"} left: ${sizesLine(leftSizes)}.` : "No steps are left.",
  ];
  // the projection, and what a top-up needs: spent now + what the forecast expected of the steps left − the ceiling
  const leftExpected = f ? Math.max(0, f.projected - f.spent) : null;
  const need = leftExpected !== null ? Math.max(0, Math.round(o.spent + leftExpected - ceiling)) : g.topUpTokens ?? 0;
  const raise = need ? roundUpToStep(need, table) : 0;
  const projection = f && leftExpected !== null ? [
    `${o.held ? "Its last forecast projects" : "At the sizes left, it is projected to spend"} ${fmt(Math.round(o.spent + leftExpected))} tokens in all.`,
    need ? `That is ${fmt(need)} tokens past the ceiling.` : "That is within the ceiling.",
  ] : [];
  const verdict = report?.verdict ?? null;
  const who = managerAgentOf(world, world.buildings.get(g.buildingId))?.name ?? "The town";
  const recommendation = verdict === "stop" || verdict === "pivot" ? `${who} recommends cut: the latest step report says ${verdict}.`
    : raise ? `${who} recommends adjust by ${fmt(raise)} tokens.`
    : f && !leftSizes.length ? `${who} recommends cut: every step is done.`
    : "";
  const body = [
    ...prior,
    `It has spent ${fmt(o.spent)} of its ${fmt(ceiling)}-token ceiling.${o.held ? " New sessions on it wait for you." : ""}`,
    ...steps, ...projection,
    raise ? `If you adjust by ${fmt(raise)}: the ceiling becomes ${fmt(ceiling + raise)} tokens, and the work runs on.` : "If you adjust: the ceiling rises by what you give, and the work runs on.",
    o.held ? "If you cut: the grant closes at what it spent, and nothing more runs on it." : "If you cut: the running step wraps up, and the grant closes at what it spent.",
  ].filter(Boolean).join("\n");
  const reportLine = report ? `The latest step report is ${report.id}, "${withoutEllipsis(report.title)}". ${verdict ? `Its verdict is ${verdict}.` : "It gave no verdict."}` : "";
  const topUp = g.topUpTokens && g.whatTopUpBuys.trim() ? `The forks say ${fmt(g.topUpTokens)} more tokens finish it: ${oneLine(g.whatTopUpBuys, 300)}` : "";
  const note = o.held ? `Grant ${g.id} ${quotedGrantName(g)} reached its gate: it is held at its ${fmt(ceiling)}-token ceiling.` : `Grant ${g.id} ${quotedGrantName(g)} reached its gate: it is projected ${fmt(need)} tokens past its ceiling.`;
  return { note, body: [body, recommendation ? `Suggested: ${recommendation}` : "", reportLine, topUp].filter(Boolean).join("\n") };
}

/**
 * Write the gate's need on the grant's thread (1:1 mt_t65exni4et decision 2: its manager renders the adjust / cut card).
 * A later forecast or the hold supersedes an open gate need; a live ask on the grant stays and is marked behind.
 */
function fileGateNeed(world: World, g: Grant, facts: { note: string; body: string }, sourceDocId: string | null): void {
  fileNeed(world, { need: "gate", targetKind: "grant", targetId: g.id, type: "money", branches: GATE_BRANCHES, jobId: `jb_${g.id}`, note: facts.note, body: facts.body, docId: sourceDocId });
}

/**
 * A step report's forecast projected the grant past its ceiling (`fileForecast`): the gate's need before the hold,
 * written while the next step keeps running.
 */
export function needAtForecast(world: World, g: Grant, report: Doc | null): void {
  fileGateNeed(world, g, gateFacts(world, g, { held: false, spent: g.forecast?.spent ?? world.grantDesk.spent(g.id), report }), null);
}

/** A later forecast is back within the ceiling: the open gate need of a still-running grant is settled, and its gate ask retires. */
export function retireGateAsk(world: World, g: Grant, reason: string): Ask[] {
  if (g.status !== "funded") return [];
  const live = liveAskOn(world, "grant", g.id);
  if (live && isGateAsk(live)) return retireAsks(world, "grant", g.id, reason);
  settleNeeds(world, "grant", g.id, reason, false, null);
  return [];
}

/** A funded grant held at its ceiling (`Grants.checkpoints`), or `forecast`: the gate's need, its facts from the grant's history and latest forecast. */
export function needAtCheckpoint(world: World, g: Grant, spent: number, forecast = false): void {
  fileGateNeed(world, g, gateFacts(world, g, { held: !forecast, spent }), null);
}

// ---- legible delegation step 5: the Secretary's rank ----

/** Set a live ask's rank (1 = first; null clears it): the Secretary's ranking run (which logs one `ask.ranked` per run). */
export function setRank(world: World, id: string, rank: number | null): Ask {
  const a = world.asks.require(id, "ask");
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `Only a live ask is ranked; ${id} is ${a.status}.`);
  if (rank !== null && (!Number.isInteger(rank) || rank < 1)) throw badRequest("A rank is a whole number from 1.");
  return a.rank === rank ? a : world.asks.upsert({ ...a, rank, updatedAt: nowIso() });
}

/** The live asks in the Secretary's order: ranked ones by rank, then the unranked oldest first. */
export function rankedAsks(world: World): Ask[] {
  // an unranked do ask goes last: it takes the human out of the queue (1:1 mt_msnjkpgwdb decision 16)
  return world.asks.where(LIVE_ASK, [], "ORDER BY rank IS NULL, rank, type = 'do', createdAt, rowid");
}
