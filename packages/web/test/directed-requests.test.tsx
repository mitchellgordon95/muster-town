import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectedBySource, DirectedSourceRow } from "../src/api";
import { DirectedRequests } from "../src/panels/BankSpending";

// gr_k71b7b6px7 (kr_8hg2tg1cvc): "Asked for by humans" on Bank › Spending, the directed lane by request
const req = (i: number, extra: Partial<DirectedSourceRow> = {}): DirectedSourceRow => ({
  id: `mt_r${i}`, kind: "meeting", title: `Request ${i}`, at: "2026-11-20T10:00:00.000Z", askedById: "us_m", askedBy: "Mitchell",
  tokens: 1_000_000 - i * 10_000, usd: 20, sessions: 3, assignments: 2, buildings: [{ id: "workshop", name: "Town Workshop" }], ...extra,
});
const rows = [...Array.from({ length: 11 }, (_, i) => req(i + 1)), req(12, { id: "ms_t", kind: "tell", title: null })];
const tokens = rows.reduce((t, r) => t + r.tokens, 0);
const d: DirectedBySource = {
  rows,
  byAsker: [{ askedById: "us_m", askedBy: "Mitchell", tokens: tokens + 5_000, usd: 240.1, sessions: 37, assignments: 25, requests: 12 }],
  untraced: { tokens: 5_000, usd: 0.1, sessions: 1, assignments: 1 },
  total: { tokens: tokens + 5_000, usd: 240.1, sessions: 37, assignments: 25, requests: 12 },
  check: { ok: true, diff: 0, identity: "Σ requests + untraced = the directed lane (every building)" },
};

describe("Asked for by humans on Bank › Spending", () => {
  it("lists the costliest 10 requests with title, asker, assignments, tokens and dollars, then a toggle for the rest", () => {
    const html = renderToStaticMarkup(<DirectedRequests d={d} />);
    expect(html).toContain("Asked for by humans");
    expect(html.match(/class="directed-request"/g)).toHaveLength(10);
    expect(html).toContain("Request 1<");
    expect(html).not.toContain("Request 11<");
    expect(html).toContain("Show all 12 requests");
    expect(html).toContain("Mitchell");
    expect(html).toContain("990,000");
    expect(html).toContain("$20.00");
  });

  it("shows every request when open, a tell without its private text, the untraced row, per-human totals and the ✓ line", () => {
    const html = renderToStaticMarkup(<DirectedRequests d={d} initialOpen />);
    expect(html.match(/class="directed-request"/g)).toHaveLength(12);
    expect(html).toContain("A tell (private message)");
    expect(html).toContain("No request recorded");
    expect(html).toContain("Total, 12 requests");
    expect(html).toContain("By human:");
    expect(html).toContain("12 requests");
    expect(html).toContain("✓ Requests");
    expect(html).toContain("the directed lane");
  });

  it("marks a failed check", () => {
    const html = renderToStaticMarkup(<DirectedRequests d={{ ...d, check: { ok: false, diff: 42, identity: "x" } }} />);
    expect(html).toContain("✗");
    expect(html).toContain("differs by 42");
  });
});
