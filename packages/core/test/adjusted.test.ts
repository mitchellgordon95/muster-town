import { describe, expect, it } from "vitest";
import { splitRaw, type TokenCounts } from "@muster-town/schema";
import { adjustedOfUsage, adjustedOutputTokens, createBuilding, createResident, tokenPrices, tokenWeights } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// Bank grant step 2: adjusted output tokens = output + Σ (list price / output price) × count, never stored.
const c = (x: Partial<TokenCounts>): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...x });
const M = 1_000_000;

describe("adjustedOutputTokens (Bank grant step 2)", () => {
  it("weights each kind by its list price over the model's output price, per family", () => {
    expect(tokenWeights("claude-opus-5-5")).toEqual({ input: 0.2, output: 1, cacheRead: 0.01, cacheWrite5m: 0.25, cacheWrite1h: 0.4 });
    expect(tokenWeights("claude-fable-5-1")).toEqual({ input: 0.2, output: 1, cacheRead: 0.005, cacheWrite5m: 0.25, cacheWrite1h: 0.4 });
    expect(tokenWeights("claude-sonnet-5-5")).toEqual({ input: 0.2, output: 1, cacheRead: 0.01, cacheWrite5m: 0.25, cacheWrite1h: 0.4 });
    expect(tokenWeights("claude-haiku-5-5")).toEqual({ input: 0.2, output: 1, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0.4 });
    expect(tokenWeights("claude-haiku-4-5-20251001").cacheRead).toBeCloseTo(0.02);
    expect(tokenPrices("claude-opus-4-1").family).toBe("opus-4");
    expect(tokenPrices("claude-opus-4-7").family).toBe("opus-5");
    expect(tokenPrices("claude-fable-5").family).toBe("fable-5");
    expect(tokenPrices("opus").family).toBe("opus-5.5");
    const all = c({ input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M });
    expect(adjustedOutputTokens("claude-opus-5-5", all)).toBe(1_860_000);
    expect(adjustedOutputTokens("claude-fable-5-1", all)).toBe(1_855_000);
    expect(adjustedOutputTokens("claude-sonnet-5-5", all)).toBe(1_860_000);
    expect(adjustedOutputTokens("claude-haiku-5-5", all)).toBe(1_870_000);
  });

  it("zero counters are zero; an unknown or missing model is priced as Opus 5.5", () => {
    expect(adjustedOutputTokens("claude-opus-5-5", c({}))).toBe(0);
    expect(tokenPrices("gpt-9")).toMatchObject({ family: "opus-5.5", known: false });
    expect(tokenPrices(null).known).toBe(false);
    expect(adjustedOutputTokens("gpt-9", c({ output: 10, input: 100 }))).toBe(30);
  });

  it("the back-fill split comes out at exactly raw / 30 (Opus) and raw / 24 (Fable)", () => {
    expect(adjustedOutputTokens("claude-opus-5-5", splitRaw(30_000, "claude-opus-5-5"))).toBe(1_000);
    expect(adjustedOutputTokens("claude-fable-5-1", splitRaw(24_000, "claude-fable-5-1"))).toBe(1_000);
  });

  it("with a per-model breakdown each model is priced at its own list price, in the session model's output tokens", () => {
    const fable = c({ output: 1_000, cacheRead: 100_000 }), haiku = c({ input: 2_000, output: 20 });
    // fable: 1000 + 500 = 1500; haiku: (2000 × $0.10 + 20 × $0.50) / $50 = 4.2 fable output tokens
    expect(adjustedOfUsage("claude-fable-5-1", c({ input: 2_000, output: 1_020, cacheRead: 100_000 }), { "claude-fable-5-1": fable, "claude-haiku-5-5": haiku })).toBe(1_504);
  });

  it("is derived on session.ended and stored nowhere; an unknown model gets one warning event", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const counts = c({ input: 100, output: 300, cacheRead: 40_000, cacheWrite5m: 2_000, cacheWrite1h: 1_000 });
    const s1 = world.ops.startSession(a.id, { purpose: "work", model: "claude-opus-5-5" });
    world.ops.endSession(s1.id, { status: "done", counts, byModel: { "claude-opus-5-5": counts } });
    const ev = world.events.list({ types: ["session.ended"] }).find((e) => e.payload?.sessionId === s1.id)!;
    expect(ev.payload.adjustedOutputTokens).toBe(300 + 20 + 400 + 500 + 400);
    expect(world.sessions.get(s1.id)!.byModel).toEqual({ "claude-opus-5-5": counts });
    expect(Object.keys(world.db.prepare("SELECT * FROM sessions WHERE id = ?").get(s1.id) as object)).not.toContain("adjustedOutputTokens");

    for (let i = 0; i < 2; i++) {
      const s = world.ops.startSession(a.id, { purpose: "work", model: "mystery-model-1" });
      world.ops.endSession(s.id, { status: "done", counts });
    }
    const warnings = world.events.list({ types: ["system"] }).filter((e) => e.payload?.warning === "unknown-model");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].payload.models).toEqual(["mystery-model-1"]);
  });
});
