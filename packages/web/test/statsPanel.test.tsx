import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JoinFunnelView } from "../src/api";
import { byDay, COLUMNS, StatsView, waitLabel } from "../src/panels/StatsPanel";

const zero = { guestCardViews: 0, signIns: 0, asked: 0, letIn: 0, declined: 0 };
const one = (slug: string, daily: ({ day: string } & typeof zero)[], medianDecisionMs: number | null) => {
  const totals = Object.fromEntries(COLUMNS.map((c) => [c.key, daily.reduce((n, d) => n + d[c.key], 0)])) as typeof zero;
  return { slug, days: 30, from: "2026-10-03", to: "2026-11-01", daily, totals, decisions: medianDecisionMs == null ? 0 : 1, medianDecisionMs };
};
const workshop = one("workshop", [{ ...zero, day: "2026-10-29", guestCardViews: 12, signIns: 1 }, { ...zero, day: "2026-10-31", guestCardViews: 9 }], null);
const holly = one("hollyville", [{ ...zero, day: "2026-10-29", signIns: 1, asked: 1, letIn: 1 }], 14_987);
const root: JoinFunnelView = { days: 30, from: "2026-10-03", to: "2026-11-01", decisions: 1, medianDecisionMs: 14_987, totals: { guestCardViews: 21, signIns: 2, asked: 1, letIn: 1, declined: 0 }, collectives: [workshop, holly] };

describe("user stats panel", () => {
  it("sums the collectives' days, newest first", () => {
    expect(byDay(root)).toEqual([
      { ...zero, day: "2026-10-31", guestCardViews: 9 },
      { ...zero, day: "2026-10-29", guestCardViews: 12, signIns: 2, asked: 1, letIn: 1 },
    ]);
  });
  it("says a short wait in seconds, not rounded up to a minute", () => {
    expect(waitLabel(14_987)).toBe("15 s");
    expect(waitLabel(12 * 60_000)).toBe("12 min");
    expect(waitLabel(3 * 3_600_000)).toBe("3 h");
    expect(waitLabel(3 * 86_400_000)).toBe("3 days");
  });
  it("on the root server: totals, by day, per collective, what each number is, a JSON link", () => {
    const html = renderToStaticMarkup(<StatsView f={root} />);
    for (const s of ["Last 30 days", "By day", "Per collective", "What the numbers are", "/api/join-funnel", "Typical wait", "15 s", "hollyville", "Rough", "2026-10-31"]) expect(html).toContain(s);
    expect(html).not.toContain("sparkline");
  });
  it("a hosted collective (one collective in the answer) has no per-collective table", () => {
    const html = renderToStaticMarkup(<StatsView f={{ ...root, totals: holly.totals, collectives: [holly] }} />);
    expect(html).toContain("By day");
    expect(html).not.toContain("Per collective");
    expect(html).toContain("15 s");
  });
});
