import { describe, expect, it } from "vitest";
import type { Agent, BuildingBudget } from "@muster-town/schema";
import { buildingBudgetLine, residentBudgetLine } from "../src/map/overlay";

const agent = (o: Partial<Agent>) => ({ kind: "resident", spentTokensToday: 0, ...o }) as Agent;

describe("map budget lines", () => {
  const bb = (o: Partial<BuildingBudget>) => ({ allocatedTokens: 0, spentTokens: 0, remainingTokens: 0, bankTokens: 0, tokensToday: 0, tokensAllTime: 0, ...o });
  it("building sign: today, all-time and left", () => {
    expect(buildingBudgetLine(bb({ allocatedTokens: 50_000_000, spentTokens: 3_320_000, remainingTokens: 46_680_000, tokensToday: 1_240_000, tokensAllTime: 40_000_000 }))).toBe("1.2M today · 40M all-time · 47M left");
  });
  it("building sign: usage without an allocation (the Town Hall), and left without usage", () => {
    expect(buildingBudgetLine(bb({ tokensToday: 0, tokensAllTime: 655_000 }))).toBe("0 today · 655k all-time");
    expect(buildingBudgetLine(bb({ allocatedTokens: 10_000_000, remainingTokens: 10_000_000 }))).toBe("10M left");
    expect(buildingBudgetLine(bb({ remainingTokens: 34_750_000, bankTokens: 34_750_000, tokensToday: 127_900_000, tokensAllTime: 158_000_000 }))).toBe("128M today · 158M all-time · 35M left");
  });
  it("building sign: nothing when never used or allocated", () => {
    expect(buildingBudgetLine(undefined)).toBeNull();
    expect(buildingBudgetLine(bb({}))).toBeNull();
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
