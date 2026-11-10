import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FinanceSpend, SpendNode } from "../src/api";
import { noGrantCheckLine, noGrantLine } from "../src/panels/BankFinance";
import { LaneLine } from "../src/panels/BankSpending";

// gr_utygatbi85: the Spending tab's sentence on the non-grant half and the line under a lane's assignment rows
const lane = (tokens: number, assignments = 1) => ({ tokens, sessions: 1, usd: 0, assignments });
const sp = {
  noGrant: {
    tokens: 62_900_000, sessions: 1000, usd: 1,
    byLane: { directed: lane(34_700_000), exploration: lane(4_800_000), retainer: lane(0), manager: lane(400_000), before: lane(23_000_000) },
    exploration: { assignments: 12, proposals: 5, funded: 3, rejected: 1, withdrawn: 0, open: 1 },
    directed: { assignments: 500, withSource: 300, withAsker: 450 },
  },
  noGrantCheck: { ok: true, diff: 0, identity: "x" },
} as unknown as FinanceSpend;
const row = (extra: Partial<SpendNode>): SpendNode => ({ kind: "assignment", id: "as_x", name: "x", tokens: 1, share: 0, sessions: 1, ...extra });

describe("non-grant lanes on Bank › Spending", () => {
  it("says in one sentence how the non-grant half splits, leaving out empty lanes", () => {
    expect(noGrantLine(sp)).toBe("Of 62,900,000 adj. tokens not under a grant: 34,700,000 asked for by humans, 4,800,000 exploration (12 runs, 5 became proposals, 3 funded), 400,000 managers' assigned work, 23,000,000 from before lanes.");
    expect(noGrantLine({} as FinanceSpend)).toBeNull();
    expect(noGrantCheckLine(sp)).toEqual({ ok: true, text: 'The server checked that the lane rows add up to the "Not under a grant" rows, 62,900,000 tokens.' });
  });

  it("names who asked and the source on a directed row, the proposal and its state on an exploration row", () => {
    expect(renderToStaticMarkup(<LaneLine r={row({ source: { id: "mt_abc", kind: "meeting", askedById: "us_m", askedBy: "Mitchell" } })} />)).toContain("asked by Mitchell");
    expect(renderToStaticMarkup(<LaneLine r={row({ source: { id: "mt_abc", kind: "meeting", askedById: "us_m", askedBy: "Mitchell" } })} />)).toContain("mt_abc");
    expect(renderToStaticMarkup(<LaneLine r={row({ source: { id: null, kind: null, askedById: null, askedBy: null } })} />)).toContain("who asked is not recorded");
    const p = renderToStaticMarkup(<LaneLine r={row({ proposal: { id: "gr_a", title: "Plan A", state: "funded" } })} />);
    expect(p).toContain('href="#/grant/gr_a"');
    expect(p).toContain("funded");
    expect(renderToStaticMarkup(<LaneLine r={row({ proposal: null })} />)).toContain("no proposal");
    expect(renderToStaticMarkup(<LaneLine r={row({})} />)).toBe("");
  });
});
