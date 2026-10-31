import { describe, expect, it } from "vitest";
import { addTokens, rawTokens, sliceTokens, splitRaw, TOKEN_KINDS, type TokenCounts } from "@muster-town/schema";
import { createBuilding, createResident, sessionView } from "../src/index.ts";
import { fundBuilding, seededWorld } from "./helpers.ts";

/** step 2's adjusted value for a back-filled row: output + cacheRead × (cache-read price / output price) */
const adjusted = (c: TokenCounts, w: number) => c.output + c.cacheRead * w;

describe("token counters: back-fill (Bank grant step 1)", () => {
  it("splits a raw total into output + cache read so the adjusted value is raw / 30 (Opus) or raw / 24 (Fable)", () => {
    const opus = splitRaw(30_000, "claude-opus-5-5");
    expect(opus).toEqual({ input: 0, output: 707, cacheRead: 29_293, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(adjusted(opus, 0.01)).toBeCloseTo(1000, 0);
    const fable = splitRaw(24_000, "claude-fable-5-1");
    expect(fable).toEqual({ input: 0, output: 884, cacheRead: 23_116, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(adjusted(fable, 0.005)).toBeCloseTo(1000, 0);
    // any other (or no) model counts as Opus; the raw total is always kept exactly
    expect(splitRaw(30_000, null)).toEqual(opus);
    for (const n of [0, 1, 7, 999, 123_457]) expect(rawTokens(splitRaw(n, "m"))).toBe(n);
  });

  it("slicing a breakdown keeps every part summing to the slice and the pieces summing to the whole, kind by kind", () => {
    const whole: TokenCounts = { input: 13, output: 4_000, cacheRead: 91_000, cacheWrite5m: 2_500, cacheWrite1h: 487 };
    const a = sliceTokens(whole, 33_333);
    expect(rawTokens(a)).toBe(33_333);
    const rest = Object.fromEntries(TOKEN_KINDS.map((k) => [k, whole[k] - a[k]])) as TokenCounts;
    for (const k of TOKEN_KINDS) expect(rest[k]).toBeGreaterThanOrEqual(0);
    expect(rawTokens(rest)).toBe(rawTokens(whole) - 33_333);
  });
});

describe("token counters: booking", () => {
  it("a charge by kind books its adjusted output tokens, with the same counters, into the usage ledger, the Bank's debits and the allocation", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Banked" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    fundBuilding(world, b.id, { poolId: world.bank.createPool(seed.admin.id, { name: "All", pct: 100 }).id });
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 100, apiKey: "sk" });
    world.budget.donate(seed.admin.id, { tokens: 500, buildingId: b.id });
    const counts: TokenCounts = { input: 30, output: 120, cacheRead: 900, cacheWrite5m: 100, cacheWrite1h: 50 }; // 1200 raw
    // Opus 5.5 (an unknown model is priced as Opus 5.5): 120 + 0.2 × 30 + 0.01 × 900 + 0.25 × 100 + 0.4 × 50 = 180 adjusted
    const r = world.budget.charge(a.id, counts, 1.2, undefined, { model: "claude-opus-5-5" });

    const usage = world.db.prepare("SELECT input, output, cacheRead, cacheWrite5m, cacheWrite1h, rawTokens, tokens FROM usage WHERE agentId = ?").get(a.id);
    expect(usage).toEqual({ ...counts, rawTokens: 1200, tokens: 180 });
    expect(world.agents.require(a.id)).toMatchObject({ spentTokensToday: 180, spentTokensTotal: 180 });
    const debits = world.db.prepare("SELECT SUM(input) input, SUM(output) output, SUM(cacheRead) cacheRead, SUM(cacheWrite5m) cacheWrite5m, SUM(cacheWrite1h) cacheWrite1h, SUM(tokens) tokens FROM bank_debits WHERE buildingId = ?").get(b.id) as TokenCounts & { tokens: number };
    expect(debits.tokens).toBe(100);
    // what the Bank didn't cover went to the allocation; together they are the charge, kind by kind
    expect(r.allocation).toMatchObject({ spentTokens: 80 });
    for (const k of TOKEN_KINDS) {
      const spent = r.allocation![`spent${k[0].toUpperCase()}${k.slice(1)}` as "spentInput"];
      expect(debits[k] + spent).toBe(counts[k]);
    }
    // the debit took 100 / 180 of every counter: 667 of the 1200 raw
    expect(TOKEN_KINDS.reduce((s, k) => s + debits[k], 0)).toBe(667);
    expect(world.budget.of(b.id)).toMatchObject({ remainingTokens: 420, bankTokens: 0 });
    // the credit is 100 adjusted; its counters are the back-fill split of the 3000 raw it stands for (Opus: 30 raw each)
    expect(world.db.prepare("SELECT output, cacheRead, rawTokens, tokens FROM bank_credits").get()).toEqual({ output: 71, cacheRead: 2929, rawTokens: 3000, tokens: 100 });
    const credited = world.events.list({ types: ["bank.credited"] })[0];
    expect(credited.payload).toMatchObject({ tokens: 100, rawTokens: 3000, adjustedOutputTokens: 100, output: 71, cacheRead: 2929, input: 0 });
  });

  it("a bare number is already adjusted; a session's charge books exactly its adjustedOutputTokens", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    world.budget.recordUsage(a.id, 50, 0);
    expect(world.db.prepare("SELECT output, cacheRead, rawTokens, tokens FROM usage WHERE agentId = ?").get(a.id)).toEqual({ output: 35, cacheRead: 1465, rawTokens: 1500, tokens: 50 });
    // a Fable session with a Haiku subagent: each model at its own list price, in Fable output tokens
    const byModel = { "claude-fable-5-1": { input: 1000, output: 2000, cacheRead: 100_000, cacheWrite5m: 4000, cacheWrite1h: 0 }, "claude-haiku-5-5": { input: 50_000, output: 5000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
    const counts = addTokens(byModel["claude-fable-5-1"], byModel["claude-haiku-5-5"]);
    const s = world.ops.startSession(a.id, { purpose: "work", model: "claude-fable-5-1" });
    const ended = world.ops.endSession(s.id, { status: "done", counts, byModel });
    const before = world.agents.require(a.id).spentTokensTotal;
    world.budget.recordUsage(a.id, counts, 0, { model: ended.model, byModel });
    expect(world.agents.require(a.id).spentTokensTotal - before).toBe(sessionView(ended).adjustedOutputTokens);
  });

  it("session.ended carries the model and the five counters (and per model); a bare raw total is back-filled", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const counts: TokenCounts = { input: 5, output: 300, cacheRead: 40_000, cacheWrite5m: 2_000, cacheWrite1h: 1_000 };
    const s1 = world.ops.startSession(a.id, { purpose: "work", model: "claude-opus-5-5" });
    const done = world.ops.endSession(s1.id, { status: "done", counts, byModel: { "claude-opus-5-5": counts } });
    expect(done).toMatchObject({ ...counts, tokens: 43_305 });
    const ev = world.events.list({ types: ["session.ended"] }).find((e) => e.payload?.sessionId === s1.id)!;
    expect(ev.payload).toMatchObject({ model: "claude-opus-5-5", tokens: 43_305, ...counts, byModel: { "claude-opus-5-5": counts } });

    const s2 = world.ops.startSession(a.id, { purpose: "work", model: "claude-fable-5-1" });
    expect(world.ops.endSession(s2.id, { status: "done", tokens: 24_000 })).toMatchObject({ output: 884, cacheRead: 23_116, tokens: 24_000 });
  });
});
