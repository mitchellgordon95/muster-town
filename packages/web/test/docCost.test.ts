import { describe, expect, it } from "vitest";
import type { Doc } from "@muster-town/schema";
import { docCost } from "../src/panels/DocView";

const doc = (o: Partial<Doc>) => o as Doc;

describe("docCost", () => {
  it("joins cost, tokens and turns", () => {
    const s = docCost(doc({ costUsd: 0.42, tokens: 1200, turns: 4 }));
    expect(s).toMatch(/^\$0\.42 · .+ tokens · 4 turns$/);
  });
  it("singular turn, and skips missing parts", () => {
    expect(docCost(doc({ turns: 1 }))).toBe("1 turn");
  });
  it("is empty when the doc carries no usage", () => {
    expect(docCost(doc({}))).toBe("");
  });
});
