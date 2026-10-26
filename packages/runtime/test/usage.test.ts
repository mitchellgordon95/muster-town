import { describe, expect, it } from "vitest";
import { noUsage, plusUsage, usageOf } from "../src/sdk.ts";

describe("usageOf: the five token counters from an SDK result (Bank grant step 1)", () => {
  it("reads modelUsage per model and splits cache writes 5m / 1h in the ratio of usage.cache_creation", () => {
    const u = usageOf({
      type: "result", num_turns: 3, total_cost_usd: 1.5,
      usage: { input_tokens: 9, output_tokens: 90, cache_read_input_tokens: 900, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: 1000, cacheCreationInputTokens: 400 },
        "claude-haiku-5-5": { inputTokens: 5, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    });
    expect(u.byModel["claude-opus-5-5"]).toEqual({ input: 10, output: 100, cacheRead: 1000, cacheWrite5m: 300, cacheWrite1h: 100 });
    expect(u.counts).toEqual({ input: 15, output: 150, cacheRead: 1000, cacheWrite5m: 300, cacheWrite1h: 100 });
    expect(u).toMatchObject({ tokens: 1565, costUsd: 1.5, turns: 3 });
  });

  it("without a TTL split every cache write is 5m; without modelUsage it reads usage under the model \"unknown\"", () => {
    const u = usageOf({ type: "result", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
    expect(u.byModel).toEqual({ unknown: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 0 } });
    expect(u.tokens).toBe(10);
    expect(usageOf({ type: "result" })).toEqual(noUsage());
  });

  it("plusUsage adds attempts model by model", () => {
    const a = usageOf({ type: "result", num_turns: 1, modelUsage: { m: { inputTokens: 1, outputTokens: 2 } } });
    const b = usageOf({ type: "result", num_turns: 2, modelUsage: { m: { outputTokens: 3 }, n: { cacheReadInputTokens: 4 } } });
    const sum = plusUsage(a, b);
    expect(sum.byModel).toEqual({ m: { input: 1, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, n: { input: 0, output: 0, cacheRead: 4, cacheWrite5m: 0, cacheWrite1h: 0 } });
    expect(sum).toMatchObject({ tokens: 10, turns: 3 });
  });
});
