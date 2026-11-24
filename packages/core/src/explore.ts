/**
 * Declarative exploration (docs/how-work-gets-done.md §3; build step 3, 1:1 mt_wql34b8gkl). On/off lives on the goal
 * (`explore`, inherited, free-tokens.ts `exploreRuleAt`); the chunk and the daily cap derive from town defaults and the
 * goal's desks (gr_bre43gflz9 step 1: `exploreChunkTokens`, desks × `exploreTokensPerDeskPerDay`, `exploreCapsOnPath`).
 * The runtime tick, not a manager, starts explorers: for each goal-directed building whose rule is on, with a free desk
 * and nothing else forkable queued, no explorer of its own open, none started in the last EXPLORE_MIN_GAP_MS, no open
 * proposal of its own and free tokens ≥ the chunk (under the cap), it reserves one chunk (bank_reservations) and queues one
 * exploration assignment on the building queue. The reservation is a claim on free tokens; its sessions' spend shrinks
 * it, and it closes (unspent returns) once its assignment is no longer pending or active.
 */
import { isGone } from "@muster-town/schema";
import type { Assignment, BankReservation, Building } from "@muster-town/schema";
import { buildingQueue, createAssignment, forkableManagerOf } from "./domain.ts";
import { jobOf, refreshJob } from "./jobs.ts";
import { sessionView } from "./bank.ts";
import { exploreCapsOnPath, exploreRuleAt, exploreSpentToday, freeTokensAll } from "./free-tokens.ts";
import { freeDesks, goalDeskBound, goalDesksHeld } from "./forks.ts";
import { ensureJournal, ensureJournals, JOURNAL_TITLE } from "./exploration-journal.ts";
import { laneGated } from "./lanes.ts";
import { interruptNow } from "./wakes.ts";
import { stamp } from "./time.ts";
import { newId, truncate } from "./util.ts";
import type { World } from "./world.ts";

/** At most one new explorer per building per this long (docs/how-work-gets-done.md §3). */
export const EXPLORE_MIN_GAP_MS = 30 * 60_000;
/** The backoff's ceiling: after n empty explorations in a row the next waits EXPLORE_MIN_GAP_MS × 2^n, at most this (gr_6id9g7u9cj). */
export const EXPLORE_MAX_GAP_MS = 24 * 60 * 60_000;
/** An explorer whose session has used this share of its chunk is asked once to wrap up and file. */
export const EXPLORE_CEILING_SHARE = 0.9;

/** Adjusted tokens the sessions of an assignment have booked so far (running sessions included). */
export function assignmentSpent(world: World, assignmentId: string): number {
  return world.sessions.where("assignmentId = ?", [assignmentId]).reduce((s, x) => s + sessionView(x).adjustedOutputTokens, 0);
}

/** What an open reservation still claims: its tokens less what its sessions have spent (they draw on it first). */
export function reservationLeft(world: World, r: BankReservation): number {
  if (r.closedAt) return 0;
  return Math.max(0, r.tokens - (r.assignmentId ? assignmentSpent(world, r.assignmentId) : 0));
}

/** The wait after `empty` explorations in a row found nothing: 30 min × 2^empty, at most 24 h (gr_6id9g7u9cj step 1). */
export function exploreGapMs(empty: number): number {
  return Math.min(EXPLORE_MAX_GAP_MS, EXPLORE_MIN_GAP_MS * 2 ** Math.max(0, empty));
}

/**
 * The latest time after `since` that something happened in a building that makes a new look worth it, resetting the
 * explore backoff: a grant proposal it filed, non-exploration work queued on it, a human's decision on one of its grants,
 * or a human's tell to its manager, flag to it or line in one of its meetings (a 1:1 included). Null: nothing after `since`.
 */
export function exploreResetAt(world: World, buildingId: string, since: string): string | null {
  const manager = world.buildings.get(buildingId)?.managerAgentId ?? null;
  const at = (sql: string, ...args: unknown[]) => (world.db.prepare(sql).get(...args) as { at: string | null } | undefined)?.at ?? null;
  const times = [
    at("SELECT MAX(ts) AS at FROM events WHERE type = 'grant.proposed' AND buildingId = ? AND ts > ?", buildingId, since),
    at("SELECT MAX(createdAt) AS at FROM assignments WHERE buildingId = ? AND lane IS NOT 'exploration' AND createdAt > ?", buildingId, since),
    at("SELECT MAX(createdAt) AS at FROM docs WHERE type = 'flag' AND buildingId = ? AND createdAt > ?", buildingId, since),
    manager ? at("SELECT MAX(createdAt) AS at FROM messages WHERE toId = ? AND fromKind = 'user' AND kind = 'tell' AND createdAt > ?", manager, since) : null,
    // a human's decision on one of its grants (fund, counter, reject, continue, adjust, cut…: any history entry by a user but the proposal)
    at(`SELECT MAX(json_extract(h.value, '$.at')) AS at FROM grants g, json_each(g.history) h WHERE g.buildingId = ? AND g.updatedAt > ?
      AND json_extract(h.value, '$.byKind') = 'user' AND json_extract(h.value, '$.action') != 'propose' AND json_extract(h.value, '$.at') > ?`, buildingId, since, since),
    at(`SELECT MAX(json_extract(u.value, '$.at')) AS at FROM meetings m, json_each(m.transcript) u WHERE m.buildingId = ?
      AND json_extract(u.value, '$.speakerKind') = 'user' AND json_extract(u.value, '$.at') > ?`, buildingId, since),
  ];
  return times.reduce<string | null>((a, t) => (t && (!a || t > a) ? t : a), null);
}

