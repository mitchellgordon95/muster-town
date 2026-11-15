/**
 * Queue health (grant gr_pdja05z2f1 step 2): property tests over generated inputs for the pure `queueHealth`, with a
 * hand-rolled seeded generator (no fast-check). Each property runs over RUNS random towns.
 */
import { describe, expect, it } from "vitest";
import { askQueueTime, FEW_GATES_PER_GRANT, HIGH_BUDGET_USED, QUEUE_WINDOW_DAYS, queueHealth, queueHealthBlock, type QueueAsk, type QueueGrant, type QueueHealthInput, type QueueLine, type QueueView } from "../src/queue-health.ts";
import { VIEW_CAP_MS } from "../src/screen-views.ts";

const RUNS = 200;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** mulberry32: a small seeded PRNG so a failing run can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]) => xs[int(0, xs.length - 1)]!;
  return { next, int, pick };
}
type R = ReturnType<typeof rng>;

const USERS = ["us_a", "us_b"], MEETINGS = ["mt_1", "mt_2", "mt_3"], TYPES = ["money", "click", "policy"] as const;

function genAsk(r: R, i: number): QueueAsk {
  const created = NOW.getTime() - r.int(1, 20 * 24) * HOUR;
  const decidedAt = Math.min(NOW.getTime(), created + r.int(1, 48 * 60) * MIN);
  const user = r.pick(USERS), kind = r.int(0, 3);
  const base = { id: `ak_${i}`, type: r.pick(TYPES), targetId: r.next() < 0.7 ? `gr_${i % 5}` : null, createdAt: iso(created), history: [] as QueueAsk["history"] };
  if (kind === 0) return { ...base, status: "decided", decidedAt: iso(decidedAt), decidedBy: user };
  if (kind === 1) return { ...base, status: "retired", decidedAt: null, decidedBy: null, history: [{ at: iso(decidedAt), action: "retire", by: r.next() < 0.6 ? user : "system" }] };
  return { ...base, status: kind === 2 ? "open" : "folded", decidedAt: null, decidedBy: null };
}
function genView(r: R, asks: QueueAsk[]): QueueView {
  const a = r.pick(asks);
  const opened = Date.parse(a.createdAt) + r.int(-120, 48 * 60) * MIN;
  const onTarget = a.targetId && r.next() < 0.4;
  return { userId: r.pick(USERS), kind: onTarget ? r.pick(["grant", "doc", "retainer"]) : "ask", itemId: onTarget ? a.targetId! : a.id, meetingId: r.pick(MEETINGS), openedAt: iso(opened), ms: r.int(0, VIEW_CAP_MS) };
}
function genLine(r: R): QueueLine {
  return { meetingId: r.pick(MEETINGS), userId: r.pick(USERS), at: iso(NOW.getTime() - r.int(0, 20 * 24 * 60) * MIN), text: r.next() < 0.5 ? "why this?" : "fine" };
}
function genGrant(r: R, i: number): QueueGrant {
  const fundAt = NOW.getTime() - r.int(0, 20) * DAY;
  const history = [{ at: iso(fundAt - HOUR), action: "propose" }, { at: iso(fundAt), action: "fund" }];
  for (let k = r.int(0, 2); k > 0; k--) history.push({ at: iso(fundAt + r.int(1, 48) * HOUR), action: "checkpoint" });
  const grantTokens = r.next() < 0.1 ? null : r.int(1, 10) * 100_000;
  return { id: `gr_${i}`, status: r.pick(["funded", "checkpoint", "closed"]), grantTokens, spent: r.int(0, 1_200_000), history };
}
function genTown(seed: number): QueueHealthInput {
  const r = rng(seed);
  const asks = Array.from({ length: r.int(1, 12) }, (_, i) => genAsk(r, i));
  const views = Array.from({ length: r.int(0, 25) }, () => genView(r, asks));
  const lines = Array.from({ length: r.int(0, 30) }, () => genLine(r));
  const grants = Array.from({ length: r.int(0, 6) }, (_, i) => genGrant(r, i));
  const adjustAsks = grants.flatMap((g) => (r.next() < 0.3 ? [{ grantId: g.id, createdAt: g.history[1]!.at }] : []));
  return { asks, views, lines, grants, adjustAsks };
}
const forEachTown = (fn: (town: QueueHealthInput, seed: number) => void) => { for (let seed = 1; seed <= RUNS; seed++) fn(genTown(seed), seed); };

