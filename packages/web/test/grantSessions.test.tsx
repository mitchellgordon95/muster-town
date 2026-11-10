import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantSessionList } from "../src/panels/GrantPanel";
import { MockApi } from "../src/mock/server";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));

// gr_4tf9hd64d5: a grant's page lists the sessions its tokens bought, and their sum closes on spentTokens
describe("a grant page's Sessions section", () => {
  it("one row per session (agent, assignment, model, adj. tokens, ≈ $, report or 'error, no report'); footer = spent ✓", async () => {
    const api = new MockApi();
    const g = await api.grant("gr_hud");
    const data = await api.grantSessions("gr_hud");
    expect(data.sessions).toHaveLength(3);
    expect(data.tokens).toBe(g.spentTokens);
    const html = renderToStaticMarkup(<GrantSessionList data={data} spentTokens={g.spentTokens} />);
    expect(html).toContain("3 sessions · 2,010,000 adj. tokens = spent ✓");
    expect(html).toContain("1,206,000 adj. tokens · ≈ $24.12");
    expect(html).toContain("error, no report");
    expect(html.match(/>report</g)).toHaveLength(2);
    expect(html).toContain("claude-opus-5-5");
  });

  it("a sum that differs from spentTokens shows a visible ✗ with both numbers", async () => {
    const data = await new MockApi().grantSessions("gr_hud");
    const html = renderToStaticMarkup(<GrantSessionList data={data} spentTokens={2_000_000} />);
    expect(html).toContain("3 sessions · 2,010,000 adj. tokens ✗ ≠ spent 2,000,000");
    expect(html).toContain("grant-sessions-total bad");
  });

  it("a running session says so, and no sessions reads 'No sessions yet.'", () => {
    const row = { id: "se_x", agentId: "ag_x", agentName: "Nell 1", assignmentTitle: "Step 1", status: "running", model: "claude-opus-5-5", adjustedOutputTokens: 10, usd: 0.0002, reportId: null, error: null, startedAt: "2026-11-03T02:48:00.000Z" };
    expect(renderToStaticMarkup(<GrantSessionList data={{ grantId: "gr_x", sessions: [row as never], tokens: 10, usd: 0 }} spentTokens={10} />)).toContain("· running");
    expect(renderToStaticMarkup(<GrantSessionList data={{ grantId: "gr_x", sessions: [], tokens: 0, usd: 0 }} spentTokens={0} />)).toContain("No sessions yet.");
  });
});