/**
 * How many of the building's latest explorations in a row closed with nothing to propose (their chunk job closed as
 * "nothing-found", answer.ts close-job), counting back from the newest and stopping at the last reset (`exploreResetAt`).
 */
export function emptyExplorations(world: World, buildingId: string): number {
  const closedAs = world.db.prepare("SELECT closedAs FROM jobs WHERE id = ?");
  const streak: string[] = [];
  for (const r of world.bankReservations.where("buildingId = ? AND closedAt IS NOT NULL", [buildingId], "ORDER BY openedAt DESC")) {
    const a = r.assignmentId ? world.assignments.get(r.assignmentId) : undefined;
    if (!a || (closedAs.get(jobOf(a).id) as { closedAs: string | null } | undefined)?.closedAs !== "nothing-found") break;
    streak.push(r.openedAt);
  }
  if (!streak.length) return 0;
  const reset = exploreResetAt(world, buildingId, streak.at(-1)!);
  return reset ? streak.filter((t) => t > reset).length : streak.length;
}

/** Why the tick would not start an explorer in this building now, or null when it would (the Queue tab shows it). */
export function exploreBlock(world: World, b: Building, now = new Date(), free = freeTokensAll(world, now)): string | null {
  if (!laneGated(b)) return "the Town Hall never explores";
  const goalId = world.goalTree.attachmentOf(b);
  const rule = exploreRuleAt(world, goalId);
  if (!rule.on) return rule.onFrom ? `exploration is off (set on goal ${rule.onFrom})` : "exploration is off for the town (town defaults)";
  const manager = forkableManagerOf(world, b);
  if (!manager || isGone(manager)) return "no manager to fork";
  if (world.budget.remaining(b.id) <= 0) return "the building's budget is spent";
  if (freeDesks(world, b) <= 0) {
    const bound = goalDeskBound(world, b);
    return bound && bound.slack <= 0 ? goalDesksHeld(bound).replace(/^held: /, "") : "no free desk";
  }
  if (world.bankReservations.first("buildingId = ? AND closedAt IS NULL", [b.id])) return "an explorer of this building is still open";
  if (buildingQueue(world, b.id).some((a) => !a.waitFor && !a.offered && world.budget.holdReason(a) === null)) return "other work is queued for its desks";
  const last = world.bankReservations.first("buildingId = ?", [b.id], "ORDER BY openedAt DESC");
  if (last) {
    const empty = emptyExplorations(world, b.id);
    const gap = exploreGapMs(empty);
    const next = Date.parse(last.openedAt) + gap;
    if (now.getTime() < next) {
      return empty === 0
        ? `the last explorer started under ${EXPLORE_MIN_GAP_MS / 60_000} min ago`
        : `the last ${empty === 1 ? "explorer" : `${empty} explorers`} found nothing; next may start at ${stamp(next)}`;
    }
  }
  if (world.grants.first("buildingId = ? AND status IN ('proposed', 'countered')", [b.id])) return "a proposal of this building is open and undecided";
  const f = free.get(goalId)?.freeTokens ?? 0;
  if (f < rule.chunkTokens) return `free tokens under the goal (${f.toLocaleString("en-US")}) are less than one chunk (${rule.chunkTokens.toLocaleString("en-US")})`;
  // every cap on the path holds (the smallest binds, but a looser one above may already be used up by other subtrees). A
  // cap derives from desks (gr_bre43gflz9): one smaller than a chunk still lets one explorer a day start under that goal
  // (a 2-desk goal would otherwise never explore); a cap of 0 (no desks, or the per-desk default set to 0) lets none.
  for (const cap of exploreCapsOnPath(world, goalId)) {
    const room = cap.tokensPerDay === 0 ? 0 : Math.max(cap.tokensPerDay, rule.chunkTokens);
    if (exploreSpentToday(world, cap.goalId, now) + rule.chunkTokens > room) return `the exploration cap on goal ${cap.goalId} (${cap.tokensPerDay.toLocaleString("en-US")} a day from its desks) would be passed today`;
  }
  return null;
}

