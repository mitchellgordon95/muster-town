import { describe, expect, it } from "vitest";
import { creditsLeftLine, timesTotalLine } from "../src/panels/BankFunding";

describe("Donate: a recurring key limited to N credits (1:1 mt_p3ge56kg03)", () => {
  it("shows the total as the donor types", () => {
    expect(timesTotalLine(1_000_000, 3, "daily")).toBe("3 × 1,000,000 = 3,000,000 adj. tokens over 3 days");
    expect(timesTotalLine(500_000, 1, "weekly")).toBe("1 × 500,000 = 500,000 adj. tokens over 1 week");
    expect(timesTotalLine(1_000_000, 0, "daily")).toBeNull();
    expect(timesTotalLine(1_000_000, 2.5, "daily")).toBeNull();
    expect(timesTotalLine(1_000_000, 3, "once")).toBeNull();
  });
  it("the source card says how many credits are left and when the next is", () => {
    expect(creditsLeftLine({ creditsTotal: 3, creditsLeft: 2, nextCreditAt: "2026-11-02T12:00:00.000Z", cancelledAt: null })).toBe("2 of 3 credits left, next on 2026-11-02");
    expect(creditsLeftLine({ creditsTotal: 3, creditsLeft: 0, nextCreditAt: null })).toBe("all 3 credits made");
    expect(creditsLeftLine({ creditsTotal: 3, creditsLeft: 1, nextCreditAt: null, cancelledAt: "2026-11-01T00:00:00.000Z" })).toBe("1 of 3 credits left");
    expect(creditsLeftLine({ creditsTotal: null, creditsLeft: null })).toBeNull();
    expect(creditsLeftLine({})).toBeNull();
  });
});
