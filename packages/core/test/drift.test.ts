import { describe, expect, it } from "vitest";
import { splitRaw, type TokenCounts } from "@muster-town/schema";
import { createBuilding, createResident } from "../src/index.ts";
import { driftRows, parseResetsAt, previousUtcDay, utcDay, type DriftSession } from "../src/drift.ts";
import { seededWorld } from "./helpers.ts";

// Bank grant step 4: the drift job (adjusted output tokens × output list price vs the SDK's costUsd) and bank.cap.
const c = (x: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...x });
const OPUS = "claude-opus-5-5", FABLE = "claude-fable-5-1";
const sess = (model: string, counts: TokenCounts, costUsd: number, buildingId: string | null = "lab", byModel: DriftSession["byModel"] = undefined): DriftSession =>
  ({ model, ...counts, costUsd, buildingId, byModel: byModel ?? { [model]: counts } });

describe("driftRows (Bank grant step 4)", () => {
  it("two models: per model and building, then per model over all buildings; ratio = adjusted $ / SDK $", () => {
    // opus: 100k output ($2) + 1M cache read ($0.20) = 110k adjusted = $2.20; fable: 10k output = $0.50
    const rows = driftRows("2026-10-26", [
      sess(OPUS, c({ output: 100_000, cacheRead: 1_000_000 }), 2.0, "lab"),
      sess(OPUS, c({ output: 100_000, cacheRead: 1_000_000 }), 2.4, "shop"),
      sess(FABLE, c({ output: 10_000 }), 0.5, "lab"),
    ]);
    const all = (m: string) => rows.find((r) => r.model === m && r.building === null)!;
    expect(all(OPUS)).toMatchObject({ sessions: 2, adjustedOutputTokens: 220_000, adjustedUsd: 4.4, costUsd: 4.4, ratio: 1 });
    expect(all(FABLE)).toMatchObject({ sessions: 1, adjustedUsd: 0.5, costUsd: 0.5, ratio: 1 });
    expect(rows.find((r) => r.model === OPUS && r.building === "lab")!.ratio).toBe(1.1);
    expect(rows.find((r) => r.model === OPUS && r.building === "shop")!.ratio).toBeCloseTo(0.917, 3);
    expect(rows).toHaveLength(5);
  });

  it("a day with no sessions (or only empty ones) has no rows; no SDK cost gives ratio null", () => {
    expect(driftRows("2026-10-26", [])).toEqual([]);
    expect(driftRows("2026-10-26", [sess(OPUS, c({}), 0)])).toEqual([]);
    expect(driftRows("2026-10-26", [sess(OPUS, c({ output: 10 }), 0)])[0].ratio).toBeNull();
  });

  it("back-filled rows (the raw split, no breakdown) are counted apart and left out of the sums", () => {
    const rows = driftRows("2026-10-26", [
      { ...sess(OPUS, splitRaw(3_000_000, OPUS), 9.99), byModel: null },
      sess(OPUS, c({ output: 50_000 }), 1.0),
    ]);
    expect(rows.find((r) => r.building === null)).toMatchObject({ sessions: 1, backfilled: 1, adjustedUsd: 1, costUsd: 1, ratio: 1 });
  });

  it("reads a UTC reset time from the cap message", () => {
    const at = new Date("2026-10-25T22:18:00Z");
    expect(parseResetsAt("You've hit your org's monthly spend limit · session limit resets 11:10pm (UTC)", at)).toBe("2026-10-25T23:10:00.000Z");
    expect(parseResetsAt("limit resets 9am (UTC)", at)).toBe("2026-10-26T09:00:00.000Z");
    expect(parseResetsAt("resets 3pm (America/New_York)", at)).toBeNull();
    expect(parseResetsAt("spend limit", at)).toBeNull();
    expect(previousUtcDay(at)).toBe("2026-10-24");
  });
});

