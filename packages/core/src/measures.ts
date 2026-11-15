/**
 * The legible-delegation measures (docs/legible-delegation.md §9, §7.4; build step 9): the counts the town keeps so the
 * design can be checked against the drudgery it set out to remove, and the Planner's calibration run reads (planner.ts).
 * Pure reads over asks, seen, grants, assignments, sessions and events: nothing is written. `GET /api/health` and
 * `GET /api/town` carry them as `legible`.
 */
import type { Ask, AskType, StepCalibration, StepSize } from "@muster-town/schema";
import { stepCalibration } from "./grant-estimate.ts";
import { queueHealth, type QueueHealth, type QueueHealthInput } from "./queue-health.ts";
import { screenViews } from "./screen-views.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

/** Time to decision, top-ups, hold share and sessions per step are read over this many days. */
const MEASURE_WINDOW_DAYS = 14;
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** The §9 counts at one moment. A ratio is null when its denominator is 0. */
export interface LegibleMeasures {
  at: string;
  windowDays: number;
  /** live asks (open or deferred) */
  openAsks: number;
  /** duplication: live asks ÷ distinct targets (targetKind + targetId; a question in words is its own target), and the folds (second asks refused at their door) */
  asksPerTarget: { targets: number; ratio: number | null; folds: number };
  /** hours since the oldest live ask was filed; null with none */
  oldestOpenAskHours: number | null;
  /** per ask type, the asks decided in the window: median hours from create to decide */
  timeToDecision: Partial<Record<AskType, { medianHours: number; sample: number }>>;
  /** asks retired in the window, and how many of them no human had opened (no `seen` row) */
  retiredBeforeRead: { retired: number; unread: number };
  /** money asks filed at a hold (a checkpoint ask) or from `grant.top-up-needed` in the window ÷ grants funded in the window */
  topUpsPerFundedGrant: { topUps: number; funded: number; ratio: number | null };
  /** grants closed in the window that held at least once before closing ÷ grants closed in the window */
  holdShare: { held: number; closed: number; share: number | null };
  /** per size, the median spent ÷ the size's table value over the steps completed in the calibration window (stepCalibration, 30 days), with the sample */
  spentOverSize: Record<StepSize, { ratio: number | null; sample: number }>;
  /** the median number of sessions a plan step completed in the window took (its parked continuations included) */
  sessionsPerStep: { median: number | null; steps: number };
  /**
   * cards filed in the window, those filed with style warnings (a `lint` history line) and those the Secretary rewrote
   * (`rewritten`), with the rewrite rate overall, per building (the Town Hall's for none) and per ask type (1:1
   * mt_t65exni4et decision 9). A rising rate says the manager's Asks paragraph, the prompt that writes cards, is wrong.
   */
  cardRewrites: RewriteCount & { withWarnings: number; byBuilding: Record<string, RewriteCount>; byType: Partial<Record<AskType, RewriteCount>> };
  /** grants at a gate now: how many, the tokens they hold (grantTokens − spent, at least 0) and the oldest hold's age in hours */
  heldAtGates: { grants: number; tokens: number; oldestHours: number | null };
  /** queue health step 1 (gr_pdja05z2f1): screen views opened in the window (screen-views.ts), the humans behind them, and how many are still open */
  screenViews: { views: number; users: number; open: number };
  /** queue health step 2 (gr_pdja05z2f1): the human's time and clarifying lines per ask type, gates beside budget used (queue-health.ts) */
  queue: QueueHealth;
}

interface RewriteCount { filed: number; rewritten: number; rate: number | null }

/** A card filed with style warnings: a `lint` line in its history before any rewrite (a rewrite's own lint is the Secretary's). */
const filedWithWarnings = (a: Ask) => { const r = a.history.findIndex((h) => h.action === "rewritten"); const l = a.history.findIndex((h) => h.action === "lint"); return l >= 0 && (r < 0 || l < r); };

