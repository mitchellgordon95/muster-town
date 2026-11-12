// gr_rcj8nkbkbt (kr_ay5wb5wfhd): the public Uptime block at the Bank server rack and on the signed-out landing
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UptimeView, dayColor, type UptimeData } from "../src/panels/Uptime";

const day = (date: string, up: number, down: number, unknown: number) => ({ date, up, down, unknown, pct: up + down ? Math.round((1000 * up) / (up + down)) / 10 : null });
const u: UptimeData = {
  at: "2026-11-12T12:00:00.000Z", days: 3, pct: 99.8, coverage: 80, up: 2000, down: 4, unknown: 500, lastProbeAt: "2026-11-12T11:59:00.000Z",
  byDay: [day("2026-11-10", 0, 0, 1440), day("2026-11-11", 1436, 4, 0), day("2026-11-12", 564, 0, 156)],
  outages: [{ from: "2026-11-11T03:00:00.000Z", to: "2026-11-11T03:04:00.000Z", minutes: 4 }],
  restarts: [{ from: "2026-11-11T03:00:10.000Z", to: "2026-11-11T03:00:40.000Z", seconds: 30, kind: "redeploy" }],
};

describe("Uptime block", () => {
  it("shows the percentage, one cell per day and the outages", () => {
    const html = renderToStaticMarkup(<UptimeView u={u} />);
    expect(html).toContain("99.8%</b> up over the last 3 days");
    expect(html).toContain("80% of minutes measured");
    expect(html.match(/class="uptime-day"/g)).toHaveLength(3);
    expect(html).toContain("2026-11-10: not measured");
    expect(html).toContain("Down 2026-11-11 03:00 → 2026-11-11 03:04 UTC (4 min)");
    expect(html).toContain("1 restart in the window.");
    expect(html).toContain('href="/api/uptime"');
  });
  it("never colours an unmeasured day as up, and says so before any probe", () => {
    expect(dayColor(null)).toBe("var(--faint)");
    expect([dayColor(100), dayColor(99.5), dayColor(90)]).toEqual(["var(--ok)", "var(--amber)", "var(--bad)"]);
    const none = renderToStaticMarkup(<UptimeView u={{ ...u, pct: null, coverage: 0, outages: [], restarts: [], byDay: [day("2026-11-12", 0, 0, 720)] }} />);
    expect(none).toContain("Not measured yet");
    expect(none).not.toContain("No outages");
  });
});
