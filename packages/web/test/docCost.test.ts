import { describe, expect, it } from "vitest";
import type { Doc } from "@muster-town/schema";
import { docCost, docCostTitle } from "../src/panels/DocView";

const doc = (o: Partial<Doc>) => o as Doc;

describe("docCost", () => {
  it("says the cost and steps in plain words; the town's units go in the tooltip", () => {
    const d = doc({ costUsd: 0.42, tokens: 1200, turns: 4 });
    expect(docCost(d)).toBe("$0.42 of work · 4 steps");
    expect(docCost(d)).not.toMatch(/adj/i);
    expect(docCostTitle(d)).toMatch(/adj\. tokens[\s\S]*4 turns/);
  });
  it("falls back to tokens without a dollar figure, singular step, and skips missing parts", () => {
    expect(docCost(doc({ turns: 1 }))).toBe("1 step");
    expect(docCost(doc({ tokens: 1200 }))).toMatch(/^.+ tokens of work$/);
  });
  it("is empty when the doc carries no usage", () => {
    expect(docCost(doc({}))).toBe("");
  });
});
