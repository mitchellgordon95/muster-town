import { describe, expect, it } from "vitest";
import { exportBaseline, FIRST_EXPORT_DELAY_MS } from "../src/index.ts";

const HOUR = 3_600_000;
const boot = Date.parse("2026-11-10T19:15:00Z");

describe("exportBaseline (the hourly export survives restarts)", () => {
  it("counts the hour from the last export.done, not from boot", () => {
    const last = "2026-11-10T18:40:00Z";
    expect(exportBaseline(last, boot)).toBe(Date.parse(last));
    // next export due at 19:40, 25 min after this boot, not 20:15
    expect(exportBaseline(last, boot) + HOUR - boot).toBe(25 * 60_000);
  });
  it("an export older than an hour is due at the first tick", () => {
    expect(exportBaseline("2026-11-10T17:27:44Z", boot) + HOUR).toBeLessThan(boot);
  });
  it("a world that never exported exports a few minutes after boot", () => {
    expect(exportBaseline(null, boot) + HOUR - boot).toBe(FIRST_EXPORT_DELAY_MS);
  });
  it("a future or unreadable ts never delays past boot", () => {
    expect(exportBaseline("2026-11-11T00:00:00Z", boot)).toBe(boot);
    expect(exportBaseline("garbage", boot) + HOUR - boot).toBe(FIRST_EXPORT_DELAY_MS);
  });
});
