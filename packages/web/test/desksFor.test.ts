import { describe, expect, it } from "vitest";
import { desksFor, labSize } from "../src/map/townPlan";

describe("desksFor (the planner's new building: desks follow its size)", () => {
  it("is the largest headcount whose lab fits the lot", () => {
    for (const n of [2, 3, 6, 9, 12, 24]) expect(desksFor(labSize(n))).toBe(n);
    expect(desksFor({ w: 15, h: 14 })).toBe(6);
    expect(desksFor({ w: 14, h: 30 })).toBe(2);
  });
  it("is 0 when not even one desk fits, and caps at 24", () => {
    expect(desksFor({ w: 3, h: 3 })).toBe(0);
    expect(desksFor({ w: 40, h: 200 })).toBe(24);
  });
});