/** Decision 9: of the cards filed since `since`, how many carried style warnings and how many the Secretary rewrote. */
function cardRewrites(asks: Ask[]): LegibleMeasures["cardRewrites"] {
  const count = (xs: Ask[]): RewriteCount => { const rewritten = xs.filter((a) => a.history.some((h) => h.action === "rewritten")).length; return { filed: xs.length, rewritten, rate: ratio(rewritten, xs.length) }; };
  const group = <K extends string>(key: (a: Ask) => K) => {
    const by = new Map<K, Ask[]>();
    for (const a of asks) by.set(key(a), [...(by.get(key(a)) ?? []), a]);
    return Object.fromEntries([...by].sort(([x], [y]) => x.localeCompare(y)).map(([k, xs]) => [k, count(xs)])) as Record<K, RewriteCount>;
  };
  return {
    ...count(asks), withWarnings: asks.filter(filedWithWarnings).length,
    byBuilding: group((a) => a.buildingId ?? TOWN_HALL_ID), byType: group((a) => a.type),
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const r = [...xs].sort((a, b) => a - b);
  const m = r.length % 2 ? r[(r.length - 1) / 2]! : (r[r.length / 2 - 1]! + r[r.length / 2]!) / 2;
  return Math.round(m * 100) / 100;
}
const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : null);
const hours = (from: string, to: number) => Math.round(((to - Date.parse(from)) / HOUR) * 10) / 10;

/** The §9 measures of `world` at `now`. Read-only. */
export function legibleMeasures(world: World, now: Date = new Date(), cal: StepCalibration = stepCalibration(world, now)): LegibleMeasures {
  const t = now.getTime();
  const since = new Date(t - MEASURE_WINDOW_DAYS * DAY).toISOString();

  // ---- asks ----
  const live = world.asks.where("status IN ('open', 'deferred')", [], "ORDER BY createdAt, rowid");
  const targets = new Set(live.map((a) => (a.targetKind && a.targetId ? `${a.targetKind}:${a.targetId}` : `ask:${a.id}`)));
  // a second ask refused at the door is an `ask-refused` entry on the live card's thread (1:1 mt_dwsxo7oms8); older folds are history entries
  const liveIds = new Set(live.map((a) => a.id));
  const refused = (world.db.prepare("SELECT json_extract(moved, '$.askId') AS askId FROM entries WHERE json_extract(moved, '$.kind') = 'ask-refused'").all() as { askId: string }[]).filter((r) => liveIds.has(r.askId)).length;
  const folds = refused + live.reduce((n, a) => n + a.history.filter((h) => h.action === "fold").length, 0);
  const byType = new Map<AskType, number[]>();
  for (const a of world.asks.where("status = 'decided' AND decidedAt >= ?", [since])) {
    byType.set(a.type, [...(byType.get(a.type) ?? []), (Date.parse(a.decidedAt!) - Date.parse(a.createdAt)) / HOUR]);
  }
  const timeToDecision: LegibleMeasures["timeToDecision"] = {};
  for (const [type, xs] of byType) timeToDecision[type] = { medianHours: Math.round(median(xs)! * 10) / 10, sample: xs.length };
  const retired = world.asks.where("status = 'retired' AND updatedAt >= ?", [since]);
  const read = new Set((world.db.prepare("SELECT DISTINCT targetId FROM seen WHERE targetKind = 'ask'").all() as { targetId: string }[]).map((r) => r.targetId));

  // ---- grants ----
  const grants = world.grants.all();
  const funded = grants.filter((g) => g.history.some((h) => h.action === "fund" && h.at >= since)).length;
  const holdAsks = world.asks.where("type = 'money' AND targetKind = 'grant' AND createdAt >= ?", [since]).filter((a) => a.branches.some((b) => b.action === "adjust"));
  const asked = new Set(holdAsks.map((a) => a.targetId));
  const projected = new Set((world.db.prepare("SELECT DISTINCT json_extract(payload, '$.grantId') AS g FROM events WHERE type = 'grant.top-up-needed' AND ts >= ?").all(since) as { g: string | null }[])
    .map((r) => r.g).filter((g): g is string => !!g && !asked.has(g)));
  const closed = grants.filter((g) => g.status === "closed" && g.closedAt && g.closedAt >= since);
  const held = closed.filter((g) => g.history.some((h) => h.action === "checkpoint")).length;
  const gates = grants.filter((g) => g.status === "checkpoint");
  const views = screenViews(world, since, now);
  const holdAt = gates.map((g) => [...g.history].reverse().find((h) => h.action === "checkpoint")?.at ?? g.updatedAt).sort();

  return {
    at: now.toISOString(), windowDays: MEASURE_WINDOW_DAYS,
    openAsks: live.length,
    asksPerTarget: { targets: targets.size, ratio: ratio(live.length, targets.size), folds },
    oldestOpenAskHours: live.length ? hours(live[0]!.createdAt, t) : null,
    timeToDecision,
    retiredBeforeRead: { retired: retired.length, unread: retired.filter((a) => !read.has(a.id)).length },
    topUpsPerFundedGrant: { topUps: holdAsks.length + projected.size, funded, ratio: ratio(holdAsks.length + projected.size, funded) },
    holdShare: { held, closed: closed.length, share: ratio(held, closed.length) },
    spentOverSize: cal.sizes,
    sessionsPerStep: sessionsPerStep(world, since),
    cardRewrites: cardRewrites(world.asks.where("createdAt >= ?", [since], "ORDER BY createdAt, rowid")),
    heldAtGates: {
      grants: gates.length,
      tokens: Math.round(gates.reduce((n, g) => n + Math.max(0, (g.grantTokens ?? 0) - world.grantDesk.spent(g.id)), 0)),
      oldestHours: holdAt.length ? hours(holdAt[0]!, t) : null,
    },
    screenViews: { views: views.length, users: new Set(views.map((v) => v.userId)).size, open: views.filter((v) => v.open).length },
    queue: queueHealth(queueHealthInput(world, since, views, holdAsks.map((a) => ({ grantId: a.targetId!, createdAt: a.createdAt }))), now),
  };
}

