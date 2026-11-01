/**
 * Retainers (1:1 mt_cyd2t5ioob decision 2; docs/bank.md "Retainers", docs/how-work-gets-done.md §9): standing money for a
 * scheduled job, approved by a human, claimed in the Bank. Grants are one-time, so a recurring job never draws on one: a
 * schedule carries `tokensPerRun` (Bank tokens, Opus 5.5 output tokens) and asks for tokensPerRun × runs left in the
 * Town Hall in-tray. Each fire's assignment runs in lane "retainer" with sourceId = the schedule; its sessions book
 * against the schedule (drawn, derived from sessions like a grant's spend). Runs are held while the retainer is not
 * funded, or when one more run would pass the approved total; a run that reaches tokensPerRun is asked to wrap up.
 * A funded retainer is the Bank's fourth claim (free-tokens.ts). Since 2026-11-01 it claims only what is near: the runs
 * due within the town's lookahead (default 6 h) plus what a run under way may still spend, never more than the approved
 * total leaves (the approved total stays the ceiling). A run that comes due with nothing usable to run on (no credential
 * for its model, or its claim fully overdrafted) is missed, not queued, and its manager hears once per streak.
 */
import type { Agent, Assignment, RetainerDecisionInput, Schedule, ScheduleView } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { managerAgentOf, sendMessage } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { claimShort, freeTokens } from "./free-tokens.ts";
import { holderOf } from "./permissions.ts";
import { nextOccurrence } from "./schedules.ts";
import { stamp } from "./time.ts";
import { truncate } from "./util.ts";
import { interruptNow } from "./wakes.ts";
import type { World } from "./world.ts";

const fmt = (n: number) => n.toLocaleString("en-US");
/** Counting a long daily repeat stops here (90 days × 24 times a day fits). */
const MAX_COUNT = 5_000;

type Timing = Pick<Schedule, "status" | "nextRunAt" | "everyMinutes" | "dailyAt" | "endsAt" | "maxRuns" | "runs" | "paused">;

/**
 * How many more times the schedule will fire: a one-shot 1; a repeat counts its occurrences from the next run (a paused
 * one whose next run passed resumes at its next occurrence from now) to `endsAt`, capped by what `maxRuns` leaves. Ended: 0.
 */
export function runsLeft(s: Timing, now = new Date()): number {
  if (s.status === "ended" || !s.nextRunAt) return 0;
  const repeating = !!s.everyMinutes || !!s.dailyAt?.length;
  const capLeft = s.maxRuns ? Math.max(0, s.maxRuns - s.runs) : Infinity;
  if (!repeating) return Math.min(1, capLeft);
  let start = new Date(s.nextRunAt);
  if (s.paused && start.getTime() < now.getTime()) start = nextOccurrence(s, now, start) ?? start;
  const end = s.endsAt ? Date.parse(s.endsAt) : start.getTime();
  if (start.getTime() > end) return 0;
  let n = 0;
  if (s.everyMinutes) n = Math.floor((end - start.getTime()) / (s.everyMinutes * 60_000)) + 1;
  else for (let t: Date | null = start; t && t.getTime() <= end && n < MAX_COUNT; t = nextOccurrence(s, t)) n++;
  return Math.min(n, capLeft);
}

/** What the retainer asks for now: tokensPerRun × runs left. */
function retainerAsk(s: Timing & Pick<Schedule, "tokensPerRun">, now = new Date()): number {
  return s.tokensPerRun * runsLeft(s, now);
}

/** Adjusted tokens the schedule's runs have booked (sessions of its lane-retainer assignments), running sessions included. */
function retainerDrawn(world: World, scheduleId: string): number {
  return world.sessions.where("assignmentId IN (SELECT id FROM assignments WHERE lane = 'retainer' AND sourceId = ?)", [scheduleId])
    .reduce((sum, x) => sum + sessionTokens(x), 0);
}

/** Adjusted tokens one run (assignment) has booked so far. */
function runSpent(world: World, assignmentId: string): number {
  return world.sessions.where("assignmentId = ?", [assignmentId]).reduce((sum, x) => sum + sessionTokens(x), 0);
}