/** Open one reservation and queue its explorer (one building, its rule already checked by `exploreBlock`). */
function startExplorer(world: World, b: Building, now: Date): Assignment {
  const goalId = world.goalTree.attachmentOf(b);
  const goal = world.goals.get(goalId);
  const rule = exploreRuleAt(world, goalId);
  const manager = forkableManagerOf(world, b)!;
  const goalText = truncate(goal?.text ?? b.name, 200);
  return world.transaction(() => {
    const r = world.bankReservations.upsert({ id: newId("rs"), goalId, buildingId: b.id, assignmentId: null, tokens: rule.chunkTokens, openedAt: now.toISOString(), closedAt: null, spentTokens: null });
    const a = createAssignment(world, {
      agentId: manager.id, buildingId: b.id, createdBy: { kind: "system", id: r.id },
      title: `Explore under "${truncate(goal?.text ?? b.name, 70)}"`,
      description: `The town's explore tick reserved ${rule.chunkTokens.toLocaleString("en-US")} tokens (${r.id}) for this session because ${b.name} had a free desk and free tokens under its goal ${goalId}. Pick ONE direction under the goal, investigate it this session (the live town, the code, the web), and end with ONE grant proposal (\`propose_grant\`: goalId in your subtree, title (3-8 words), objective, approach, stopCondition, 2-4 keyResults with howToCheck and due, 1-5 steps: one session each, each sized S, M or L, funding queues step 1; the ask is the sum of the sizes), or, if nothing is worth a grant, a short report on why. Before you propose anything, read docs/how-work-gets-done.md §7 (the Bank: one balance, earmarks, free tokens: what your ask is paid from) and §8 (exploration caps: they combine as the smallest on the path to the root); size your plan to the free tokens under the goal. Stay within the chunk: you are asked to wrap up at ${Math.round(EXPLORE_CEILING_SHARE * 100)}% of it.\n\nFirst read the building's "${JOURNAL_TITLE}" (a topic page, in full in your first message): one line per earlier exploration here, newest first, with the direction it took and what came of it. Read the latest lines first. Do not re-explore a direction the journal rules out unless what it waited on has moved (say what moved). In your report, name the journal lines you built on (their date and report id), or say that none applied.`,
      lane: { lane: "exploration", gap: `Explore under: ${goalText}`.slice(0, 300) }, reservationId: r.id,
    });
    world.bankReservations.upsert({ ...r, assignmentId: a.id });
    // gr_6id9g7u9cj step 2: the building's exploration journal opens in full in the explorer's first message
    const journal = ensureJournal(world, b, now);
    if (journal) world.assignments.patch(a.id, { pages: [journal.id] });
    world.events.append({
      type: "exploration.reserved", agentId: manager.id, buildingId: b.id,
      text: `${b.name}: the explore tick reserved ${rule.chunkTokens.toLocaleString("en-US")} tokens and queued an explorer under "${truncate(goal?.text ?? goalId, 80)}"`,
      payload: { reservationId: r.id, assignmentId: a.id, goalId, tokens: rule.chunkTokens },
    });
    return a;
  });
}

/** Close the open reservations whose assignment is no longer pending or active: what its sessions spent is booked, the rest returns. */
function closeReservations(world: World, now: Date): BankReservation[] {
  const closed: BankReservation[] = [];
  for (const r of world.bankReservations.where("closedAt IS NULL")) {
    const a = r.assignmentId ? world.assignments.get(r.assignmentId) : undefined;
    if (a && (a.status === "pending" || a.status === "active")) continue;
    // a session that started and ended between two ticks still gets its `exploration.started`
    if (a && world.sessions.count("assignmentId = ?", [a.id])) markStarted(world, r, a);
    const spent = r.assignmentId ? assignmentSpent(world, r.assignmentId) : 0;
    const c = world.bankReservations.upsert({ ...r, closedAt: now.toISOString(), spentTokens: spent });
    // plan dc_uwx045472m step 4: the explorer's chunk job closes with its reservation (done with a proposal, else nothing found)
    if (a) refreshJob(world, jobOf(a).id);
    world.events.append({
      type: "exploration.closed", buildingId: r.buildingId,
      text: `Explorer reservation ${r.id} closed: ${spent.toLocaleString("en-US")} of ${r.tokens.toLocaleString("en-US")} tokens spent, ${Math.max(0, r.tokens - spent).toLocaleString("en-US")} returned to free tokens`,
      payload: { reservationId: r.id, assignmentId: r.assignmentId, goalId: r.goalId, tokens: r.tokens, spentTokens: spent, status: a?.status ?? null },
    });
    closed.push(c);
  }
  return closed;
}

