import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RollupCards, rollupCardsOf } from "../src/panels/RollupCards";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div> }));

const BODY = "Live: 869f76d.\n\n## Shipped\n\n**1. Spend chart**\n**What it is:** the Bank's day in one bar.\n**What you'd see:** Map → Bank, top.\n![The Bank page](/api/media/mf_4flit5fmtz.png)\n**Your call:** Continue gr_x.\n\n## Decided\n- dc_a → approved\n\n## Key results\n| KR | status |\n|---|---|\n| kr_x | on-track |\n\n## Needs from Mitchell\nNothing needed.";

describe("rollup cards in the Town Hall in-tray (1:1 mt_vcn0e66r1t)", () => {
  it("a labelled rollup renders each Shipped item as a card, with the rest of the body around it", () => {
    const parsed = rollupCardsOf({ body: BODY, tags: ["rollup"] })!;
    expect(parsed).not.toBeNull();
    const html = renderToStaticMarkup(<RollupCards parsed={parsed} full />);
    expect(html).toContain('class="rollup-card"');
    for (const s of ["What it is", "What you&#x27;d see", "Your call", "Spend chart", "the Bank&#x27;s day in one bar", "![The Bank page](/api/media/mf_4flit5fmtz.png)", "Continue gr_x.", "## Decided", "Nothing needed."]) expect(html).toContain(s);
    expect(html).toContain("Live: 869f76d.");
    // the in-tray row shows just the cards
    expect(renderToStaticMarkup(<RollupCards parsed={parsed} />)).not.toContain("Decided");
  });
  it("falls back to plain markdown: not a rollup, an old-style rollup, or an item without the labels", () => {
    expect(rollupCardsOf({ body: BODY, tags: [] })).toBeNull();
    expect(rollupCardsOf({ body: "## Shipped\n- 41236ee\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nx", tags: ["rollup"] })).toBeNull();
    expect(rollupCardsOf({ body: BODY.replace("**Your call:** Continue gr_x.", "Continue gr_x."), tags: ["rollup"] })).toBeNull();
  });
});
