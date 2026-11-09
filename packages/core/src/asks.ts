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
  grantPricingOf, parseRollup, rollupAsks, rollupNeedsIdsAll, vetAsk, Ask, RollupAskInput, type AccessRequest, type Agent, type AskBranch, type AskClaim, type AskTargetKind,
  type AskType, type CalibrationProposal, type CaptainRequest, type Doc, type Event, type Grant, type Schedule, type StepSize,
} from "@muster-town/schema";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { queueClaimChecks, urlOfHowToCheck } from "./ask-checks.ts";
import { dictionaryPairs } from "./dictionary.ts";
import { managerAgentOf } from "./domain.ts";
import { onRuleAskDecided, requireRuleDecider } from "./planner.ts";
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
    const adopt = (!have.recommendation.trim() || have.tags.includes(LINT_FAILED)) && !!n.recommendation?.trim();
    const card = adopt ? vetted(world, have.type, { body: n.body ?? "", recommendation: n.recommendation, claims: n.claims ?? [], branches: have.branches, targetKind: have.targetKind }, at, by) : null;
    const next = world.asks.upsert({
      ...have, ...(card ? { body: n.body ?? "", recommendation: n.recommendation!, claims: n.claims ?? [], tags: card.tags } : {}), sources: [...have.sources, ...source], updatedAt: at,
      history: [...have.history, { at, action: "fold", by, note: `${n.sourceDocId}: ${line}` }, ...(card?.lint ?? [])],
    });
    world.events.append({ type: "ask.folded", buildingId: n.buildingId, text: `Folded into "${oneLine(have.title, 80)}": ${oneLine(line, 120)}`, payload: { askId: have.id, sourceDocId: n.sourceDocId, targetKind: kind, targetId: n.targetId } });
    if (card) queueClaimChecks(world, next.id);
    return { ask: next, folded: true };
  }
  const card = vetted(world, n.type, { body: n.body ?? "", recommendation: n.recommendation ?? "", claims: n.claims ?? [], branches: n.branches, targetKind: kind }, at, by);
  const ask = world.asks.upsert(Ask.parse({
    id: newId("ak"), type: n.type, targetKind: kind, targetId: kind ? n.targetId : null, buildingId: n.buildingId, sourceDocId: n.sourceDocId,
    title: oneLine(n.title, 200), body: n.body ?? "", branches: n.branches, recommendation: n.recommendation ?? "", claims: n.claims ?? [],
    status: "open", sources: source, createdAt: at, updatedAt: at, history: [{ at, action: "create", by, note: "" }, ...card.lint], tags: card.tags, proposal: n.proposal ?? null,
  }));
  world.events.append({ type: "ask.created", buildingId: n.buildingId, text: `Ask (${n.type}): ${oneLine(ask.title, 120)}`, payload: { askId: ask.id, type: n.type, targetKind: kind, targetId: ask.targetId, sourceDocId: n.sourceDocId } });
  queueClaimChecks(world, ask.id);
  return { ask, folded: false };
}

/**
 * Step 3: every card is vetted against its type's contract and the linter as it is stored. One that fails carries the
 * tag "lint-failed" and a "lint" history entry with the failing rules: an author's third failing attempt
 * (`refuseOrFlag`), or a card the town wrote from a source's own words. No card reaches the in-tray unvetted.
 */
function vetted(world: World, type: AskType, card: Parameters<typeof vetAsk>[1], at: string, by: string): { tags: string[]; lint: Ask["history"] } {
  const problems = vetAsk(type, { ...card, dictionary: dictionaryPairs(world) });
  return problems.length ? { tags: [LINT_FAILED], lint: [{ at, action: "lint", by, note: problems.join("\n").slice(0, 4000) }] } : { tags: [], lint: [] };
}

const LINT_FAILED = "lint-failed";
/** How many failing attempts an author gets before the card is filed flagged instead of refused (§12 question 4). */
const ASK_STRIKES = 3;

/**
 * Step 3's bounce: an author's card (a rollup's typed asks, a proposal's money ask) that fails its contract or the
 * linter is refused with the failing rules, the way a malformed rollup is. The same session's third failing attempt
 * goes through and is filed tagged "lint-failed" (`createAsk`), so a report is never blocked for ever. Each refusal is
 * an `ask.refused` event keyed by the session (else the assignment, else the agent) and `what` ("rollup", "proposal").
 */