/** Runs due from the schedule's next run up to `until` (epoch ms), its end and `maxRuns` respected. A paused one fires none. */
function runsDueBy(s: Timing, now: Date, until: number): number {
  if (s.status === "ended" || !s.nextRunAt || s.paused || Date.parse(s.nextRunAt) > until) return 0;
  const end = s.endsAt ? Math.min(until, Date.parse(s.endsAt)) : until;
  return runsLeft({ ...s, endsAt: new Date(end).toISOString() }, now);
}

/**
 * A funded retainer's claim on the Bank (Mitchell, 2026-11-01): the runs due within the town's lookahead
 * (`retainerLookaheadHours`) × tokensPerRun, plus what each run already fired may still spend, never more than its
 * approved total leaves. Else 0. A recurring job can't claim forever ahead; the approval is the ceiling, not the claim.
 */
function retainerClaim(world: World, s: Schedule, now = new Date(), drawn?: number): number {
  if (s.retainer !== "funded" || s.status !== "active") return 0;
  const left = Math.max(0, (s.retainerTokens ?? 0) - (drawn ?? retainerDrawn(world, s.id)));
  const horizon = now.getTime() + world.town.get().retainerLookaheadHours * 3_600_000;
  let underWay = 0;
  for (const a of world.assignments.where("lane = 'retainer' AND sourceId = ? AND status IN ('pending', 'active')", [s.id])) {
    underWay += Math.max(0, s.tokensPerRun - runSpent(world, a.id));
  }
  return Math.min(left, s.tokensPerRun * runsDueBy(s, now, horizon) + underWay);
}

/**
 * Why a funded retainer's run, due now, can't run (null = it can): no credential serves its model (an observed limit,
 * availability.ts), or the overdraft walk covers none of its claim. Such a run is missed, not queued (fireSchedules).
 */
export function retainerMissReason(world: World, s: Schedule, at = new Date()): string | null {
  const b = world.buildings.get(s.buildingId);
  if (!b) return null;
  const cred = world.budget.credentialHold(b.id, at, { model: s.model ?? b.model });
  if (cred) return cred;
  const short = claimShort(world, s.id, at);
  if (short && short.shortTokens >= short.tokens) return `overdrafted: the Bank's usable balance doesn't cover this run (${fmt(short.shortTokens)} tokens short)`;
  return null;
}

/**
 * A retainer run missed (`retainerMissReason`): logged as `schedule.skipped` with `missed: true`, and on the first miss of a
 * streak its building's manager gets one message (later misses only count up on the schedule, `missedRuns`).
 */
export function missRetainerRun(world: World, s: Schedule, why: string, at = new Date()): void {
  world.events.append({ type: "schedule.skipped", buildingId: s.buildingId, text: `Schedule "${truncate(s.title, 80)}" missed its run: ${why}`, payload: { scheduleId: s.id, missed: true, reason: why, streak: s.missedRuns + 1 } });
  if (s.missedRuns > 0) return;
  const b = world.buildings.get(s.buildingId);
  const manager = b ? managerAgentOf(world, b) : undefined;
  if (!manager) return;
  sendMessage(world, {
    kind: "system", fromId: "system", fromKind: "system", toId: manager.id,
    body: `Your schedule "${s.title}" (${s.id}) missed its run at ${stamp(at.toISOString())}: ${why}. Runs that come due while this lasts are missed too (the schedule counts them); the first one that can run starts as usual. Nothing to do unless it keeps missing.`,
  });
}

/** The goal a schedule's retainer is paid under: its building's attachment. */
function retainerGoalOf(world: World, s: Pick<Schedule, "buildingId">): string {
  const b = world.buildings.get(s.buildingId);
  return b ? world.goalTree.attachmentOf(b) : s.buildingId;
}

export function scheduleView(world: World, s: Schedule, now = new Date()): ScheduleView {
  const drawnTokens = s.tokensPerRun > 0 || s.lane === "retainer" ? retainerDrawn(world, s.id) : 0;
  const left = runsLeft(s, now);
  return { ...s, runsLeft: left, askTokens: s.tokensPerRun * left, drawnTokens, claimTokens: retainerClaim(world, s, now, drawnTokens), buildingName: world.buildings.get(s.buildingId)?.name };
}

