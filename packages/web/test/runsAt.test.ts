import { describe, expect, it } from "vitest";
import { runsAtLabel } from "../src/format";

describe("runsAtLabel (scheduled assignments)", () => {
  it("shows the UTC time, with the day when it isn't today (UTC test env shows only UTC)", () => {
    const now = new Date("2026-10-29T15:00:00Z");
    const label = runsAtLabel("2026-10-29T20:45:00.000Z", now);
    expect(label).toContain("20:45 UTC");
    if (new Date().getTimezoneOffset() === 0) expect(label).toBe("20:45 UTC");
    expect(runsAtLabel("2026-10-30T01:00:00.000Z", now)).toContain("Fri 30 Oct, 01:00 UTC");
  });
});