export function refuseOrFlag(world: World, me: Agent, what: string, problems: string[]): void {
  if (!problems.length) return;
  const session = world.sessions.first("agentId = ? AND status = 'running'", [me.id], "ORDER BY startedAt DESC");
  const key = `${session?.id ?? me.currentAssignmentId ?? me.id}:${what}`;
  const before = (world.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ask.refused' AND json_extract(payload, '$.strikeKey') = ?").get(key) as { n: number }).n;
  if (before + 1 >= ASK_STRIKES) return;
  world.events.append({ type: "ask.refused", agentId: me.id, buildingId: me.homeBuildingId ?? null, text: `${me.name}'s ${what} ask card was refused: ${oneLine(problems[0]!, 160)}`, payload: { strikeKey: key, what, problems } });
  const last = before + 2 >= ASK_STRIKES;
  throw badRequest(`Your ${what}'s ask card fails ${problems.length} rule${problems.length === 1 ? "" : "s"} (docs/legible-delegation.md §5). Rewrite it and resubmit${last ? ". Your next attempt is filed even if it still fails, flagged lint-failed for the humans" : ""}:\n- ${problems.join("\n- ")}`);
}

/** Retire every live ask on a target: its deciding event fired. `reason` is that event's text. Returns the asks retired. */
export function retireAsks(world: World, kind: AskTargetKind, id: string, reason: string): Ask[] {
  const at = nowIso();
  return world.asks.where(`targetKind = ? AND targetId = ? AND ${LIVE_ASK}`, [kind, id], "ORDER BY createdAt, rowid").map((a) => {
    const next = world.asks.upsert({ ...a, status: "retired", retiredBy: reason, updatedAt: at, history: [...a.history, { at, action: "retire", by: "system", note: reason }] });
    world.events.append({ type: "ask.retired", buildingId: a.buildingId, text: `Retired "${oneLine(a.title, 80)}": ${oneLine(reason, 160)}`, payload: { askId: a.id, targetKind: kind, targetId: id, reason } });
    return next;
  });
}

/** Who answers an ask: a human who can fund its building (an admin anywhere). Never an agent. */
function requireDecider(world: World, actor: Agent | null, a: Ask): string {
  if (!actor || holderOf(actor).kind !== "user") throw forbidden("building.fund", "Only a human decides an ask.");
  if (!world.permissions.can(actor, "building.fund", a.buildingId)) throw forbidden("building.fund");
  return holderOf(actor).id;
}

/** A human answers a live ask (`decision`: the branch label or their words). Decides nothing else: a target keeps its own verb. */
export function decideAsk(world: World, actor: Agent | null, id: string, decision: string): Ask {
  const a = world.asks.require(id, "ask");
  const by = requireDecider(world, actor, a);
  if (a.status !== "open" && a.status !== "deferred") throw new AppError("conflict", `This ask is already ${a.status}.`);
  const said = decision.trim();
  if (!said) throw badRequest("Say what you decided (decision).");
  // step 9: adopting the Planner's table change is an admin's (it is PUT /api/town/defaults' change)
  requireRuleDecider(world, actor!, a, said);
  const at = nowIso();
  const next = world.asks.upsert({ ...a, status: "decided", decidedBy: by, decidedAt: at, decision: said.slice(0, 2000), updatedAt: at, history: [...a.history, { at, action: "decide", by, note: said.slice(0, 500) }] });
  world.events.append({ type: "ask.decided", agentId: actor?.id ?? null, buildingId: a.buildingId, text: `Decided "${oneLine(a.title, 80)}": ${oneLine(said, 160)}`, payload: { askId: a.id, decision: said, by } });
  // step 5: a decided policy ask proposes its rule for the ledger; a decided "Add this rule?" ask appends it (secretary.ts)
  onAskDecided(world, next);
  // step 9: a rule ask carrying the Planner's table change, decided "Adopt", applies it (planner.ts)
  onRuleAskDecided(world, actor!, next);
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
    title: `Fund "${oneLine(g.objective, 120)}" at ${fmt(g.askTokens)} tokens`, line,
    ...proposalCard({ objective: g.objective, askTokens: g.askTokens, steps: g.steps.length, keyResults: kr, counteredAt: lastCounterAt(g) }),
    branches: [{ label: "Fund", action: "fund" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }],
  });
}