/** Retainers waiting on a human (asked) or on the manager (countered), oldest first: Town Hall in-tray rows and deck slides. */
export function pendingRetainers(world: World, now = new Date()): ScheduleView[] {
  return world.schedules.where("status = 'active' AND retainer IN ('asked', 'countered')", [], "ORDER BY updatedAt, rowid").map((s) => scheduleView(world, s, now));
}

/** Retainers asked of a human (the Town Hall badge; countered ones wait on the manager). */
export function askedRetainerCount(world: World): number {
  return world.schedules.count("status = 'active' AND retainer = 'asked'");
}

/** May this actor decide the retainer? A human with building.fund on the schedule's building, or the captain of its goal. */
export function canDecideRetainer(world: World, actor: Agent | undefined, s: Pick<Schedule, "buildingId">): boolean {
  if (!actor || holderOf(actor).kind !== "user") return false;
  return world.permissions.can(actor, "building.fund", s.buildingId) || world.goalTree.owns(actor, retainerGoalOf(world, s));
}

/** The in-tray line: "Workshop asks for a retainer: <title>, N tokens × M runs to <date> = T". */
export function retainerLine(world: World, v: ScheduleView): string {
  const to = v.endsAt ? ` to ${stamp(v.endsAt)}` : "";
  return `${world.buildings.get(v.buildingId)?.name ?? v.buildingId} asks for a retainer: ${v.title}, ${fmt(v.tokensPerRun)} tokens × ${v.runsLeft} run${v.runsLeft === 1 ? "" : "s"}${to} = ${fmt(v.askTokens)}`;
}

/** Ask (or ask again): the retainer goes to the Town Hall in-tray; the humans who can decide it hear in their inbox. */
export function askRetainer(world: World, s: Schedule, why: string, now = new Date()): void {
  const v = scheduleView(world, s, now);
  world.events.append({ type: "retainer.asked", buildingId: s.buildingId, text: `${retainerLine(world, v)} (${why})`, payload: { scheduleId: s.id, tokensPerRun: s.tokensPerRun, runsLeft: v.runsLeft, askTokens: v.askTokens } });
  for (const h of world.agents.where("kind = 'human' AND status != 'retired'")) {
    if (!canDecideRetainer(world, h, s)) continue;
    sendMessage(world, { kind: "system", fromId: "system", fromKind: "system", toId: h.id, body: `${retainerLine(world, v)}. Approve, counter or reject it in the Town Hall in-tray.` });
  }
  emitTownHall(world);
}

/** A schedule ended (cancelled, ran, past its end): its retainer ends and what it still claimed goes back to the Bank. */
export function releaseRetainer(world: World, s: Schedule, reason: string, at = new Date()): Schedule {
  if (s.retainer === "none" || s.retainer === "ended") return s;
  const released = s.retainer === "funded" ? Math.max(0, (s.retainerTokens ?? 0) - retainerDrawn(world, s.id)) : 0;
  const e = world.schedules.upsert({ ...s, retainer: "ended", updatedAt: at.toISOString() });
  world.events.append({ type: "retainer.released", buildingId: s.buildingId, text: `Retainer for "${truncate(s.title, 80)}" ended (${reason})${released ? `: ${fmt(released)} unspent tokens back to the Bank` : ""}`, payload: { scheduleId: s.id, reason, releasedTokens: released, was: s.retainer } });
  if (s.retainer === "asked" || s.retainer === "countered") emitTownHall(world);
  return e;
}

/**
 * A human decides an asked retainer: approve (funded at tokensPerRun × runs left; 409 when that would dip into the
 * operating reserve, the grants' rule), counter (a note, optionally the per-run amount and/or end date to give; the
 * manager answers by editing the schedule, which asks again) or reject (a note). The manager hears in their inbox.
 */
