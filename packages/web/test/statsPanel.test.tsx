import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JoinFunnelView } from "../src/api";
import { byDay, COLUMNS, MembersTable, StatsView, waitLabel } from "../src/panels/StatsPanel";

const zero = { guestCardViews: 0, signIns: 0, asked: 0, letIn: 0, declined: 0, acted: 0 };
const one = (slug: string, daily: ({ day: string } & typeof zero)[], medianDecisionMs: number | null) => {
  const totals = Object.fromEntries(COLUMNS.map((c) => [c.key, daily.reduce((n, d) => n + d[c.key], 0)])) as typeof zero;
  return { slug, days: 30, from: "2026-10-03", to: "2026-11-01", daily, totals, decisions: medianDecisionMs == null ? 0 : 1, medianDecisionMs };
};
const workshop = one("workshop", [{ ...zero, day: "2026-10-29", guestCardViews: 12, signIns: 1 }, { ...zero, day: "2026-10-31", guestCardViews: 9 }], null);
const holly = one("hollyville", [{ ...zero, day: "2026-10-29", signIns: 1, asked: 1, letIn: 1 }], 14_987);
const root: JoinFunnelView = { days: 30, from: "2026-10-03", to: "2026-11-01", decisions: 1, medianDecisionMs: 14_987, totals: { guestCardViews: 21, signIns: 2, asked: 1, letIn: 1, declined: 0, acted: 0 }, collectives: [workshop, holly] };

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
    for (const s of ["Last 30 days", "By day", "Per collective", "What the numbers are", "/api/join-funnel", "Typical wait", "15 s", "hollyville", "Rough", "Oct 31"]) expect(html).toContain(s);
    expect(html).not.toContain("sparkline");
  });
  it("a hosted collective (one collective in the answer) has no per-collective table", () => {
    const html = renderToStaticMarkup(<StatsView f={{ ...root, totals: holly.totals, collectives: [holly] }} />);
    expect(html).toContain("By day");
    expect(html).not.toContain("Per collective");
    expect(html).toContain("15 s");
  });
  it("members table: each let-in member with their goal or none, one Grant per member without it, a Revoke per held goal", () => {
    const goal = { id: "gl_town", text: "Make Muster Town something strangers can fund, join, and trust", short: "Make Muster Town something strangers…" };
    const members = [
      { userId: "us_pat", name: "Pat Lee", githubLogin: "patlee", avatarUrl: null, letInAt: "2026-11-01T01:00:00.000Z", direct: [] },
      { userId: "us_sam", name: "Sam", githubLogin: null, avatarUrl: null, letInAt: null, direct: [{ goalId: "gl_town", text: goal.text, grantedBy: "us_mitchell", createdAt: "2026-11-01T02:00:00.000Z" }] },
    ];
    const noop = async () => {};
    const html = renderToStaticMarkup(<MembersTable members={members} goal={goal} onGrant={noop} onRevoke={noop} />);
    expect(html).toContain("@patlee");
    expect(html).toContain("none");
    expect(html).toContain("Sam");
    expect(html).toContain(goal.short);
    expect(html.match(/>Grant /g)).toHaveLength(1);
    expect(html.match(/>Revoke</g)).toHaveLength(1);
    // nobody can grant (no default goal): no Grant button at all, Revoke still there
    const noGoal = renderToStaticMarkup(<MembersTable members={members} goal={null} onGrant={noop} onRevoke={noop} />);
    expect(noGoal).not.toContain(">Grant ");
    expect(noGoal).toContain("Revoke");
    expect(renderToStaticMarkup(<MembersTable members={[]} goal={goal} onGrant={noop} onRevoke={noop} />)).toContain("Nobody has been let in yet");
  });
});