describe("Bank drift job and bank.cap (world)", { timeout: 30_000 }, () => {
  function world2() {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    return { world, b, a };
  }

  it("runDrift writes bank.drift events per row, GET /api/bank's summary shows the latest, driftDue runs once per day", () => {
    const { world, b, a } = world2();
    for (const [model, counts, cost] of [[OPUS, c({ output: 100_000 }), 2.1], [FABLE, c({ output: 20_000 }), 1.0]] as const) {
      const s = world.ops.startSession(a.id, { purpose: "work", model });
      world.ops.endSession(s.id, { status: "done", counts, byModel: { [model]: counts }, costUsd: cost });
    }
    const today = utcDay(new Date());
    const rows = world.bank.runDrift(today);
    expect(rows).toHaveLength(4);
    const evs = world.events.list({ types: ["bank.drift"] });
    expect(evs).toHaveLength(4);
    expect(evs.find((e) => e.payload.model === OPUS && e.payload.building === b.id)!.payload).toMatchObject({ day: today, adjustedUsd: 2, costUsd: 2.1, ratio: 0.952 });
    const drift = world.bank.summary().drift!;
    expect(drift.day).toBe(today);
    expect(drift.models.map((r) => [r.model, r.ratio])).toEqual([[FABLE, 1], [OPUS, 0.952]]);
    expect(drift.buildings).toHaveLength(2);

    // the runtime's tick: tomorrow, today's run already exists → nothing new; the day after, an empty day → one marker row
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000);
    expect(world.bank.driftDue(tomorrow)).toBeNull();
    const dayAfter = new Date(tomorrow.getTime() + 86_400_000);
    expect(world.bank.driftDue(dayAfter)).toEqual([expect.objectContaining({ model: null, sessions: 0 })]);
    expect(world.bank.driftDue(dayAfter)).toBeNull();
    expect(world.bank.summary().drift).toMatchObject({ models: [], buildings: [] });
  });

  it("an admin's run by hand is marked manual and doesn't stand in for the nightly run; others are refused", () => {
    const { world, seed } = seededWorld();
    const today = utcDay(new Date());
    expect(() => world.bank.runDriftByHand(seed.admin.id, "yesterday")).toThrow(/YYYY-MM-DD/);
    expect(world.bank.runDriftByHand(seed.admin.id, today)).toEqual([expect.objectContaining({ model: null, sessions: 0 })]);
    expect(world.events.list({ types: ["bank.drift"] })[0].payload.manual).toBe(true);
    expect(world.bank.driftDue(new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000))).not.toBeNull();
    const other = world.users.all().find((u) => u.id !== seed.admin.id);
    if (other) expect(() => world.bank.runDriftByHand(other.id, today)).toThrow(/admin/);
  });

  it("a SPEND_LIMIT death logs bank.cap with the day's adjusted spend; an ordinary error doesn't", () => {
    const { world, b, a } = world2();
    const before = world.ops.startSession(a.id, { purpose: "work", model: OPUS });
    world.ops.endSession(before.id, { status: "done", counts: c({ output: 10_000 }), costUsd: 0.2 });
    const msg = "You've hit your org's monthly spend limit · session limit resets 11:10pm (UTC)";
    const s = world.ops.startSession(a.id, { purpose: "work", model: OPUS });
    world.ops.endSession(s.id, { status: "done", counts: c({ output: 5_000 }), costUsd: 0.1, funding: "api-key", spendLimit: msg });
    const cap = world.events.list({ types: ["bank.cap"] });
    expect(cap).toHaveLength(1);
    expect(cap[0].payload).toMatchObject({ sessionId: s.id, building: b.id, day: utcDay(new Date()), adjustedSpendToday: 15_000, subscriptionAdjustedToday: 15_000, listUsdToday: 0.3, sessionsToday: 2, message: msg, funding: "api-key" });
    expect(cap[0].payload.resetsAt).toMatch(/T23:10:00.000Z$/);

    // no failover: the error itself reads as the cap
    const s2 = world.ops.startSession(a.id, { purpose: "work", model: OPUS });
    world.ops.endSession(s2.id, { status: "error", counts: c({}), error: "Claude Code returned: usage limit reached" });
    const s3 = world.ops.startSession(a.id, { purpose: "work", model: OPUS });
    world.ops.endSession(s3.id, { status: "error", counts: c({}), error: "tool crashed" });
    expect(world.events.list({ types: ["bank.cap"] }).map((e) => e.payload.sessionId)).toEqual([s.id, s2.id]);
  });
});
