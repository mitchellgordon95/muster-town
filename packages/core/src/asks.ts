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
  parseRollup, rollupAsks, rollupNeedsIdsAll, Ask, RollupAskInput, type AccessRequest, type Agent, type AskBranch, type AskClaim, type AskTargetKind, type AskType,
  type CaptainRequest, type Doc, type Event, type Grant, type Schedule,
} from "@muster-town/schema";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { holderOf } from "./permissions.ts";
import { scheduleView, retainerLine } from "./retainers.ts";
import { rollupCalls } from "./secretary.ts";
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
    const next = world.asks.upsert({ ...have, sources: [...have.sources, ...source], updatedAt: at, history: [...have.history, { at, action: "fold", by, note: `${n.sourceDocId}: ${line}` }] });
    world.events.append({ type: "ask.folded", buildingId: n.buildingId, text: `Folded into "${oneLine(have.title, 80)}": ${oneLine(line, 120)}`, payload: { askId: have.id, sourceDocId: n.sourceDocId, targetKind: kind, targetId: n.targetId } });
    return { ask: next, folded: true };
  }
  const ask = world.asks.upsert(Ask.parse({
    id: newId("ak"), type: n.type, targetKind: kind, targetId: kind ? n.targetId : null, buildingId: n.buildingId, sourceDocId: n.sourceDocId,
    title: oneLine(n.title, 200), body: n.body ?? "", branches: n.branches, recommendation: n.recommendation ?? "", claims: n.claims ?? [],
    status: "open", sources: source, createdAt: at, updatedAt: at, history: [{ at, action: "create", by, note: "" }],
  }));
  world.events.append({ type: "ask.created", buildingId: n.buildingId, text: `Ask (${n.type}): ${oneLine(ask.title, 120)}`, payload: { askId: ask.id, type: n.type, targetKind: kind, targetId: ask.targetId, sourceDocId: n.sourceDocId } });
  return { ask, folded: false };
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
  const at = nowIso();
  const next = world.asks.upsert({ ...a, status: "decided", decidedBy: by, decidedAt: at, decision: said.slice(0, 2000), updatedAt: at, history: [...a.history, { at, action: "decide", by, note: said.slice(0, 500) }] });
  world.events.append({ type: "ask.decided", agentId: actor?.id ?? null, buildingId: a.buildingId, text: `Decided "${oneLine(a.title, 80)}": ${oneLine(said, 160)}`, payload: { askId: a.id, decision: said, by } });
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

/** A grant proposal's money ask: fund / counter / reject. */
function askForProposal(world: World, g: Grant, line: string): void {
  createAsk(world, {
    type: "money", targetKind: "grant", targetId: g.id, buildingId: g.buildingId, sourceDocId: g.id, by: g.proposedBy,
    title: `Fund "${oneLine(g.objective, 120)}" at ${fmt(g.askTokens)} tokens`, line,
    body: [g.objective, g.approach && `Approach: ${g.approach}`, g.stopCondition && `Stops when: ${g.stopCondition}`].filter(Boolean).join("\n\n"),
    branches: [{ label: "Fund", action: "fund" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }],
  });
}

/** A funded grant held at its checkpoint (`Grants.checkpoints`): the money ask to continue, adjust or cut it. */
export function askAtCheckpoint(world: World, g: Grant, spent: number, line: string): void {
  const tokens = g.grantTokens ?? 0;
  const buys = g.topUpTokens && g.whatTopUpBuys.trim() ? `A top-up of ${fmt(g.topUpTokens)} tokens buys: ${g.whatTopUpBuys.trim()}` : "";
  createAsk(world, {
    type: "money", targetKind: "grant", targetId: g.id, buildingId: g.buildingId, sourceDocId: g.checkpointDocId ?? g.id,
    title: `Continue "${oneLine(g.objective, 120)}" at its checkpoint`, line,
    body: [`It has spent ${fmt(spent)} of ${fmt(tokens)} tokens. New sessions on it wait for you.`, buys].filter(Boolean).join("\n\n"),
    branches: [{ label: "Continue", action: "continue" }, { label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }],
  });
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
