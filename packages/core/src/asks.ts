/**
 * Asks (docs/legible-delegation.md §4, build steps 1-2): something only a human can do, stored as a row of `asks`
 * instead of parsed out of a report's prose. Each is created in code where its source is created (a grant proposed or
 * held at its checkpoint, a retainer asked, an outbox request, a captain or access request, a rollup's typed `asks`),
 * deduped by target (`createAsk` folds a second ask on the same targetKind + targetId into the open one as a source
 * line), retired by the event that decides its target (`retireAsks`, called next to each state change: grant decided,
 * closed or withdrawn, access granted or declined, captain accepted or declined, request claimed, declined or withdrawn,
 * retainer decided or ended, key result marked by a human), and decided only by a human (`decideAsk`). Nothing here
 * decides a target: the ask is the human's to answer. `backfillAsks` (boot) creates the asks of everything already open.
 */
import {
  ASK_LINT_RULES, askSentences, askStructure, askWarnings, clipWords, grantName, grantPricingOf, kTokens, nameWithin, parseRollup, proseAskTitle, rollupAsks, rollupNeedsIdsAll, vetAsk, withoutEllipsis, Ask, RollupAskInput, type AccessRequest, type Agent, type AskBranch, type AskClaim, type AskTargetKind,
  type AskType, type CalibrationProposal, type CaptainRequest, type Doc, type Event, type Grant, type Schedule, type StepSize,
} from "@muster-town/schema";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { queueClaimChecks, urlOfHowToCheck } from "./ask-checks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { managerAgentOf, sendMessage } from "./domain.ts";
import { onRuleAskDecided, requireRuleDecider } from "./planner.ts";
import { askDecidedOnThread } from "./review-entry.ts";
import { holderOf } from "./permissions.ts";
import { scheduleView, retainerLine } from "./retainers.ts";
import { onAskDecided, rollupCalls } from "./secretary.ts";
import { stamp, utcDate } from "./time.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
const oneLine = (s: string, max = 160) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const LIVE_ASK = "status IN ('open', 'deferred')";

/** What a source files: the ask's fields, plus the source line it brings (the record's own words) and who filed it. */
interface NewAsk {
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
  /** step 9: the Planner's table change on a rule ask (deciding "Adopt" applies it, planner.ts) */
  proposal?: CalibrationProposal | null;
}

/** The live (open or deferred) ask on a target, if any. */
function liveAskOn(world: World, kind: AskTargetKind, id: string): Ask | undefined {
  return world.asks.first(`targetKind = ? AND targetId = ? AND ${LIVE_ASK}`, [kind, id], "ORDER BY createdAt, rowid");
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
  const source = n.sourceDocId ? [{ docId: n.sourceDocId, buildingId: n.buildingId, line, at }] : [];
  const have = kind && n.targetId ? liveAskOn(world, kind, n.targetId) : undefined;
  if (have) {
    if (!source.length || have.sources.some((s) => s.docId === n.sourceDocId && s.line === line)) return { ask: have, folded: true };
    // step 3: a manager's card (one with a recommendation) replaces the town's own wording on an ask that has none yet
    const adopt = (!have.recommendation.trim() || have.tags.includes(LINT_FAILED) || askStructure(have.type, have).length > 0) && !!n.recommendation?.trim();
    const card = adopt ? vetted(world, have.type, { title: have.title, body: n.body ?? "", recommendation: n.recommendation, claims: n.claims ?? [], branches: have.branches, targetKind: have.targetKind }, at, by) : null;
    const next = world.asks.upsert({
      ...have, ...(card ? { body: n.body ?? "", recommendation: n.recommendation!, claims: n.claims ?? [], tags: card.tags } : {}), sources: [...have.sources, ...source], updatedAt: at,
      history: [...have.history, { at, action: "fold", by, note: `${n.sourceDocId}: ${line}` }, ...(card?.lint ?? [])],
    });
    world.events.append({ type: "ask.folded", buildingId: n.buildingId, text: `Folded into "${oneLine(have.title, 80)}": ${oneLine(line, 120)}`, payload: { askId: have.id, sourceDocId: n.sourceDocId, targetKind: kind, targetId: n.targetId } });
    if (card) queueClaimChecks(world, next.id);
    return { ask: next, folded: true };
  }
  const card = vetted(world, n.type, { title: n.title, body: n.body ?? "", recommendation: n.recommendation ?? "", claims: n.claims ?? [], branches: n.branches, targetKind: kind }, at, by);
  const ask = world.asks.upsert(Ask.parse({
    id: newId("ak"), type: n.type, targetKind: kind, targetId: kind ? n.targetId : null, buildingId: n.buildingId, sourceDocId: n.sourceDocId,
    title: clipWords(n.title, 200), body: n.body ?? "", branches: n.branches, recommendation: n.recommendation ?? "", claims: n.claims ?? [],
    status: "open", sources: source, createdAt: at, updatedAt: at, history: [{ at, action: "create", by, note: "" }, ...card.lint], tags: card.tags, proposal: n.proposal ?? null,
  }));
  world.events.append({ type: "ask.created", buildingId: n.buildingId, text: `Ask (${n.type}): ${oneLine(ask.title, 120)}`, payload: { askId: ask.id, type: n.type, targetKind: kind, targetId: ask.targetId, sourceDocId: n.sourceDocId } });
  queueClaimChecks(world, ask.id);
  return { ask, folded: false };
}

/**
 * Every card is vetted as it is stored (1:1 mt_ewxnhs90cq decision 5): its missing structure and the style rules it
 * breaks go into its history as one "lint" entry of warnings. Nothing is refused here and nothing is tagged: an author's
 * card already passed `refuseMissingStructure`, and a card the town wrote from a source's own words is filed as is.
 */