/** `exploration.started`, once per reservation. */
function markStarted(world: World, r: BankReservation, a: Assignment): void {
  if (world.db.prepare("SELECT 1 FROM events WHERE type = 'exploration.started' AND json_extract(payload, '$.reservationId') = ? LIMIT 1").get(r.id)) return;
  world.events.append({ type: "exploration.started", agentId: a.agentId, buildingId: r.buildingId, text: `${world.nameOf(a.agentId)} started exploring (${r.tokens.toLocaleString("en-US")}-token chunk ${r.id})`, payload: { reservationId: r.id, assignmentId: a.id, goalId: r.goalId } });
}

/** `exploration.started` once per reservation (its assignment went active); the wrap-up ask once its session nears the chunk. */
function watchExplorers(world: World): void {
  for (const r of world.bankReservations.where("closedAt IS NULL AND assignmentId IS NOT NULL")) {
    const a = world.assignments.get(r.assignmentId!);
    if (a?.status !== "active") continue;
    markStarted(world, r, a);
    const spent = assignmentSpent(world, a.id);
    if (spent >= EXPLORE_CEILING_SHARE * r.tokens) {
      askToFileOnce(world, "exploreCeiling", r.id, a.agentId, `You have used ${spent.toLocaleString("en-US")} of the ${r.tokens.toLocaleString("en-US")} tokens reserved for this exploration. Don't start anything new: file your grant proposal now (\`propose_grant\`), or if nothing is worth a grant say why, then \`submit_report\`.`, "The explore tick",
        { buildingId: r.buildingId, text: `${world.nameOf(a.agentId)} reached ${Math.round(EXPLORE_CEILING_SHARE * 100)}% of its exploration chunk and was asked to file`, payload: { assignmentId: a.id, spentTokens: spent, tokens: r.tokens } });
    }
  }
}

/**
 * Interrupt a running agent once with a wrap-up ask, keyed by a `system` event whose payload carries `key` = `id` (the
 * explorer's 90%-of-chunk ask, the session circuit breaker's 90% one). False when that event already exists.
 */
export function askToFileOnce(world: World, key: string, id: string, agentId: string, ask: string, from: string, event: { buildingId: string | null; text: string; payload: Record<string, unknown> }): boolean {
  if (world.db.prepare(`SELECT 1 FROM events WHERE type = 'system' AND json_extract(payload, '$.${key}') = ? LIMIT 1`).get(id)) return false;
  interruptNow(world, agentId, ask, from);
  world.events.append({ type: "system", agentId, buildingId: event.buildingId, text: event.text, payload: { [key]: id, ...event.payload } });
  return true;
}

/** Times one named step of a tick (ms, summed per name): the runtime passes one so health `load.tick` can split a phase. */
export type SubTimer = <T>(name: string, fn: () => T) => T;
const untimed: SubTimer = (_name, fn) => fn();

/**
 * The order the tick visits buildings: least recently explored first (its last reservation's openedAt), never-explored
 * first of all, ties by rowid. A tight cap then rotates across buildings day by day instead of refusing the same last
 * ones every day (finding dc_q48pbvg0td: Outreach and UI/UX got 0 while the gl_town cap filled on the first four).
 */
export function exploreOrder(world: World): Building[] {
  const last = new Map((world.db.prepare("SELECT buildingId, MAX(openedAt) AS at FROM bank_reservations GROUP BY buildingId").all() as { buildingId: string; at: string }[]).map((r) => [r.buildingId, r.at]));
  return world.buildings.all()
    .map((b, i) => ({ b, i, at: last.get(b.id) ?? "" }))
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i))
    .map((x) => x.b);
}

/** The runtime tick's explore step: close finished reservations, watch running explorers, then start at most one explorer per building, least recently explored first. */
export function exploreTick(world: World, now = new Date(), time: SubTimer = untimed): { started: Assignment[]; closed: BankReservation[] } {
  const closed = time("explore.close", () => closeReservations(world, now));
  time("explore.journal", () => ensureJournals(world, now));
  time("explore.watch", () => watchExplorers(world));
  const started: Assignment[] = [];
  let free = time("explore.freeTokensAll", () => freeTokensAll(world, now));
  for (const b of exploreOrder(world)) {
    if (time("explore.block", () => exploreBlock(world, b, now, free)) !== null) continue;
    started.push(time("explore.start", () => startExplorer(world, b, now)));
    free = time("explore.freeTokensAll", () => freeTokensAll(world, now)); // the new reservation claims its chunk
  }
  return { started, closed };
}