export function decideRetainer(world: World, actor: Agent, id: string, input: RetainerDecisionInput, now = new Date()): ScheduleView {
  const s = world.schedules.require(id, "schedule");
  if (!canDecideRetainer(world, actor, s)) throw forbidden("building.fund", "Only a human who can fund the schedule's building (or its goal's captain) decides a retainer.");
  if (s.status !== "active") throw new AppError("conflict", `Schedule "${s.title}" already ended.`);
  if (s.retainer !== "asked") throw new AppError("conflict", s.retainer === "countered" ? "This retainer was countered: it waits on the manager's edit." : `This retainer is ${s.retainer}, not asked.`);
  const by = holderOf(actor).id;
  const note = input.note.trim().slice(0, 2000);
  const drawn = retainerDrawn(world, s.id);
  const base = { retainerDecidedBy: by, retainerDecidedAt: now.toISOString(), updatedAt: now.toISOString() };
  let next: Schedule, said: string;
  if (input.action === "approve") {
    const ask = retainerAsk(s, now);
    if (ask <= 0) throw badRequest("This retainer asks for nothing (tokensPerRun 0 or no runs left): the manager sets tokensPerRun first.");
    const free = freeTokens(world, retainerGoalOf(world, s), now);
    if (free.reserveTokens > 0 && ask > free.freeTokens) {
      throw new AppError("conflict", `Approving ${fmt(ask)} tokens would dip into the operating reserve (${fmt(free.reserveTokens)} tokens kept for 1:1s, meetings and directed work): ${fmt(free.freeTokens)} tokens are free under its goal. Counter with a smaller per-run amount or an earlier end, add tokens to the Bank, or lower the reserve on the Bank page.`);
    }
    next = world.schedules.upsert({ ...s, ...base, retainer: "funded", retainerTokens: drawn + ask, retainerNote: note || null });
    said = `Approved: ${fmt(ask)} tokens (${fmt(s.tokensPerRun)} × ${runsLeft(s, now)} runs)`;
  } else if (input.action === "counter") {
    if (!note && !input.tokensPerRun && !input.until) throw badRequest("A counter says what to change: a note, a per-run amount (tokensPerRun) and/or an end date (until).");
    const wants = [input.tokensPerRun ? `${fmt(input.tokensPerRun)} tokens per run` : "", input.until ? `ending ${stamp(input.until)}` : ""].filter(Boolean).join(", ");
    next = world.schedules.upsert({ ...s, ...base, retainer: "countered", retainerNote: [wants && `Counter: ${wants}.`, note].filter(Boolean).join(" ") });
    said = `Countered${wants ? ` (${wants})` : ""}`;
  } else {
    next = world.schedules.upsert({ ...s, ...base, retainer: "rejected", retainerNote: note || null });
    said = "Rejected";
  }
  const deck = input.deckSlide ? { deckSlide: input.deckSlide } : {};
  world.events.append({ type: "retainer.decided", agentId: actor.id, buildingId: s.buildingId, text: `${said}: retainer for "${truncate(s.title, 80)}"${note ? `: ${truncate(note, 160)}` : ""}`, payload: { scheduleId: s.id, action: input.action, retainer: next.retainer, retainerTokens: next.retainerTokens, ...deck } });
  const manager = world.buildings.get(s.buildingId) ? managerAgentOf(world, world.buildings.get(s.buildingId)!) : undefined;
  if (manager) {
    const what = input.action === "approve" ? `approved the retainer for your schedule "${s.title}" (${s.id}): ${fmt(next.retainerTokens! - drawn)} tokens, ${fmt(s.tokensPerRun)} per run; its runs start`
      : input.action === "counter" ? `countered the retainer for your schedule "${s.title}" (${s.id}): ${next.retainerNote} Answer with \`schedule\` scheduleId ${s.id} (tokensPerRun and/or repeat), which asks again`
      : `rejected the retainer for your schedule "${s.title}" (${s.id})${note ? `: ${note}` : ""}. Its runs stay held; cancel it or change it to ask again`;
    sendMessage(world, { kind: "system", fromId: by, fromKind: "user", toId: manager.id, body: `${world.nameOf(actor.id)} ${what}.` });
  }
  emitTownHall(world);
  return scheduleView(world, next, now);
}

/**
 * The retainer on a schedule edit: raising tokensPerRun or adding runs (a later end, more times) asks again; answering a
 * counter or a rejection with any change asks again; lowering or shortening keeps a funded retainer funded.
 */