function vetted(world: World, type: AskType, card: Parameters<typeof vetAsk>[1], at: string, by: string): { tags: string[]; lint: Ask["history"] } {
  const c = { ...card, dictionary: dictionaryPairs(world) };
  const problems = [...askStructure(type, c), ...askWarnings(type, c)];
  return { tags: [], lint: problems.length ? [{ at, action: "lint", by, note: `warnings: ${problems.join("\n")}`.slice(0, 4000) }] : [] };
}

/** The tag the old three-tries path put on a card filed failing the linter; cards that carry it lose it when rewritten. */
const LINT_FAILED = "lint-failed";

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

/** Retire every live ask on a target: its deciding event fired. `reason` is that event's text. Returns the asks retired. */
export function retireAsks(world: World, kind: AskTargetKind, id: string, reason: string): Ask[] {
  const at = nowIso();
  const retired = world.asks.where(`targetKind = ? AND targetId = ? AND ${LIVE_ASK}`, [kind, id], "ORDER BY createdAt, rowid").map((a) => {
    const next = world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "retire", by: "system", note: reason }] });
    world.events.append({ type: "ask.retired", buildingId: a.buildingId, text: `Retired "${oneLine(a.title, 80)}": ${oneLine(reason, 160)}`, payload: { askId: a.id, targetKind: kind, targetId: id, reason } });
    return next;
  });
  reopenDeferred(world, [id, ...retired.map((a) => a.id)], reason);
  return retired;
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

/** Every live ask (open and deferred), oldest first, with its sources: the Town Hall in-tray's `asks`. */
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
 * The grant's hook (`Grants.event`, every grant state change): a proposal files its money ask (fund / counter / reject);
 * funded, continued, adjusted, countered (it waits on the manager now), rejected, cut, closed, withdrawn or stopping
 * retires the live ask on it with the event's text.
 */
export function onGrantEvent(world: World, g: Grant, e: Pick<Event, "type" | "text" | "payload">): void {
  if (e.type === "grant.proposed") askForProposal(world, g, e.text);
  else if (GRANT_DECIDED[e.type] || (e.type === "grant.updated" && (e.payload as { stopping?: unknown }).stopping)) retireAsks(world, "grant", g.id, e.text);
}

/** A grant proposal's money ask: fund / counter / reject, its card written by the town from the plan (`proposalCard`). */
function askForProposal(world: World, g: Grant, line: string): void {
  const kr = world.grantDesk.keyResultsOf(g.id).map((k) => ({ id: k.id, text: k.text }));
  createAsk(world, {
    type: "money", targetKind: "grant", targetId: g.id, buildingId: g.buildingId, sourceDocId: g.id, by: g.proposedBy,
    title: proposalTitle(g), line,
    ...proposalCard({ askTokens: g.askTokens, steps: g.steps.length, keyResults: kr, counteredAt: lastCounterAt(g) }),
    branches: [{ label: "Fund", action: "fund" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }],
  });
}

/** When a human last countered this grant (it is being re-proposed), or null. */
export const lastCounterAt = (g: Pick<Grant, "history">): string | null => [...g.history].reverse().find((h) => h.action === "counter")?.at ?? null;

/** The card fields a proposal's money ask carries. */
type Card = Required<Pick<NewAsk, "body" | "recommendation" | "claims">>;

/**
 * A grant's name as an ask title or sentence quotes it: in double quotes, so it reads as a name and not as words of the
 * sentence around it ("Fund "Town health on the Town Hall" at 150k", never "Fund Town health on the Town Hall at 150k").
 */
const quotedGrantName = (g: Pick<Grant, "title" | "objective">) => `"${grantName(g)}"`;

/** A proposal's money ask's title: the grant by its title, never its objective (docs/legible-delegation.md §5), quoted. */
const proposalTitle = (g: Pick<Grant, "title" | "objective" | "askTokens">) => `Fund ${quotedGrantName(g)} at ${kTokens(g.askTokens)}`;

/** A line a card may carry as it stands: every sentence passes the sentence rules of the linter and none has an ellipsis. */
function lintsClean(line: string): boolean {
  return !line.includes("…") && askSentences(line).every((s) => ASK_LINT_RULES.every((r) => r.scope !== "sentence" || !r.fails(s)));
}

/**
 * The card the town writes for a proposal whose explorer gave none (`propose_grant` without `ask`, or a proposal made
 * over REST): the prior decision, what the first key result lets a person see, the ask, what is spent, the steps, both
 * branches, and the first two key results as its claims (checked by their howToCheck when it is a curl or a URL). The
 * card is written for the reader and never quotes the objective (§5): the key result is already a short checkable
 * sentence, and when it fails the linter the line is dropped, never clipped. The full objective stays on the grant.
 */
export function proposalCard(p: { askTokens: number; steps: number; keyResults: { id?: string; text: string }[]; counteredAt?: string | null }): Card {
  const prior = p.counteredAt ? `You countered it at ${stamp(p.counteredAt)}. This is the revised plan.` : "This is a new proposal. You have not decided on it before.";
  const first = p.keyResults[0]?.text.replace(/\s+/g, " ").trim() ?? "";
  const sees = first ? first.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.") : "";
  return {
    body: [
      prior, lintsClean(sees) ? sees : "",
      `It asks for ${fmt(p.askTokens)} tokens. Nothing is spent yet.`,
      `It has ${p.steps} step${p.steps === 1 ? "" : "s"}, and none is done yet.`,
      "If you fund: step 1 starts on the building queue.",
      "If you reject: nothing runs, and the tokens stay free.",
    ].filter(Boolean).join("\n"),
    recommendation: PROPOSAL_RECOMMENDATION,
    claims: p.keyResults.slice(0, 2).map((k) => ({ text: `Key result: ${clipWords(k.text, 300)}`, check: k.id ? { kind: "kr" as const, ref: k.id } : { kind: "manual" as const } })),
  };
}

