import { describe, expect, it } from "vitest";
import { rawTokens, splitByMix, splitRaw, type TokenCounts } from "@muster-town/schema";
import { BANK_MODEL, adjustedOutputTokens, booked, createBuilding, createResident, tokenWeights } from "../src/index.ts";
import { computeTokenMix, mixFormula, mixWindow } from "../src/token-mix.ts";
import { seededWorld } from "./helpers.ts";

// The adjusted-token mix (1:1 mt_rbc3exb393): one global, daily estimate of what an adj. token is made of.
const c = (x: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...x });
const OPUS = "claude-opus-5-5";
const W = tokenWeights(BANK_MODEL);
const NOW = new Date("2026-11-01T02:00:00Z");

describe("computeTokenMix", () => {
  it("sums real sessions' counters: shares of raw and of cost, raw per adj. token, the formula and the window", () => {
    // 10k output (10k adj) + 1M cache read (10k adj) + 100k input (20k adj) + 40k cache write 5m (10k adj) = 1.15M raw, 50k adj
    const m = computeTokenMix([
      { model: OPUS, ...c({ output: 10_000, cacheRead: 1_000_000 }) },
      { model: OPUS, ...c({ input: 100_000, cacheWrite5m: 40_000 }) },
    ], BANK_MODEL, W, NOW);
    expect(m).toMatchObject({ source: "usage", sessions: 2, rawTokens: 1_150_000, adjustedTokens: 50_000, windowDays: 7, from: "2026-10-25T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", computedAt: NOW.toISOString() });
    expect(m.rawPerAdjusted).toBeCloseTo(23, 9);
    expect(m.rawShare.cacheRead).toBeCloseTo(1_000_000 / 1_150_000, 9);
    expect(m.costShare).toEqual({ input: 0.4, output: 0.2, cacheRead: 0.2, cacheWrite5m: 0.2, cacheWrite1h: 0 });
    expect(m.formula).toBe("adj. tokens = output + 0.2 × input + 0.01 × cache read + 0.25 × cache write (5 min) + 0.4 × cache write (1 h)");
    expect(mixFormula(W)).toBe(m.formula);
  });

  it("leaves out back-filled and empty sessions; with nothing left it is the step-1 calibration (30 raw per adj. token)", () => {
    const m = computeTokenMix([{ model: OPUS, ...splitRaw(3_000_000, OPUS) }, { model: OPUS, ...c({}) }], BANK_MODEL, W, NOW);
    expect(m.source).toBe("calibration");
    expect(m.sessions).toBe(0);
    expect(m.rawPerAdjusted).toBeCloseTo(30, 3);
    expect(m.rawShare.output).toBeCloseTo(0.02357, 4);
    expect(m.rawShare.input + m.rawShare.cacheWrite5m + m.rawShare.cacheWrite1h).toBe(0);
  });

  it("the window is the 7 full UTC days before today", () => {
    expect(mixWindow(new Date("2026-11-01T23:59:00Z"))).toEqual({ from: "2026-10-25T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
  });
});

describe("splitting a bare adjusted number by the mix", () => {
  const m = computeTokenMix([{ model: OPUS, ...c({ output: 10_000, cacheRead: 1_000_000, input: 100_000, cacheWrite5m: 40_000 }) }], BANK_MODEL, W, NOW);

  it("splitByMix: tokens × raw per adj. token, in the mix's proportions, pricing back to the same adj. tokens", () => {
    const k = splitByMix(1_000, m);
    expect(rawTokens(k)).toBe(23_000);
    expect(k).toEqual({ input: 2_000, output: 200, cacheRead: 20_000, cacheWrite5m: 800, cacheWrite1h: 0 });
    expect(adjustedOutputTokens(BANK_MODEL, k)).toBe(1_000);
  });

  it("booked(n) with the mix keeps n as the booked tokens and splits its counters by the mix", () => {
    expect(booked(1_000, OPUS, null, m)).toEqual({ tokens: 1_000, counts: splitByMix(1_000, m) });
    // without a mix: the step-1 split, as before
    expect(booked(1_000, OPUS).counts).toEqual(splitRaw(30_000, OPUS));
  });
});

describe("the Bank's stored mix (world)", { timeout: 30_000 }, () => {
  it("first read back-fills it from the usage logs, stores it, and the runtime's tick recomputes it once per UTC day", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const first = world.bank.mix();
    expect(world.town.tokenMix()).toEqual(first);
    expect(world.events.list({ types: ["bank.mix"] }).length).toBeGreaterThanOrEqual(1);

    const counts = c({ output: 10_000, cacheRead: 1_000_000 });
    const s = world.ops.startSession(a.id, { purpose: "work", model: OPUS });
    world.ops.endSession(s.id, { status: "done", counts, byModel: { [OPUS]: counts }, costUsd: 0.4 });

    const today = new Date();
    expect(world.bank.mixDue(today)).toBeNull(); // today's is stored; the session ended today, inside no window yet
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const next = world.bank.mixDue(tomorrow)!;
    expect(next).toMatchObject({ source: "usage", sessions: 1, rawTokens: 1_010_000, adjustedTokens: 20_000 });
    expect(next.rawPerAdjusted).toBeCloseTo(50.5, 9);
    expect(world.bank.mixDue(tomorrow)).toBeNull();
    expect(world.bank.summary().mix).toEqual(next);
    expect(world.bank.finance().mix).toEqual(next);
    const ev = world.events.list({ types: ["bank.mix"], desc: true, limit: 1 })[0];
    expect(ev.text).toMatch(/1 adj\. token ≈ 50\.5 raw tokens \(0\.0% input, 99\.0% cache read, 0\.0% cache write, 1\.0% output\) from 1 sessions/);
  });
});