describe("queueHealth properties", () => {
  it("time on card never exceeds decision time, and first seen never exceeds it either", () => {
    forEachTown((town, seed) => {
      for (const a of town.asks) {
        const q = askQueueTime(a, town.views, town.lines);
        if (!q) continue;
        expect(q.cardMs, `seed ${seed} ${a.id}`).toBeLessThanOrEqual(q.decisionMs);
        expect(q.cardMs).toBeGreaterThanOrEqual(0);
        if (q.firstSeenMs !== null) { expect(q.firstSeenMs).toBeLessThanOrEqual(q.decisionMs); expect(q.cardMs).toBeLessThanOrEqual(q.firstSeenMs); }
        expect(q.questions).toBeLessThanOrEqual(q.lines);
      }
    });
  });

  it("a line said outside every view never counts", () => {
    forEachTown((town, seed) => {
      // move every line to a meeting no view was in: nothing counts
      const moved = town.lines.map((l) => ({ ...l, meetingId: "mt_elsewhere" }));
      for (const a of town.asks) expect(askQueueTime(a, town.views, moved)?.lines ?? 0, `seed ${seed}`).toBe(0);
      // and lines with no view at all
      for (const a of town.asks) expect(askQueueTime(a, [], town.lines)?.lines ?? 0).toBe(0);
    });
  });

  it("adding a view never lowers time on card (nor lines)", () => {
    forEachTown((town, seed) => {
      const r = rng(seed * 7919);
      const more = [...town.views, genView(r, town.asks)];
      for (const a of town.asks) {
        const before = askQueueTime(a, town.views, town.lines), after = askQueueTime(a, more, town.lines);
        if (!before) { expect(after).toBeNull(); continue; }
        expect(after!.cardMs, `seed ${seed} ${a.id}`).toBeGreaterThanOrEqual(before.cardMs);
        expect(after!.lines).toBeGreaterThanOrEqual(before.lines);
      }
    });
  });

  it("budget used is spent over granted for the grants funded in the window, never negative", () => {
    forEachTown((town, seed) => {
      const g = queueHealth(town, NOW).gates;
      const since = NOW.getTime() - QUEUE_WINDOW_DAYS * DAY;
      const funded = town.grants.filter((x) => x.history.some((h) => h.action === "fund" && Date.parse(h.at) >= since));
      const granted = funded.reduce((n, x) => n + (x.grantTokens ?? 0), 0), spent = funded.reduce((n, x) => n + x.spent, 0);
      expect(g.funded, `seed ${seed}`).toBe(funded.length);
      expect(g.granted).toBe(granted);
      expect(g.spent).toBe(spent);
      if (granted) expect(g.budgetUsed).toBeCloseTo(spent / granted, 2); else expect(g.budgetUsed).toBeNull();
      if (g.budgetUsed !== null) expect(g.budgetUsed).toBeGreaterThanOrEqual(0);
      expect(g.warning).toBe(g.perGrant !== null && g.budgetUsed !== null && g.perGrant < FEW_GATES_PER_GRANT && g.budgetUsed > HIGH_BUDGET_USED);
      if (g.holdShareToday !== null) expect(g.holdShareToday).toBeLessThanOrEqual(1);
    });
  });

  it("every median carries a sample, and card medians only over asks seen", () => {
    forEachTown((town) => {
      for (const row of Object.values(queueHealth(town, NOW).byType)) {
        expect(row.decisionHours.sample).toBeGreaterThan(0);
        expect(row.minutesOnCard.sample).toBeLessThanOrEqual(row.decisionHours.sample);
        for (const m of [row.minutesOnCard, row.firstSeenMinutes, row.lines, row.questions]) expect(m.median === null).toBe(m.sample === 0);
      }
    });
  });
});

