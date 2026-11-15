/**
 * Queue health (grant gr_pdja05z2f1 step 2): how much of a human's time each ask costs, how many clarifying lines it
 * draws, and how often grants stop at gates beside how much of their budget they burn. `queueHealth` is pure over plain
 * arrays (no World); `queueHealthInput` in measures.ts reads them from the db. `GET /api/health` carries the result as
 * `legible.queue`; the Secretary's rank run reads it as its "Queue health" block (secretary.ts `queueHealthBlock`).
 *
 * Per ask decided by a human in the window (`decidedAt`, or a `retire` history line whose `by` is a user id):
 * - decision time: created to that decision;
 * - time on card: the union of the decider's screen views on the ask or on its target, each capped (VIEW_CAP_MS, already
 *   applied to `ms`) and clipped to [created, decision]. A union, not a sum: two 1:1s open on one card count once, so
 *   time on card never exceeds decision time;
 * - first seen to decision: from the first such view's (clipped) start;
 * - clarifying lines: the decider's own 1:1 lines said inside one of those views (same meeting) and before the decision,
 *   and how many end in a question mark.
 * Card time, first seen and lines are read over the asks a human had on screen at least once (an ask decided with no
 * view in the queue says nothing about time on card), so each median carries its own sample.
 */
import type { AskType } from "@muster-town/schema";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Read over this many days, like the other legible measures. */
export const QUEUE_WINDOW_DAYS = 14;
/** Assumption for Mitchell to tune: fewer gates than this per grant funded in the window is "few gates". */
export const FEW_GATES_PER_GRANT = 0.5;
/** Assumption for Mitchell to tune: more than this share of granted tokens spent is "high budget use". */
export const HIGH_BUDGET_USED = 0.85;

/** Focus kinds that show an ask's target rather than the ask itself: a view of one counts for the live ask on that target. */
const TARGET_KINDS = new Set(["grant", "retainer", "captain", "access", "doc"]);

export interface QueueAsk {
  id: string; type: AskType; targetId: string | null; status: string;
  createdAt: string; decidedAt: string | null; decidedBy: string | null;
  history: { at: string; action: string; by: string }[];
}
export interface QueueView { userId: string; kind: string; itemId: string; meetingId: string; openedAt: string; /** time on screen, already capped */ ms: number }
export interface QueueLine { meetingId: string; userId: string; at: string; text: string }
export interface QueueGrant { id: string; status: string; grantTokens: number | null; spent: number; history: { at: string; action: string }[] }
/** Adjust asks (a money ask on a grant offering "adjust": the hold's card) by grant and time. */
export interface QueueAdjustAsk { grantId: string; createdAt: string }
export interface QueueHealthInput { asks: QueueAsk[]; views: QueueView[]; lines: QueueLine[]; grants: QueueGrant[]; adjustAsks: QueueAdjustAsk[] }

interface Median { median: number | null; sample: number }
export interface QueueTypeRow {
  /** asks of this type a human decided in the window, and the median hours to decide them */
  decisionHours: Median;
  /** of those, the ones seen in the queue: median minutes on card */
  minutesOnCard: Median;
  /** median minutes from first seen to decision */
  firstSeenMinutes: Median;
  /** median clarifying lines said while the card was open, and median of those ending in "?" */
  lines: Median;
  questions: Median;
}
export interface QueueHealth {
  at: string; windowDays: number;
  byType: Partial<Record<AskType, QueueTypeRow>>;
  gates: {
    /** grants funded in the window, the gates they met (checkpoint holds, or adjust asks where more), gates ÷ funded */
    funded: number; gates: number; perGrant: number | null;
    /** grants at a gate now ÷ grants live now (funded or at a gate): today's hold share */
    heldNow: number; live: number; holdShareToday: number | null;
    /** sum spent ÷ sum granted over the grants funded in the window; null with nothing granted */
    granted: number; spent: number; budgetUsed: number | null;
    /** few gates with high budget use: work is running past review */
    warning: boolean;
    thresholds: { fewGatesPerGrant: number; highBudgetUsed: number };
  };
}