/** The recommendation of the town's own proposal card: how the retitle repair tells the town's card from an explorer's. */
const PROPOSAL_RECOMMENDATION = "Fund it: the building proposed it as its next piece of work.";

/**
 * Put an author's card on the live ask of a target (`propose_grant` with `ask`): body, recommendation and claims, vetted
 * again (its warnings into its history), and its checks queued. No live ask: nothing.
 */
export function setAskCard(world: World, kind: AskTargetKind, id: string, card: Card, by: string): Ask | null {
  const have = liveAskOn(world, kind, id);
  if (!have) return null;
  const at = nowIso();
  const v = vetted(world, have.type, { ...card, title: have.title, branches: have.branches, targetKind: have.targetKind }, at, by);
  const next = world.asks.upsert({ ...have, ...card, tags: v.tags, updatedAt: at, history: [...have.history, ...v.lint] });
  queueClaimChecks(world, next.id);
  return next;
}

/** A retainer asked (`askRetainer`): approve / counter / reject. */
export function askForRetainer(world: World, s: Schedule, why: string): void {
  const v = scheduleView(world, s);
  createAsk(world, {
    type: "money", targetKind: "retainer", targetId: s.id, buildingId: s.buildingId, sourceDocId: s.id,
    title: retainerTitle(s.title, v.askTokens), line: `${retainerLine(world, v)} (${why})`,
    body: withoutEllipsis(retainerLine(world, v)),
    branches: [{ label: "Approve", action: "approve" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }],
  });
}

const retainerTitle = (title: string, tokens: number) => `Approve the retainer for "${nameWithin(title)}" at ${kTokens(tokens)}`;

/** A request for a token, key or credential (the click it asks for is issuing one). */
const CREDENTIAL = /\b(token|tokens|credential|credentials|api[- ]?key|keys?|PAT|password|secret|ssh|oauth|scope)\b/i;

/** An outbox request (`request_human`): a credential ask when it asks for a token or key, else a click. Claim / decline. */
export function askForRequest(world: World, d: Doc): void {
  createAsk(world, {
    type: CREDENTIAL.test(`${d.title}\n${d.body}`) ? "credential" : "click", targetKind: "request", targetId: d.id, buildingId: d.buildingId, sourceDocId: d.id,
    by: d.authorId, title: withoutEllipsis(d.title), body: withoutEllipsis(d.body), line: d.title,
    branches: [{ label: "Claim", action: "claim" }, { label: "Decline", action: "decline" }],
  });
}

/** A member asks to captain a goal: accept / decline. */
export function askForCaptain(world: World, r: CaptainRequest): void {
  const who = world.users.get(r.userId);
  const name = who?.githubLogin ? `@${who.githubLogin}` : who?.name ?? r.userId;
  const goal = world.goalTree.get(r.goalId)?.text ?? r.goalId;
  createAsk(world, {
    type: "click", targetKind: "captain", targetId: r.id, buildingId: null, sourceDocId: r.id, by: r.userId,
    title: `Make ${name} captain of "${nameWithin(goal)}"`, body: withoutEllipsis(r.note), line: `${name} asks to captain "${oneLine(goal, 100)}"${r.note ? `: ${r.note}` : ""}`,
    branches: [{ label: "Accept", action: "accept" }, { label: "Decline", action: "decline" }],
  });
}

/** A signed-in visitor asks to join: let in / decline. */
export function askForAccess(world: World, r: AccessRequest): void {
  const who = world.users.get(r.userId);
  const name = who?.githubLogin ? `@${who.githubLogin}` : who?.name ?? r.userId;
  createAsk(world, {
    type: "click", targetKind: "access", targetId: r.id, buildingId: null, sourceDocId: r.id, by: r.userId,
    title: `Let ${name} in`, body: withoutEllipsis(r.message), line: `${name} asked to join${r.message ? `: ${r.message}` : ""}`,
    branches: [{ label: "Let in", action: "grant" }, { label: "Decline", action: "decline" }],
  });
}

// ---- rollups ----

const TARGET_PREFIX: Record<string, AskTargetKind> = { gr: "grant", sc: "retainer", dc: "request", cr: "captain", ar: "access", kr: "keyResult", mt: "meeting" };

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
    default: return true;
  }
}

/** A rollup's typed ask, resolved: its target kind filled in. */
type ResolvedRollupAsk = RollupAskInput & { targetKind?: AskTargetKind };

/**
 * Check a rollup's typed `asks` against its prose (refused with the reason, nothing filed): each target exists, a money
 * ask names a grant or retainer, and every id its Needs section and its real "Your call" lines name is the target of one
 * of them. A rollup that asks something in words (a Needs line or a real "Your call") with an empty list is refused too.
 */
export function checkRollupAsks(world: World, body: string, input: RollupAskInput[]): ResolvedRollupAsk[] {
  const asks = input.map((raw, i): ResolvedRollupAsk => {
    const a = RollupAskInput.parse(raw);
    const where = `asks[${i}] ("${oneLine(a.title, 60)}")`;
    if (!a.targetId) {
      if (a.type === "money") throw badRequest(`${where} is a money ask: name the grant or retainer it is about (targetId gr_… or sc_…).`);
      return a;
    }
    const kind = a.targetKind ?? kindOf(world, a.targetId);
    if (!kind) throw badRequest(`${where}: give targetKind for ${a.targetId} (grant, request, captain, access, retainer, keyResult, rule or meeting).`);
    if (a.type === "money" && kind !== "grant" && kind !== "retainer") throw badRequest(`${where} is a money ask: its target is a grant or a retainer, not a ${kind}.`);
    if (!targetExists(world, kind, a.targetId)) throw badRequest(`${where}: ${a.targetId} is not a ${kind} of this town.`);
    return { ...a, targetKind: kind };
  });
  const targets = new Set(asks.map((a) => a.targetId).filter(Boolean));
  const p = parseRollup(body);
  const uncovered = rollupNeedsIdsAll(body, p).filter((id) => !targets.has(id));
  if (uncovered.length) {
    throw badRequest(`Your rollup asks about ${uncovered.join(", ")} (in its Needs section or a "Your call"), but no entry of \`asks\` has it as its targetId. File one ask per thing you ask the humans (type, targetId, title, body, branches, recommendation), or take the id out of the prose.`);
  }
  const calls = rollupAsks(p);
  if (calls.length && !asks.length) throw badRequest(`Your rollup asks "${oneLine(calls[0]!.call, 100)}" but \`asks\` is empty: file it as a typed ask (type, title, body, branches, recommendation), or leave \`asks\` out.`);
  return asks;
}