/** When a human last countered this grant (it is being re-proposed), or null. */
export const lastCounterAt = (g: Pick<Grant, "history">): string | null => [...g.history].reverse().find((h) => h.action === "counter")?.at ?? null;

/** The card fields a proposal's money ask carries. */
type Card = Required<Pick<NewAsk, "body" | "recommendation" | "claims">>;

/**
 * The card the town writes for a proposal whose explorer gave none (`propose_grant` without `ask`, or a proposal made
 * over REST): the prior decision, the objective as written, the ask, what is spent, the steps, both branches, and the
 * first two key results as its claims (checked by their howToCheck when it is a curl or a URL). The objective is the
 * explorer's own words, so the linter judges it: an objective with ids, parentheses or long sentences fails.
 */
export function proposalCard(p: { objective: string; askTokens: number; steps: number; keyResults: { id?: string; text: string }[]; counteredAt?: string | null }): Card {
  const objective = p.objective.trim().replace(/([^.!?])$/, "$1.");
  const prior = p.counteredAt ? `You countered it at ${stamp(p.counteredAt)}. This is the revised plan.` : "This is a new proposal. You have not decided on it before.";
  return {
    body: [
      prior, objective,
      `It asks for ${fmt(p.askTokens)} tokens. Nothing is spent yet.`,
      `It has ${p.steps} step${p.steps === 1 ? "" : "s"}, and none is done yet.`,
      "If you fund: step 1 starts on the building queue.",
      "If you reject: nothing runs, and the tokens stay free.",
    ].join("\n"),
    recommendation: "Fund it: the building proposed it as its next piece of work.",
    claims: p.keyResults.slice(0, 2).map((k) => ({ text: `Key result: ${oneLine(k.text, 300)}`, check: k.id ? { kind: "kr" as const, ref: k.id } : { kind: "manual" as const } })),
  };
}

/**
 * Put an author's card on the live ask of a target (`propose_grant` with `ask`): body, recommendation and claims, vetted
 * again (tagged lint-failed when it fails), and its checks queued. No live ask: nothing.
 */
export function setAskCard(world: World, kind: AskTargetKind, id: string, card: Card, by: string): Ask | null {
  const have = liveAskOn(world, kind, id);
  if (!have) return null;
  const at = nowIso();
  const v = vetted(world, have.type, { ...card, branches: have.branches, targetKind: have.targetKind }, at, by);
  const next = world.asks.upsert({ ...have, ...card, tags: v.tags, updatedAt: at, history: [...have.history, ...v.lint] });
  queueClaimChecks(world, next.id);
  return next;
}

/** A retainer asked (`askRetainer`): approve / counter / reject. */
export function askForRetainer(world: World, s: Schedule, why: string): void {
  const v = scheduleView(world, s);
  createAsk(world, {
    type: "money", targetKind: "retainer", targetId: s.id, buildingId: s.buildingId, sourceDocId: s.id,
    title: `Approve the retainer for "${oneLine(s.title, 100)}" (${fmt(v.askTokens)} tokens)`, line: `${retainerLine(world, v)} (${why})`,
    body: retainerLine(world, v),
    branches: [{ label: "Approve", action: "approve" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }],
  });
}

/** A request for a token, key or credential (the click it asks for is issuing one). */
const CREDENTIAL = /\b(token|tokens|credential|credentials|api[- ]?key|keys?|PAT|password|secret|ssh|oauth|scope)\b/i;

/** An outbox request (`request_human`): a credential ask when it asks for a token or key, else a click. Claim / decline. */
export function askForRequest(world: World, d: Doc): void {
  createAsk(world, {
    type: CREDENTIAL.test(`${d.title}\n${d.body}`) ? "credential" : "click", targetKind: "request", targetId: d.id, buildingId: d.buildingId, sourceDocId: d.id,
    by: d.authorId, title: d.title, body: d.body, line: d.title,
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
    title: `Make ${name} captain of "${oneLine(goal, 100)}"`, body: r.note, line: `${name} asks to captain "${oneLine(goal, 100)}"${r.note ? `: ${r.note}` : ""}`,
    branches: [{ label: "Accept", action: "accept" }, { label: "Decline", action: "decline" }],
  });
}

