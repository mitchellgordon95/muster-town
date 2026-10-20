import { describe, expect, it } from "vitest";
import type { Agent } from "@muster-town/schema";
import { buildingBudgetLine, residentBudgetLine } from "../src/map/overlay";

const agent = (o: Partial<Agent>) => ({ kind: "resident", spentTokensToday: 0, ...o }) as Agent;

describe("map budget lines", () => {
  it("building sign: used and left", () => {
    expect(buildingBudgetLine({ allocatedTokens: 50_000_000, spentTokens: 3_320_000, remainingTokens: 46_680_000 })).toBe("3.3M used · 47M left");
  });
  it("building sign: nothing when never allocated", () => {
    expect(buildingBudgetLine(undefined)).toBeNull();
    expect(buildingBudgetLine({ allocatedTokens: 0, spentTokens: 0, remainingTokens: 0 })).toBeNull();
  });
  it("resident: today's tokens and what's left of the daily allowance, never negative", () => {
    expect(residentBudgetLine(agent({ spentTokensToday: 412_000 }), 2_000_000)).toBe("412k today · 1.6M left");
    expect(residentBudgetLine(agent({ spentTokensToday: 2_500_000 }), 2_000_000)).toBe("2.5M today · 0 left");
  });
  it("resident: nothing for services, humans, or without a home building", () => {
    expect(residentBudgetLine(agent({ kind: "service" }), 2_000_000)).toBeNull();
    expect(residentBudgetLine(agent({}), undefined)).toBeNull();
  });
});