describe("queueHealth examples", () => {
  it("an empty town gives nulls, not zeros", () => {
    const q = queueHealth({ asks: [], views: [], lines: [], grants: [], adjustAsks: [] }, NOW);
    expect(q.byType).toEqual({});
    expect(q.gates).toMatchObject({ funded: 0, perGrant: null, holdShareToday: null, budgetUsed: null, warning: false });
    expect(queueHealthBlock(q)).toContain("No ask decided by a human in the window.");
  });

  it("one money ask: views on the ask and its grant, overlapping views count once, lines inside views only", () => {
    const t0 = NOW.getTime() - 2 * HOUR;
    const ask: QueueAsk = { id: "ak_1", type: "money", targetId: "gr_1", status: "decided", createdAt: iso(t0), decidedAt: iso(t0 + HOUR), decidedBy: "us_a", history: [] };
    const views: QueueView[] = [
      { userId: "us_a", kind: "ask", itemId: "ak_1", meetingId: "mt_1", openedAt: iso(t0 + 10 * MIN), ms: 10 * MIN },
      { userId: "us_a", kind: "grant", itemId: "gr_1", meetingId: "mt_2", openedAt: iso(t0 + 15 * MIN), ms: 10 * MIN }, // overlaps 5 min
      { userId: "us_b", kind: "ask", itemId: "ak_1", meetingId: "mt_3", openedAt: iso(t0), ms: 50 * MIN }, // not the decider
      { userId: "us_a", kind: "ask", itemId: "ak_1", meetingId: "mt_1", openedAt: iso(t0 + 55 * MIN), ms: 30 * MIN }, // clipped at the decision
    ];
    const lines: QueueLine[] = [
      { meetingId: "mt_1", userId: "us_a", at: iso(t0 + 12 * MIN), text: "what does this buy?" },
      { meetingId: "mt_2", userId: "us_a", at: iso(t0 + 20 * MIN), text: "ok" },
      { meetingId: "mt_1", userId: "us_a", at: iso(t0 + 30 * MIN), text: "outside any view?" },
      { meetingId: "mt_1", userId: "us_a", at: iso(t0 + 2 * HOUR), text: "after the decision?" },
    ];
    const grant: QueueGrant = { id: "gr_1", status: "funded", grantTokens: 100_000, spent: 90_000, history: [{ at: iso(t0), action: "fund" }] };
    const q = queueHealth({ asks: [ask], views, lines, grants: [grant], adjustAsks: [] }, NOW);
    expect(q.byType.money).toEqual({
      decisionHours: { median: 1, sample: 1 }, minutesOnCard: { median: 20, sample: 1 }, firstSeenMinutes: { median: 50, sample: 1 },
      lines: { median: 2, sample: 1 }, questions: { median: 1, sample: 1 },
    });
    expect(q.gates).toMatchObject({ funded: 1, gates: 0, perGrant: 0, live: 1, heldNow: 0, budgetUsed: 0.9, warning: true });
    expect(queueHealthBlock(q)).toContain("WARNING: few gates with high budget use");
  });

  it("a retire by a human counts as a decision; a retire by the system does not", () => {
    const base = { id: "ak_2", type: "click" as const, targetId: null, status: "retired", createdAt: iso(NOW.getTime() - 3 * HOUR), decidedAt: null, decidedBy: null };
    expect(queueHealth({ asks: [{ ...base, history: [{ at: iso(NOW.getTime() - HOUR), action: "retire", by: "us_a" }] }], views: [], lines: [], grants: [], adjustAsks: [] }, NOW).byType.click?.decisionHours).toEqual({ median: 2, sample: 1 });
    expect(queueHealth({ asks: [{ ...base, history: [{ at: iso(NOW.getTime() - HOUR), action: "retire", by: "system" }] }], views: [], lines: [], grants: [], adjustAsks: [] }, NOW).byType).toEqual({});
  });
});