/** File a rollup's checked asks, each sourced to the rollup. Returns the asks and which folded into an ask already open. */
export function fileRollupAsks(world: World, me: Agent, doc: Doc, asks: ResolvedRollupAsk[]): { ask: Ask; folded: boolean }[] {
  return asks.map((a) => createAsk(world, {
    type: a.type, targetKind: a.targetKind ?? null, targetId: a.targetId ?? null, buildingId: doc.buildingId, sourceDocId: doc.id, by: me.id,
    title: a.title, body: a.body, branches: a.branches, recommendation: a.recommendation, claims: a.claims, line: a.title,
  }));
}

/** A "Your call" that offers a rule for veto ("unless you'd rather …", "say if you want …"): a policy ask. */
const POLICY = /\b(unless you['’]?d rather|say if you(?:['’]d)? want|veto|keep (?:this|the) rule|the rule)\b/i;
const ID = /\b(?:gr|sc|dc|cr|ar|kr)_[a-z0-9]+\b/g;

/**
 * The asks of a rollup filed without a typed list, read from its prose (`rollupCalls`, overtaken ones skipped), typed by
 * `proseAskShape`: a call that asks for tokens on the grant or retainer it names is a money ask on it (folding into that
 * item's own ask), a rule veto a policy ask, any other a click. Idempotent per rollup.
 */
const PROSE_BRANCHES = { money: [{ label: "Yes" }, { label: "No" }], policy: [{ label: "Keep the rule" }, { label: "Change it" }], click: [{ label: "Done" }, { label: "Decline" }] } as const satisfies Record<string, AskBranch[]>;

/** A call that asks for tokens: a grant or retainer decision (fund, counter, reject, adjust, cut, continue at a gate, raise a ceiling, top up, stop, close, approve a retainer) or a token figure ("150k", "200,000 tokens"). */
const MONEY_CALL = /\b(?:fund(?:s|ed|ing)?|counter(?:ed)?|reject(?:ed)?|adjust(?:ed)?|cut|continue|raise|top[- ]?up|ceiling|stop|close[ds]?|approve)\b|\b\d[\d,.]*\s*[km]\b|\b\d[\d,.]*\s+tokens\b/i;

/**
 * How a call read from a rollup's prose is filed: a money ask on the grant (else retainer) it names only when the call
 * asks for tokens (`MONEY_CALL`); otherwise a policy ask (a rule veto) or a click, targeted at the request, captain,
 * access request or key result it names, else untargeted. A call that merely mentions a grant ("KR3 of gr_x cannot run
 * until then") is not filed on that grant: there it would fold into the grant's own money row, or become its gate.
 */
function proseAskShape(world: World, c: { title: string; call: string }): { type: AskType; targetKind: AskTargetKind | null; targetId: string | null } {
  const ids = [...new Set(`${c.title} ${c.call}`.match(ID) ?? [])].filter((id) => { const k = kindOf(world, id); return !!k && k !== "rule" && targetExists(world, k, id); });
  const money = MONEY_CALL.test(c.call) ? ids.find((id) => id.startsWith("gr_")) ?? ids.find((id) => id.startsWith("sc_")) : undefined;
  const targetId = money ?? ids.find((id) => !id.startsWith("gr_") && !id.startsWith("sc_")) ?? null;
  return { type: money ? "money" : POLICY.test(c.call) ? "policy" : "click", targetKind: targetId ? kindOf(world, targetId) : null, targetId };
}

export function asksFromRollupProse(world: World, d: Doc): void {
  for (const c of rollupCalls(world, d)) {
    if (c.overtaken) continue;
    const { type, targetKind, targetId } = proseAskShape(world, c);
    const title = proseAskTitle(c.call);
    // idempotent: this rollup already filed this line (on its target, or untargeted with the same line or title: a title
    // written by an older rule, since repaired by `retitleProseAsks`, still counts)
    const line = oneLine(c.call, 400);
    // whatever its target or type now: a line filed under an older shape (a money ask on the grant it named, retyped by
    // `retypeProseAsks` after this runs at boot) is still filed, so no twin is made
    const filed = (targetId && targetKind && asksFor(world, { kind: targetKind, id: targetId }).some((a) => a.sources.some((s) => s.docId === d.id)))
      || world.asks.exists("sourceDocId = ? AND (title = ? OR EXISTS (SELECT 1 FROM json_each(sources) WHERE json_extract(value, '$.docId') = ? AND json_extract(value, '$.line') IN (?, ?)))", [d.id, title, d.id, line, withoutEllipsis(line)]);
    if (filed) continue;
    createAsk(world, {
      type, targetKind, targetId, buildingId: d.buildingId, sourceDocId: d.id, by: d.authorId, title, line: c.call,
      body: withoutEllipsis(c.title ? `From "${c.title}" in the rollup "${d.title}".` : `From the rollup "${d.title}".`),
      branches: PROSE_BRANCHES[type === "money" ? "money" : type === "policy" ? "policy" : "click"],
    });
  }
}

