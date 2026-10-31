import { describe, expect, it } from "vitest";
import { smallDonationWarning } from "../src/panels/BankFunding";

const streams = { expectedSessionTokens: 120_000, sampleSessions: 89 };

describe("Donate: the small-donation warning (goal tree step 7)", () => {
  it("warns when a one-time donation covers no whole session, with the p90 and its basis", () => {
    const w = smallDonationWarning(50_000, "once", streams)!;
    expect(w).toMatch(/covers no whole session yet/);
    expect(w).toMatch(/p90 of 89 work sessions in the last 7 days/);
    expect(w).toMatch(/never runs a session; it waits/);
  });
  it("says how many days a recurring one takes to accrue one session", () => {
    expect(smallDonationWarning(50_000, "daily", streams)).toMatch(/about 3 days until it covers one/);
    expect(smallDonationWarning(50_000, "weekly", streams)).toMatch(/about 21 days/);
  });
  it("is silent when it covers a session, or before the size is known", () => {
    expect(smallDonationWarning(120_000, "once", streams)).toBeNull();
    expect(smallDonationWarning(1_000, "once", null)).toBeNull();
    expect(smallDonationWarning(Number.NaN, "once", streams)).toBeNull();
  });
  it("names a default when there are too few sessions", () => {
    expect(smallDonationWarning(1_000, "once", { expectedSessionTokens: 120_000, sampleSessions: 0 })).toMatch(/a typical work session/);
  });
});