export function retainerAfterEdit(before: Schedule, after: Schedule, now = new Date()): { retainer: Schedule["retainer"]; reask: string | null } {
  if (after.tokensPerRun <= 0) return { retainer: before.retainer, reask: null };
  const raised = after.tokensPerRun > before.tokensPerRun;
  const longer = runsLeft(after, now) > runsLeft(before, now);
  const changed = raised || longer || after.tokensPerRun !== before.tokensPerRun || after.endsAt !== before.endsAt || after.maxRuns !== before.maxRuns;
  if (before.retainer === "funded") return raised || longer ? { retainer: "asked", reask: raised ? "per-run amount raised" : "more runs" } : { retainer: "funded", reask: null };
  if (before.retainer === "none" || before.retainer === "countered" || before.retainer === "rejected") {
    return changed || before.retainer === "none" ? { retainer: "asked", reask: before.retainer === "countered" ? "answering the counter" : before.retainer === "rejected" ? "asked again after a rejection" : "a retainer was set" } : { retainer: before.retainer, reask: null };
  }
  return { retainer: before.retainer, reask: changed && before.retainer === "asked" ? "the ask changed" : null };
}

/** Why the lane gate holds a retainer run now, or null: its retainer isn't funded, or one more run would pass the approved total. */
export function retainerHold(world: World, a: Pick<Assignment, "sourceId" | "id">): string | null {
  const s = a.sourceId ? world.schedules.get(a.sourceId) : undefined;
  if (!s) return "held: its schedule doesn't exist";
  if (s.retainer !== "funded") return `held: retainer not approved (${s.retainer})`;
  const drawn = retainerDrawn(world, s.id);
  const own = runSpent(world, a.id);
  // a run already under way (a parked continuation) only needs what is left of its own run
  const need = Math.max(0, s.tokensPerRun - own);
  if (drawn + need > (s.retainerTokens ?? 0)) return `held: retainer spent (${fmt(drawn)} of ${fmt(s.retainerTokens ?? 0)} tokens drawn; one more run needs ${fmt(need)})`;
  return null;
}

/** Retainer runs whose sessions reached tokensPerRun are asked once to wrap up (the explorer's ceiling, explore.ts). */
export function watchRetainerRuns(world: World): void {
  for (const a of world.assignments.where("status = 'active' AND lane = 'retainer'")) {
    const s = a.sourceId ? world.schedules.get(a.sourceId) : undefined;
    if (!s || s.tokensPerRun <= 0) continue;
    const spent = runSpent(world, a.id);
    if (spent < s.tokensPerRun) continue;
    if (world.db.prepare("SELECT 1 FROM events WHERE type = 'system' AND json_extract(payload, '$.retainerCeiling') = ? LIMIT 1").get(a.id)) continue;
    interruptNow(world, a.agentId, `This run of the schedule "${s.title}" has used ${fmt(spent)} of its ${fmt(s.tokensPerRun)}-token retainer per run. Don't start anything new: write your pages and \`submit_report\` now.`, "The schedule's retainer");
    world.events.append({ type: "system", agentId: a.agentId, buildingId: s.buildingId, text: `${world.nameOf(a.agentId)} reached the retainer per run of "${truncate(s.title, 80)}" and was asked to file`, payload: { retainerCeiling: a.id, scheduleId: s.id, spentTokens: spent, tokensPerRun: s.tokensPerRun } });
  }
}

/** Funded retainers' claims, town-wide: total and how many jobs (the Bank's "Retainers" line). */
export function retainerClaims(world: World, now = new Date()): { goalId: string; tokens: number; id: string; title: string; at: string }[] {
  const out: { goalId: string; tokens: number; id: string; title: string; at: string }[] = [];
  for (const s of world.schedules.where("status = 'active' AND retainer = 'funded'")) {
    const tokens = retainerClaim(world, s, now);
    if (tokens > 0) out.push({ goalId: retainerGoalOf(world, s), tokens, id: s.id, title: s.title, at: s.retainerDecidedAt ?? s.createdAt });
  }
  return out;
}

/** The Town Hall badge counts pending items: resend the building with its count. */
function emitTownHall(world: World): void {
  const th = world.buildings.first("kind = 'town-hall'");
  if (th) world.changes.emit({ type: "building", building: { ...th, intray: world.ops.intrayCount(th.id) } });
}
