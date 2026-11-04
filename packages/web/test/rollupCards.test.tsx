import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RollupCards, RollupReport, rollupCardsOf } from "../src/panels/RollupCards";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div> }));

const BODY = "Live: 869f76d.\n\n## Shipped\n\n**1. Spend chart**\n**What it is:** the Bank's day in one bar.\n**What you'd see:** Map → Bank, top.\n![The Bank page](/api/media/mf_4flit5fmtz.png)\n**Your call:** Continue gr_x.\n\n## Decided\n- dc_a → approved\n\n## Key results\n| KR | status |\n|---|---|\n| kr_x | on-track |\n\n## Needs from Mitchell\nNothing needed.";

describe("rollup cards in the Town Hall in-tray (1:1 mt_vcn0e66r1t)", () => {
  it("a labelled rollup renders each Shipped item as a card, with the rest of the body around it", () => {
    const parsed = rollupCardsOf({ body: BODY, tags: ["rollup"] })!;
    expect(parsed).not.toBeNull();
    const html = renderToStaticMarkup(<RollupReport parsed={parsed} />);
    expect(html).toContain('class="rollup-card"');
    for (const s of ["What it is", "What you&#x27;d see", "Your call", "Spend chart", "the Bank&#x27;s day in one bar", "![The Bank page](/api/media/mf_4flit5fmtz.png)", "Continue gr_x.", "dc_a → approved", "| kr_x | on-track |"]) expect(html).toContain(s);
    expect(html).toContain("Live: 869f76d.");
    // the in-tray row shows just the cards
    expect(renderToStaticMarkup(<RollupCards parsed={parsed} />)).not.toContain("Decided");
  });
  it("opens on the calls, folds the record (1:1 mt_i50xwu4z2t): the Your call block quotes each real call and the Needs lines; Decided and Key results sit in <details>; a None-only rollup says so", () => {
    const parsed = rollupCardsOf({ body: BODY.replace("Nothing needed.", "- Decide whether methane gets its own goal.\n\n_Already waiting in your in-tray: 1 proposal (gr_y)._"), tags: ["rollup"] })!;
    const html = renderToStaticMarkup(<RollupReport parsed={parsed} />);
    expect(html).toMatch(/rollup-top-head">Your calls \(2\)/);
    expect(html).toContain('title="Spend chart">item 1</span><div class="md">Continue gr_x.</div>');
    expect(html).toContain("Decide whether methane gets its own goal.");
    expect(html).toContain("Already waiting in your in-tray: 1 proposal (gr_y).");
    expect(html).not.toContain("Nothing needed");
    expect(html).toMatch(/<details class="rollup-fold"><summary>Decided · 1 report<\/summary>/);
    expect(html).toMatch(/<summary>Key results and spend<\/summary>/);
    // the call block comes before the cards, the folds after
    expect(html.indexOf("rollup-top")).toBeLessThan(html.indexOf("rollup-card"));
    expect(html.indexOf("rollup-card")).toBeLessThan(html.indexOf("rollup-fold"));
    const none = rollupCardsOf({ body: BODY.replace("Continue gr_x.", "None."), tags: ["rollup"] })!;
    const quiet = renderToStaticMarkup(<RollupReport parsed={none} />);
    expect(quiet).toContain("Nothing to decide");
    expect(quiet).not.toContain("rollup-card-call");
  });
  it("falls back to plain markdown: not a rollup, an old-style rollup, or an item without the labels", () => {
    expect(rollupCardsOf({ body: BODY, tags: [] })).toBeNull();
    expect(rollupCardsOf({ body: "## Shipped\n- 41236ee\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nx", tags: ["rollup"] })).toBeNull();
    expect(rollupCardsOf({ body: BODY.replace("**Your call:** Continue gr_x.", "Continue gr_x."), tags: ["rollup"] })).toBeNull();
  });
});
