import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngagementView as Engagement, HealthLineView, JoinFunnelView, TownHealthView } from "../src/api";
import { byDay, COLUMNS, ENGAGEMENT_COLUMNS, EngagementView, HealthView, healthRed, MembersTable, StatsView, waitLabel } from "../src/panels/StatsPanel";

const zero = { homeViews: 0, guestCardViews: 0, guestVisitors: 0, signInStarted: 0, signIns: 0, asked: 0, letIn: 0, declined: 0, acted: 0 };
const one = (slug: string, daily: ({ day: string } & typeof zero)[], medianDecisionMs: number | null) => {
  const totals = Object.fromEntries(COLUMNS.map((c) => [c.key, daily.reduce((n, d) => n + d[c.key], 0)])) as typeof zero;
  return { slug, days: 30, from: "2026-10-03", to: "2026-11-01", daily, totals, decisions: medianDecisionMs == null ? 0 : 1, medianDecisionMs };
};
const workshop = one("workshop", [{ ...zero, day: "2026-10-29", guestCardViews: 12, signIns: 1 }, { ...zero, day: "2026-10-31", guestCardViews: 9 }], null);
const holly = one("hollyville", [{ ...zero, day: "2026-10-29", signIns: 1, asked: 1, letIn: 1 }], 14_987);
const root: JoinFunnelView = { days: 30, from: "2026-10-03", to: "2026-11-01", decisions: 1, medianDecisionMs: 14_987, totals: { ...zero, guestCardViews: 21, signIns: 2, asked: 1, letIn: 1 }, collectives: [workshop, holly] };

const none = { humans: 0, spoke: 0, oneOnOnes: 0, flags: 0, decisions: 0, asked: 0, letIn: 0, declined: 0, acted: 0 };
const eng: Engagement = {
  days: 30, from: "2026-10-03", to: "2026-11-01", medianDecisionMs: 14_987,
  daily: [{ ...none, day: "2026-10-29", humans: 2, spoke: 7, flags: 1, decisions: 3 }, { ...none, day: "2026-10-31", humans: 1, oneOnOnes: 1, asked: 1, letIn: 1, acted: 1 }],
  totals: { ...none, humans: 2, spoke: 7, oneOnOnes: 1, flags: 1, decisions: 3, asked: 1, letIn: 1, acted: 1 },
};

describe("user stats panel", () => {
  it("engagement (flag dc_r7u6bkaei4): this collective's own counts, 6-9 columns, newest day first, no Muster-Town-wide funnel steps", () => {
    expect(ENGAGEMENT_COLUMNS.length).toBeGreaterThanOrEqual(6);
    expect(ENGAGEMENT_COLUMNS.length).toBeLessThanOrEqual(9);
    const html = renderToStaticMarkup(<EngagementView e={eng} />);
    for (const s of ["This collective, last 30 days", "in this collective only", "Humans", "Spoke", "1:1s", "Flags", "Decisions", "Asked", "Let in", "Declined", "Acted", "Typical wait", "15 s", "/api/engagement", "names nobody"]) expect(html).toContain(s);
    for (const s of ["Pressed Sign in", "Saw card", "homepage", "Per collective"]) expect(html).not.toContain(s);
    expect(html.indexOf("Oct 31")).toBeLessThan(html.indexOf("Oct 29"));
    expect(renderToStaticMarkup(<EngagementView e={{ ...eng, daily: [], totals: none }} />)).toContain("No human did anything here");
  });
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
    for (const s of ["Last 30 days", "By day", "Per collective", "What the numbers are", "/api/join-funnel", "Typical wait", "15 s", "hollyville", "Visitors", "Pressed Sign in", "headless browsers", "Oct 31"]) expect(html).toContain(s);
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
    expect(html.match(/>Grant</g)).toHaveLength(1);
    expect(html).toContain(`Grant gives direct work under “${goal.short}”`);
    expect(html.match(/>Revoke</g)).toHaveLength(1);
    // nobody can grant (no default goal): no Grant button at all, Revoke still there
    const noGoal = renderToStaticMarkup(<MembersTable members={members} goal={null} onGrant={noop} onRevoke={noop} />);
    expect(noGoal).not.toContain(">Grant<");
    expect(noGoal).toContain("Revoke");
    expect(renderToStaticMarkup(<MembersTable members={[]} goal={goal} onGrant={noop} onRevoke={noop} />)).toContain("Nobody has been let in yet");
  });

  it("town health (gr_8bxoy2heif): tiles red past threshold, per report by lane, day and week tables", () => {
    const line = (paper: number | null, hit: number | null): HealthLineView => ({ sessions: 4, tokens: 200_000, paperworkTokens: 30_000, paperworkShare: paper, cacheRead: 7, cacheWrite: 3, hitRatio: hit, medianCacheWrite: 61_000, overrunTokens: 25_000, reports: 2, perReport: 100_000, byLane: { grant: { tokens: 150_000, reports: 1, perReport: 150_000 } } });
    const t = { paperworkMax: 0.15, hitMin: 0.7 };
    const h: TownHealthView = {
      from: "2026-10-19", to: "2026-11-10T20:00:00Z", thresholds: t, last24h: line(0.2, 0.6),
      days: [{ day: "2026-11-09", ...line(0.1, 0.8) }, { day: "2026-11-10", ...line(0.2, 0.6) }], weeks: [{ week: "2026-11-09", ...line(0.12, 0.75) }],
      notCounted: { sessions: 2, tokens: 9000 },
      definitions: { paperwork: "P def", hitRatio: "H def", medianCacheWrite: "M def", overrun: "O def", perReport: "R def" },
    };
    expect(healthRed(line(0.2, 0.6), t)).toEqual({ paperwork: true, hits: true });
    expect(healthRed(line(0.1, 0.8), t)).toEqual({ paperwork: false, hits: false });
    expect(healthRed(line(null, null), t)).toEqual({ paperwork: false, hits: false });
    const html = renderToStaticMarkup(<HealthView h={h} />);
    for (const s of ["Town health, last 24 hours", "Paperwork", "Cache hits", "Median cache write", "Past 100% holds", "Tokens / report", "grant 150k (1)", "By day", "By week", "/api/health-stats", "2 back-filled sessions", "P def"]) expect(html).toContain(s);
    expect(html).toContain('stats-total bad');
    expect(html.indexOf("Nov 10")).toBeLessThan(html.indexOf("Nov 9"));
  });
});