// ---- backfill ----

/** Whether a target already has an ask a backfill must not repeat: a live one, or one a human answered. */
const hasAsk = (world: World, kind: AskTargetKind, id: string) => world.asks.exists(`targetKind = ? AND targetId = ? AND status IN ('open', 'deferred', 'decided')`, [kind, id]);

/**
 * Boot repair (step 1): the asks of everything already waiting for a human: every open proposal (a countered one waits
 * on its manager: none), held grant, asked retainer, open outbox request, pending captain and access request, then each
 * pending Town Hall rollup's live calls (`asksFromRollupProse`). Idempotent: a second run creates nothing. Returns how many it made.
 */
export function backfillAsks(world: World): number {
  const before = world.asks.count();
  world.transaction(() => {
    for (const g of world.grants.where("status IN ('proposed', 'checkpoint')", [], "ORDER BY updatedAt, rowid")) {
      if (hasAsk(world, "grant", g.id)) continue;
      if (g.status === "proposed") askForProposal(world, g, `Proposal: ${g.objective} (${fmt(g.askTokens)} tokens)`);
      else askAtCheckpoint(world, g, world.grantDesk.spent(g.id), [...g.history].reverse().find((h) => h.action === "checkpoint")?.note ?? `Held at its checkpoint: ${g.objective}`);
    }
    for (const s of world.schedules.where("status = 'active' AND retainer = 'asked'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "retainer", s.id)) askForRetainer(world, s, "waiting when asks began");
    for (const d of world.docs.where("type = 'request' AND requestStatus = 'open'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "request", d.id)) askForRequest(world, d);
    for (const r of world.captainRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "captain", r.id)) askForCaptain(world, r);
    for (const r of world.accessRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid")) if (!hasAsk(world, "access", r.id)) askForAccess(world, r);
    for (const d of world.docs.where("type = 'report' AND decision = 'pending' AND tags LIKE '%\"rollup\"%'", [], "ORDER BY createdAt, rowid")) asksFromRollupProse(world, d);
  });
  return world.asks.count() - before;
}

// ---- the retitle repair (migration 105: the town's cards stop quoting the objective) ----

/** The fields of a town-written card, regenerated from its target. */
type TownCard = Pick<Ask, "title" | "body"> & Partial<Pick<Ask, "recommendation" | "claims">>;

/**
 * The card the town wrote for this ask, written again from its target: the proposal card, the gate card, a retainer's,
 * a captain, access or outbox request's. The town filed it when the ask's first source is the target itself (a gate
 * ask: its Adjust / Cut branches). Null for a card a manager wrote (a rollup's typed ask, an ask read from rollup prose),
 * and for a target gone. A manager's words merged into a gate ask, or an explorer's proposal card, keep their body.
 */
function townCardOf(world: World, a: Ask): TownCard | null {
  const id = a.targetId;
  if (!id) return null;
  switch (a.targetKind) {
    case "grant": {
      const g = world.grants.get(id);
      if (!g) return null;
      if (isGateAsk(a)) {
        const card = gateCard(world, g, { held: g.status === "checkpoint", spent: world.grantDesk.spent(g.id) });
        // a manager's ask that became the gate keeps its own words ahead of the gate card (fileGateAsk)
        const from = a.body.indexOf("You funded this at");
        if (from > 0) return { title: card.title, body: `${a.body.slice(0, from).trimEnd()}\n\n${card.body}`, recommendation: card.recommendation };
        return card;
      }
      if (a.sourceDocId !== g.id || g.status !== "proposed") return null;
      const town = a.recommendation === PROPOSAL_RECOMMENDATION;
      if (!town) return { title: proposalTitle(g), body: a.body };
      const kr = world.grantDesk.keyResultsOf(g.id).map((k) => ({ id: k.id, text: k.text }));
      return { title: proposalTitle(g), ...proposalCard({ askTokens: g.askTokens, steps: g.steps.length, keyResults: kr, counteredAt: lastCounterAt(g) }) };
    }
    case "retainer": {
      const s = world.schedules.get(id);
      if (!s || a.sourceDocId !== s.id) return null;
      const v = scheduleView(world, s);
      return { title: retainerTitle(s.title, v.askTokens), body: withoutEllipsis(retainerLine(world, v)) };
    }
    case "captain": {
      const r = world.captainRequests.get(id);
      if (!r || a.sourceDocId !== r.id) return null;
      const goal = world.goalTree.get(r.goalId)?.text ?? r.goalId;
      return { title: a.title.replace(/captain of ".*"$/s, `captain of "${nameWithin(goal)}"`), body: withoutEllipsis(r.note) };
    }
    case "access": {
      const r = world.accessRequests.get(id);
      return r && a.sourceDocId === r.id ? { title: a.title, body: withoutEllipsis(r.message) } : null;
    }
    case "request": {
      const d = world.docs.get(id);
      return d && a.sourceDocId === d.id ? { title: withoutEllipsis(d.title), body: withoutEllipsis(d.body) } : null;
    }
    default: return null;
  }
}

/**
 * Boot repair (migration 105): every live ask whose title or body carries "…" gets its town-written card written again
 * from its target (`townCardOf`), keeping its id, sources, rank, status and history, with a "retitled" history entry,
 * and is vetted again. A card a manager wrote is untouched. Idempotent: a card already rewritten has nothing to change.
 * Returns how many asks it rewrote.
 */
/**
 * The card of an ask read from a rollup's prose before typed asks existed (no target to write a card from): its own
 * words kept, the clipping dropped: the title is its first clause, the body and recommendation lose every ellipsis.
 */
function proseCardOf(a: Ask): { title: string; body: string; recommendation: string; claims: Ask["claims"] } | null {
  if (!a.title.includes("\u2026") && !a.body.includes("\u2026") && !a.recommendation.includes("\u2026")) return null;
  return { title: nameWithin(a.title, 120), body: withoutEllipsis(a.body), recommendation: withoutEllipsis(a.recommendation), claims: a.claims };
}

export function retitleClippedAsks(world: World): number {
  const done: string[] = [];
  world.transaction(() => {
    for (const a of world.asks.where(`${LIVE_ASK} AND (title LIKE '%…%' OR body LIKE '%…%')`, [], "ORDER BY createdAt, rowid")) {
      const card = townCardOf(world, a) ?? proseCardOf(a);
      if (!card) continue;
      const next = { ...a, ...card, title: clipWords(card.title, 200), sources: a.sources.map((s) => ({ ...s, line: withoutEllipsis(s.line) })) };
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

/**
 * Boot repair (migration 107: grants made before 105 carry written titles, and ask titles quote a grant's name): every
 * live ask on a grant whose card the town wrote (`townCardOf`) takes that card's title when it differs, keeping its body,
 * id, sources, rank, status and history, with a "retitled" history entry. A card a manager wrote is untouched.
 * Idempotent. Returns how many asks it retitled.
 */
export function retitleGrantAsks(world: World): number {
  let n = 0;
  world.transaction(() => {
    for (const a of world.asks.where(`${LIVE_ASK} AND targetKind = 'grant'`, [], "ORDER BY createdAt, rowid")) {
      const card = townCardOf(world, a);
      if (!card) continue;
      const title = clipWords(card.title, 200);
      if (title === a.title) continue;
      const at = nowIso();
      world.asks.upsert({ ...a, title, updatedAt: at, history: [...a.history, { at, action: "retitled", by: "system", note: `was: ${a.title}`.slice(0, 500) }] });
      n++;
    }
  });
  return n;
}

/**
 * Whether the town read this ask from a rollup's prose (`asksFromRollupProse`): its source is the rollup, its body the
 * "From … the rollup" line, its branches the prose ones, no recommendation or claims. A manager's typed ask (its own
 * title, body and recommendation) and a town card on a target are not.
 */
function isProseAsk(world: World, a: Ask): boolean {
  if (!a.sourceDocId || a.recommendation.trim() || a.claims.length) return false;
  const d = world.docs.get(a.sourceDocId);
  if (!d || d.type !== "report" || !d.tags.includes("rollup")) return false;
  if (!/^From (?:".*" in )?the rollup ".*"\.$/s.test(a.body)) return false;
  const labels = a.branches.map((b) => b.label).join("|");
  return Object.values(PROSE_BRANCHES).some((bs) => bs.map((b) => b.label).join("|") === labels);
}

/**
 * Boot repair: every live ask read from a rollup's prose (`isProseAsk`) takes its title again from its own source line
 * by `proseAskTitle` (the whole first sentence, never a fragment before a colon or a clause cut at 8 words, as "A 1",
 * "Optional" or "Create one empty repo under dungeonrpg99-ops and give" were), keeping its id, body, sources, rank,
 * status and history, with a "retitled" history entry. A manager's typed ask is untouched. Idempotent. Returns how many it retitled.
 */
export function retitleProseAsks(world: World): number {
  let n = 0;
  world.transaction(() => {
    for (const a of world.asks.where(LIVE_ASK, [], "ORDER BY createdAt, rowid")) {
      if (!isProseAsk(world, a)) continue;
      const line = a.sources.find((s) => s.docId === a.sourceDocId)?.line;
      if (!line) continue;
      const title = clipWords(proseAskTitle(withoutEllipsis(line)), 200);
      if (!title || title === a.title) continue;
      const at = nowIso();
      world.asks.upsert({ ...a, title, updatedAt: at, history: [...a.history, { at, action: "retitled", by: "system", note: `was: ${a.title}`.slice(0, 500) }] });
      n++;
    }
  });
  return n;
}

/**
 * Boot repair: a live ask read from a rollup's prose as a money ask on a grant (or retainer) only because its line named
 * one, though the line asks for no tokens (`proseAskShape`: the repo to create, a key result to flip), is typed again from
 * its source line: a click (or policy ask) with the prose branches, on the request, captain, access request or key result
 * the line names, else untargeted, vetted again, with a "retyped" history entry. A target that already has a live ask of
 * its own leaves it untargeted (no second row on one target). Its id, title, body, sources, rank and status stay.
 * Idempotent. Returns how many it retyped.
 */
export function retypeProseAsks(world: World): number {
  let n = 0;
  world.transaction(() => {
    for (const a of world.asks.where(`${LIVE_ASK} AND type = 'money'`, [], "ORDER BY createdAt, rowid")) {
      if (!isProseAsk(world, a)) continue;
      const line = a.sources.find((s) => s.docId === a.sourceDocId)?.line;
      const d = line && world.docs.get(a.sourceDocId!);
      if (!line || !d) continue;
      const c = rollupCalls(world, d).find((x) => { const l = oneLine(x.call, 400); return l === line || withoutEllipsis(l) === withoutEllipsis(line); });
      if (!c) continue;
      const shape = proseAskShape(world, c);
      if (shape.type === "money") continue;
      const taken = shape.targetKind && shape.targetId ? liveAskOn(world, shape.targetKind, shape.targetId) : undefined;
      const [targetKind, targetId] = taken && taken.id !== a.id ? [null, null] : [shape.targetKind, shape.targetId];
      const branches = PROSE_BRANCHES[shape.type === "policy" ? "policy" : "click"];
      const at = nowIso();
      const v = vetted(world, shape.type, { title: a.title, body: a.body, recommendation: a.recommendation, claims: a.claims, branches, targetKind }, at, "system");
      const was = `was: money on ${a.targetKind} ${a.targetId} (${a.branches.map((b) => b.label).join(" / ")})`;
      world.asks.upsert({
        ...a, type: shape.type, targetKind, targetId, branches: [...branches], tags: [...a.tags.filter((t) => t !== LINT_FAILED), ...v.tags], updatedAt: at,
        history: [...a.history, { at, action: "retyped", by: "system", note: was.slice(0, 500) }, ...v.lint],
      });
      n++;
    }
  });
  return n;
}

/**
 * Boot repair: live asks read from one rollup's prose for one line (same source rollup, same title or source line) are
 * twins: older boots filed the line again when its first ask's title or target had changed (2026-11-09: six pairs from
 * a 04:47 boot; ak_964oxnm14w and ak_4nc6kwr1wt twinned by the boot that retyped them). One stays (the one with a
 * target, else a deferred one, else a ranked one, else the oldest); each other folds into it (status "folded",
 * `foldedInto`, a "fold" history entry); a twin deferred behind its own twin is never the one kept. Then a deferral
 * behind a folded ask follows the fold: the ask it folded into (or one whose keeper is settled) opens again, any other
 * waits behind the kept one. Idempotent. Returns how many asks it folded, reopened or repointed.
 */
export function foldTwinProseAsks(world: World): number {
  let n = 0;
  world.transaction(() => {
    const lineOf = (a: Ask) => withoutEllipsis(a.sources.find((s) => s.docId === a.sourceDocId)?.line ?? "");
    const byRollup = new Map<string, Ask[][]>();
    for (const a of world.asks.where(LIVE_ASK, [], "ORDER BY createdAt, rowid")) {
      if (!isProseAsk(world, a)) continue;
      const groups = byRollup.get(a.sourceDocId!) ?? [];
      byRollup.set(a.sourceDocId!, groups);
      const twin = groups.find((g) => g.some((b) => b.title === a.title || (!!lineOf(a) && lineOf(b) === lineOf(a))));
      if (twin) twin.push(a); else groups.push([a]);
    }
    for (const g of [...byRollup.values()].flat()) {
      if (g.length < 2) continue;
      // a twin the Secretary deferred behind its own twin is the duplicate, not the one to keep
      const behindTwin = (a: Ask) => !!a.deferredUntil && g.some((b) => b.id !== a.id && names(a.deferredUntil!, b.id));
      const keep = g.find((a) => a.targetId) ?? g.find((a) => a.status === "deferred" && !behindTwin(a)) ?? g.find((a) => a.rank != null && !behindTwin(a)) ?? g.find((a) => !behindTwin(a)) ?? g[0]!;
      const at = nowIso();
      for (const a of g) {
        if (a.id === keep.id) continue;
        world.asks.upsert({ ...a, status: "folded", foldedInto: keep.id, updatedAt: at, history: [...a.history, { at, action: "fold", by: "system", note: `twin of ${keep.id}: the same rollup line` }] });
        world.events.append({ type: "ask.folded", buildingId: a.buildingId, text: `Folded twin "${oneLine(a.title, 80)}" into ${keep.id}`, payload: { askId: a.id, foldedInto: keep.id, sourceDocId: a.sourceDocId } });
        n++;
      }
    }
    // a deferral behind a folded twin: the ask it folded into opens again; any other waits behind the kept one instead
    // (2026-11-10, c4952482's boot: four kept asks were deferred behind the twin folded into them, ak_r7qwu3wy7f behind one)
    const folded = world.asks.where("status = 'folded' AND foldedInto IS NOT NULL", []);
    for (const a of world.asks.where("status = 'deferred' AND deferredUntil IS NOT NULL", [], "ORDER BY createdAt, rowid")) {
      const hit = folded.find((f) => f.id !== a.id && names(a.deferredUntil!, f.id));
      if (!hit) continue;
      const at = nowIso();
      const into = world.asks.get(hit.foldedInto!);
      if (hit.foldedInto === a.id || !into || (into.status !== "open" && into.status !== "deferred")) {
        const why = hit.foldedInto === a.id ? "was its twin, folded into it" : `folded into ${hit.foldedInto}, which is settled`;
        world.asks.upsert({ ...a, status: "open", deferredUntil: null, updatedAt: at, history: [...a.history, { at, action: "reopen", by: "system", note: `${hit.id} it waited behind ${why}` }] });
        world.events.append({ type: "ask.reopened", buildingId: a.buildingId, text: `"${oneLine(a.title, 80)}" is open again: ${hit.id} it waited behind ${why}`, payload: { askId: a.id, behind: hit.id, reason: why } });
      } else {
        const until = a.deferredUntil!.split(hit.id).join(hit.foldedInto!);
        world.asks.upsert({ ...a, deferredUntil: until, updatedAt: at, history: [...a.history, { at, action: "defer", by: "system", note: `${hit.id} folded into ${hit.foldedInto}: ${until}`.slice(0, 500) }] });
      }
      n++;
    }
  });
  return n;
}

// ---- legible delegation step 7: the gate card (an over-ceiling forecast, a hold at the ceiling) ----

const GATE_BRANCHES: AskBranch[] = [{ label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }];
/** A live ask the town filed at a gate: its branches are exactly Adjust and Cut. A manager's own money ask on the grant is not one. */
const isGateAsk = (a: Ask) => a.branches.length === 2 && a.branches[0]?.action === "adjust" && a.branches[1]?.action === "cut";
const word = (n: number) => (["no", "one", "two", "three", "four", "five"][n] ?? String(n));
const Word = (n: number) => word(n).replace(/^./, (c) => c.toUpperCase());
const sizesLine = (sizes: StepSize[]) => (["S", "M", "L"] as const).flatMap((z) => { const n = sizes.filter((s) => s === z).length; return n ? [`${word(n)} ${z}`] : []; }).join(", ");

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
 * The money card the town writes at a grant's gate (docs/legible-delegation.md §7.3 point 4), from the grant's history,
 * its plan and its latest forecast: the human's prior decision and when, spent against the ceiling, steps done and left
 * by size, the projection and the shortfall, what each branch does, a recommendation (adjust by the shortfall rounded up
 * to a step size; cut when the latest step report's verdict is stop or pivot, or nothing is left), and one claim (the
 * latest step report: checked by a key result whose howToCheck is a curl, else manual). `held`: the grant is at its
 * ceiling now; `spent`: its spend now. Facts the town lacks are left out, never guessed: with no forecast and no top-up
 * line there is no recommendation, with no report no claim, and the card's history carries a warning naming the field.
 */
function gateCard(world: World, g: Grant, o: { held: boolean; spent: number; report?: Doc | null }): Card & { title: string } {
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
  const doneSizes = g.steps.flatMap((s, i) => (states[i]?.status === "done" ? [s.size ?? "M"] : []));
  const leftSizes = g.steps.flatMap((s, i) => (states[i]?.status === "done" ? [] : [s.size ?? "M"]));
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
  const kr = report ? world.grantDesk.keyResultsOf(g.id).find((k) => urlOfHowToCheck(k.howToCheck)) : undefined;
  // the forks' top-up line is a claim with its report to check, not a quote in the body (§5: the body holds no quoted prose)
  const topUpReport = g.checkpointDocId ?? report?.id ?? null;
  const claims: AskClaim[] = [
    ...(report ? [{ text: clipWords(`The latest step report, "${withoutEllipsis(report.title)}", says ${verdict ?? "continue"}.`, 400), check: kr ? { kind: "kr" as const, ref: kr.id } : { kind: "manual" as const, ref: report.id } }] : []),
    ...(g.topUpTokens && g.whatTopUpBuys.trim() ? [{ text: `The forks say ${fmt(g.topUpTokens)} more tokens finish it`, check: topUpReport ? { kind: "manual" as const, ref: topUpReport } : { kind: "manual" as const } }] : []),
  ];
  const name = quotedGrantName(g);
  const title = o.held ? `${name} is held at its ceiling: adjust or cut it` : `Adjust or cut ${name}: projected ${kTokens(need)} past its ceiling`;
  return { title, body, recommendation, claims };
}

/**
 * File the gate's money ask on the grant (Adjust / Cut), or fold into the live one: a gate ask already open (an earlier
 * forecast's, or the hold's) takes the new card and title, vetted again. Any other live money ask on the grant (a
 * manager's, or one parsed from rollup prose with Yes / No) becomes the gate: its branches are replaced with Adjust /
 * Cut (a bare Yes would decide the ask and leave the grant held), it keeps its sources and its words, and the gate card
 * is appended to its body, its title, recommendation and claims taken from the card.
 */
function fileGateAsk(world: World, g: Grant, card: Card & { title: string }, sourceDocId: string, line: string): Ask {
  // the live ask as it stood: a fold may adopt the card's words in place of an ask's own (createAsk), and those are kept here
  const prior = liveAskOn(world, "grant", g.id);
  const { ask, folded } = createAsk(world, { type: "money", targetKind: "grant", targetId: g.id, buildingId: g.buildingId, sourceDocId, line, ...card, branches: GATE_BRANCHES });
  if (!folded) return ask;
  const at = nowIso();
  const merged: Card & { title: string } = !prior || isGateAsk(prior) ? card : {
    ...card,
    body: prior.body.trim() ? `${prior.body.trimEnd()}\n\n${card.body}` : card.body,
    claims: [...card.claims, ...prior.claims].slice(0, 2), // the money contract takes 1-2: the gate's claim first
  };
  const v = vetted(world, "money", { ...merged, branches: GATE_BRANCHES, targetKind: "grant" }, at, "system");
  const next = world.asks.upsert({ ...ask, ...merged, branches: GATE_BRANCHES, title: clipWords(merged.title, 200), tags: [...ask.tags.filter((t) => t !== LINT_FAILED), ...v.tags], updatedAt: at, history: [...ask.history, ...v.lint] });
  queueClaimChecks(world, next.id);
  return next;
}

/**
 * A step report's forecast projected the grant past its ceiling (`fileForecast`): the money ask that arrives before the
 * hold, filed while the next step keeps running. Folds into the grant's live gate ask, so a later forecast or the hold
 * at the ceiling updates one card.
 */
export function askAtForecast(world: World, g: Grant, report: Doc | null, line: string): Ask {
  return fileGateAsk(world, g, gateCard(world, g, { held: false, spent: g.forecast?.spent ?? world.grantDesk.spent(g.id), report }), report?.id ?? g.id, line);
}

/** A later forecast is back within the ceiling: the open gate ask of a still-running grant retires with that line. */
export function retireGateAsk(world: World, g: Grant, reason: string): Ask[] {
  if (g.status !== "funded") return [];
  const live = liveAskOn(world, "grant", g.id);
  return live && isGateAsk(live) ? retireAsks(world, "grant", g.id, reason) : [];
}

/**
 * A funded grant held at its ceiling (`Grants.checkpoints`): the money ask to adjust or cut it, its card from the grant's
 * history and latest forecast (`gateCard`). When a forecast already filed the gate ask, the hold folds into it and its
 * title says the grant is held.
 */
export function askAtCheckpoint(world: World, g: Grant, spent: number, line: string): void {
  fileGateAsk(world, g, gateCard(world, g, { held: true, spent }), g.checkpointDocId ?? g.id, line);
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
  return world.asks.where(LIVE_ASK, [], "ORDER BY rank IS NULL, rank, createdAt, rowid");
}