const t = (iso: string) => Date.parse(iso);
const isHuman = (by: string | null | undefined) => !!by && by.startsWith("us_");
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
function median(xs: number[]): Median {
  if (!xs.length) return { median: null, sample: 0 };
  const r = [...xs].sort((a, b) => a - b), n = r.length;
  return { median: round(n % 2 ? r[(n - 1) / 2]! : (r[n / 2 - 1]! + r[n / 2]!) / 2), sample: n };
}

/** When and by whom a human decided the ask (a decide, or a retire by the deciding human); null when no human did. */
function humanDecision(a: QueueAsk): { at: number; by: string } | null {
  if (a.status === "decided" && a.decidedAt) return { at: t(a.decidedAt), by: a.decidedBy ?? "" };
  if (a.status === "retired") {
    const r = [...a.history].reverse().find((h) => h.action === "retire");
    if (r && isHuman(r.by)) return { at: t(r.at), by: r.by };
  }
  return null;
}

/** The decider's views on `a` (or its target), clipped to [created, decision], as merged disjoint intervals with their meeting. */
function cardIntervals(a: QueueAsk, by: string, decidedAt: number, views: QueueView[]): { from: number; to: number; meetingId: string }[] {
  const from0 = t(a.createdAt);
  const own = views.filter((v) => (!isHuman(by) || v.userId === by) && (
    (v.kind === "ask" && v.itemId === a.id) || (TARGET_KINDS.has(v.kind) && a.targetId !== null && v.itemId === a.targetId)));
  return own.map((v) => ({ from: Math.max(from0, t(v.openedAt)), to: Math.min(decidedAt, t(v.openedAt) + Math.max(0, v.ms)), meetingId: v.meetingId }))
    .filter((i) => i.to > i.from);
}
function unionMs(xs: { from: number; to: number }[]): number {
  const s = [...xs].sort((a, b) => a.from - b.from);
  let total = 0, end = -Infinity;
  for (const i of s) {
    if (i.to <= end) continue;
    total += i.to - Math.max(i.from, end);
    end = i.to;
  }
  return total;
}

/** One ask's numbers (exported for the property tests). Null when no human decided it. */
export function askQueueTime(a: QueueAsk, views: QueueView[], lines: QueueLine[]): { decisionMs: number; cardMs: number; firstSeenMs: number | null; lines: number; questions: number } | null {
  const d = humanDecision(a);
  if (!d) return null;
  const iv = cardIntervals(a, d.by, d.at, views);
  const said = lines.filter((l) => (!isHuman(d.by) || l.userId === d.by) && iv.some((i) => i.meetingId === l.meetingId && t(l.at) >= i.from && t(l.at) <= i.to));
  return {
    decisionMs: Math.max(0, d.at - t(a.createdAt)),
    cardMs: unionMs(iv),
    firstSeenMs: iv.length ? d.at - Math.min(...iv.map((i) => i.from)) : null,
    lines: said.length,
    questions: said.filter((l) => l.text.trim().endsWith("?")).length,
  };
}