/** The shell for `queueHealth`: the asks a human may have decided in the window, the views, the humans' 1:1 lines in the meetings those views were in, and the grants funded in the window or live now with their spend. */
function queueHealthInput(world: World, since: string, views: ReturnType<typeof screenViews>, adjustAsks: QueueHealthInput["adjustAsks"]): QueueHealthInput {
  const asks = world.asks.where("(status = 'decided' AND decidedAt >= ?) OR (status = 'retired' AND updatedAt >= ?)", [since, since])
    .map((a) => ({ id: a.id, type: a.type, targetId: a.targetId, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt, decidedBy: a.decidedBy, history: a.history }));
  const lines: QueueHealthInput["lines"] = [];
  for (const id of new Set(views.map((v) => v.meetingId))) {
    const m = world.meetings.get(id);
    for (const u of m?.transcript ?? []) if (u.speakerKind === "user" && u.at >= since) lines.push({ meetingId: id, userId: u.speakerId, at: u.at, text: u.text });
  }
  const grants = world.grants.all()
    .filter((g) => g.status === "funded" || g.status === "checkpoint" || g.history.some((h) => h.action === "fund" && h.at >= since))
    .map((g) => ({ id: g.id, status: g.status, grantTokens: g.grantTokens, spent: world.grantDesk.spent(g.id), history: g.history }));
  return { asks, views, lines, grants, adjustAsks };
}

/** Sessions per plan step completed since `since` (a step = a grant's assignments with that grantStep; done when its latest one is). */
function sessionsPerStep(world: World, since: string): LegibleMeasures["sessionsPerStep"] {
  const steps = new Map<string, { last: { status: string; updatedAt: string }; ids: string[] }>();
  for (const a of world.assignments.where("grantStep IS NOT NULL AND grantId IN (SELECT grantId FROM assignments WHERE grantStep IS NOT NULL AND updatedAt >= ?)", [since], "ORDER BY createdAt, rowid")) {
    const k = `${a.grantId}:${a.grantStep}`;
    steps.set(k, { last: a, ids: [...(steps.get(k)?.ids ?? []), a.id] });
  }
  const done = [...steps.values()].filter((s) => s.last.status === "done" && s.last.updatedAt >= since);
  if (!done.length) return { median: null, steps: 0 };
  const ids = done.flatMap((s) => s.ids);
  const counts = new Map<string, number>();
  for (const r of world.db.prepare(`SELECT assignmentId, COUNT(*) AS n FROM sessions WHERE assignmentId IN (${ids.map(() => "?").join(",")}) GROUP BY assignmentId`).all(...ids) as { assignmentId: string; n: number }[]) counts.set(r.assignmentId, r.n);
  return { median: median(done.map((s) => s.ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0))), steps: done.length };
}