/** A signed-in visitor asks to join: let in / decline. */
export function askForAccess(world: World, r: AccessRequest): void {
  const who = world.users.get(r.userId);
  const name = who?.githubLogin ? `@${who.githubLogin}` : who?.name ?? r.userId;
  createAsk(world, {
    type: "click", targetKind: "access", targetId: r.id, buildingId: null, sourceDocId: r.id, by: r.userId,
    title: `Let ${name} in`, body: r.message, line: `${name} asked to join${r.message ? `: ${r.message}` : ""}`,
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
 * The asks of a rollup filed without a typed list, read from its prose (`rollupCalls`, overtaken ones skipped): a call
 * naming a grant (or retainer) is a money ask on it (folding into that item's own ask), a rule veto a policy ask, any
 * other a click (targeted at the request, captain, access request or key result it names, if any). Idempotent per rollup.
 */
export function asksFromRollupProse(world: World, d: Doc): void {
  for (const c of rollupCalls(world, d)) {
    if (c.overtaken) continue;
    const ids = [...new Set(`${c.title} ${c.call}`.match(ID) ?? [])].filter((id) => { const k = kindOf(world, id); return !!k && k !== "rule" && targetExists(world, k, id); });
    const money = ids.find((id) => id.startsWith("gr_")) ?? ids.find((id) => id.startsWith("sc_"));
    const targetId = money ?? ids[0] ?? null;
    const targetKind = targetId ? kindOf(world, targetId) : null;
    const type: AskType = money ? "money" : POLICY.test(c.call) ? "policy" : "click";
    const title = oneLine(c.call, 160);
    // idempotent: this rollup already filed this line (on its target, or untargeted under the same title)
    const filed = targetId && targetKind
      ? asksFor(world, { kind: targetKind, id: targetId }).some((a) => a.sources.some((s) => s.docId === d.id))
      : world.asks.exists("targetId IS NULL AND sourceDocId = ? AND title = ?", [d.id, title]);
    if (filed) continue;
    createAsk(world, {
      type, targetKind, targetId, buildingId: d.buildingId, sourceDocId: d.id, by: d.authorId, title, line: c.call,
      body: c.title ? `From "${c.title}" in the rollup "${d.title}".` : `From the rollup "${d.title}".`,
      branches: type === "money" ? [{ label: "Yes" }, { label: "No" }] : type === "policy" ? [{ label: "Keep the rule" }, { label: "Change it" }] : [{ label: "Done" }, { label: "Decline" }],
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
 * line there is no recommendation, with no report no claim, and `vetAsk` tags the card lint-failed naming the field.
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
  const buys = g.topUpTokens && g.whatTopUpBuys.trim() ? `The forks say ${fmt(g.topUpTokens)} more tokens buy this: ${oneLine(g.whatTopUpBuys, 300).replace(/([^.!?])$/, "$1.")}` : "";
  const body = [
    ...prior,
    `It has spent ${fmt(o.spent)} of its ${fmt(ceiling)}-token ceiling.${o.held ? " New sessions on it wait for you." : ""}`,
    ...steps, ...projection, buys,
    raise ? `If you adjust by ${fmt(raise)}: the ceiling becomes ${fmt(ceiling + raise)} tokens, and the work runs on.` : "If you adjust: the ceiling rises by what you give, and the work runs on.",
    o.held ? "If you cut: the grant closes at what it spent, and nothing more runs on it." : "If you cut: the running step wraps up, and the grant closes at what it spent.",
  ].filter(Boolean).join("\n");
  const kr = report ? world.grantDesk.keyResultsOf(g.id).find((k) => urlOfHowToCheck(k.howToCheck)) : undefined;
  const claims: AskClaim[] = report ? [{
    text: oneLine(`The latest step report, "${report.title}", says ${verdict ?? "continue"}.`, 400),
    check: kr ? { kind: "kr", ref: kr.id } : { kind: "manual", ref: report.id },
  }] : [];
  const title = o.held ? `"${oneLine(g.objective, 120)}" is held at its ceiling: adjust or cut it`
    : `Adjust or cut "${oneLine(g.objective, 120)}": projected ${fmt(need)} tokens past its ceiling`;
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
  const next = world.asks.upsert({ ...ask, ...merged, branches: GATE_BRANCHES, title: oneLine(merged.title, 200), tags: [...ask.tags.filter((t) => t !== LINT_FAILED), ...v.tags], updatedAt: at, history: [...ask.history, ...v.lint] });
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