/** The queue-health measures at `now` over QUEUE_WINDOW_DAYS. Pure: an empty town gives nulls, not zeros. */
export function queueHealth(input: QueueHealthInput, now: Date): QueueHealth {
  const end = now.getTime(), since = end - QUEUE_WINDOW_DAYS * DAY;
  const per = new Map<AskType, { dec: number[]; card: number[]; first: number[]; lines: number[]; q: number[] }>();
  for (const a of input.asks) {
    const d = humanDecision(a);
    if (!d || d.at < since || d.at > end) continue;
    const r = askQueueTime(a, input.views, input.lines)!;
    const row = per.get(a.type) ?? { dec: [], card: [], first: [], lines: [], q: [] };
    row.dec.push(r.decisionMs / HOUR);
    if (r.firstSeenMs !== null) { row.card.push(r.cardMs / MINUTE); row.first.push(r.firstSeenMs / MINUTE); row.lines.push(r.lines); row.q.push(r.questions); }
    per.set(a.type, row);
  }
  const byType: QueueHealth["byType"] = {};
  for (const [type, r] of [...per].sort(([x], [y]) => x.localeCompare(y))) {
    byType[type] = { decisionHours: median(r.dec), minutesOnCard: median(r.card), firstSeenMinutes: median(r.first), lines: median(r.lines), questions: median(r.q) };
  }

  const inWindow = (iso: string) => t(iso) >= since && t(iso) <= end;
  const funded = input.grants.filter((g) => g.history.some((h) => h.action === "fund" && inWindow(h.at)));
  let gates = 0;
  for (const g of funded) {
    const holds = g.history.filter((h) => h.action === "checkpoint" && inWindow(h.at)).length;
    const adjusts = input.adjustAsks.filter((x) => x.grantId === g.id && inWindow(x.createdAt)).length;
    gates += Math.max(holds, adjusts); // a hold usually files its adjust ask: count the gate once
  }
  const granted = funded.reduce((n, g) => n + Math.max(0, g.grantTokens ?? 0), 0);
  const spent = funded.reduce((n, g) => n + Math.max(0, g.spent), 0);
  const live = input.grants.filter((g) => g.status === "funded" || g.status === "checkpoint");
  const heldNow = live.filter((g) => g.status === "checkpoint").length;
  const perGrant = funded.length ? round(gates / funded.length) : null;
  const budgetUsed = granted ? round(spent / granted) : null;
  return {
    at: now.toISOString(), windowDays: QUEUE_WINDOW_DAYS, byType,
    gates: {
      funded: funded.length, gates, perGrant,
      heldNow, live: live.length, holdShareToday: live.length ? round(heldNow / live.length) : null,
      granted, spent, budgetUsed,
      warning: perGrant !== null && budgetUsed !== null && perGrant < FEW_GATES_PER_GRANT && budgetUsed > HIGH_BUDGET_USED,
      thresholds: { fewGatesPerGrant: FEW_GATES_PER_GRANT, highBudgetUsed: HIGH_BUDGET_USED },
    },
  };
}

/** The Secretary's rank-run brief block: the same numbers as `legible.queue`, in plain lines. */
export function queueHealthBlock(q: QueueHealth): string {
  const n = (m: Median, unit: string) => (m.median === null ? "none" : `${m.median}${unit ? ` ${unit}` : ""} (${m.sample})`);
  const types = Object.entries(q.byType) as [AskType, QueueTypeRow][];
  const pct = (x: number | null) => (x === null ? "none" : `${Math.round(x * 100)}%`);
  const g = q.gates;
  return [
    `## Queue health, last ${q.windowDays} days (computed ${q.at.slice(0, 16)}Z; medians with their sample)`,
    ...(types.length ? types.map(([type, r]) => `- ${type}: decided in ${n(r.decisionHours, "h")}; on card ${n(r.minutesOnCard, "min")}; first seen to decision ${n(r.firstSeenMinutes, "min")}; clarifying lines ${n(r.lines, "")}, questions ${n(r.questions, "")}.`) : ["- No ask decided by a human in the window."]),
    `- Gates per funded grant: ${g.perGrant ?? "none"} (${g.gates} gates, ${g.funded} grants funded). Hold share today: ${pct(g.holdShareToday)} (${g.heldNow} of ${g.live} live grants at a gate).`,
    `- Budget used: ${pct(g.budgetUsed)} (${g.spent.toLocaleString("en-US")} of ${g.granted.toLocaleString("en-US")} tokens granted to grants funded in the window).`,
    ...(g.warning ? [`- WARNING: few gates with high budget use: work is running past review (under ${g.thresholds.fewGatesPerGrant} gates per grant, over ${Math.round(g.thresholds.highBudgetUsed * 100)}% used).`] : []),
  ].join("\n");
}
