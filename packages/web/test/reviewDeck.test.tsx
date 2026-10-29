import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewSlide } from "@muster-town/schema";
import { ReviewAsDeckButton } from "../src/panels/Places";
import { SlideDecision, landingSlide, nextSlideKey } from "../src/panels/ReviewDeck";
import { DeckSlides } from "../src/panels/DeckView";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span> }));

const s = (key: string, itemId: string | null, extra: Partial<ReviewSlide> = {}): ReviewSlide =>
  ({ key, itemId, kind: "rollup", group: 5, buildingId: null, since: null, waiters: 0, history: "", text: `## ${key}`, notes: "", title: key, pictures: [], ...extra });
const SLIDES = [s("town", null, { kind: "town", group: 0 }), s("proposal:gr_a", "gr_a", { kind: "proposal", grantId: "gr_a" }), s("rollup:dc_r:1", "dc_r"), s("rollup:dc_r:3", "dc_r"), s("record", null, { kind: "record", docIds: ["dc_x", "dc_y"] })];

describe("review deck in the Town Hall in-tray (design dc_y7a8g257of §2)", () => {
  it("the in-tray header has a Review as deck button", () => {
    const html = renderToStaticMarkup(<ReviewAsDeckButton count={4} onOpen={() => undefined} />);
    expect(html).toContain("Review as deck");
    expect(html).toContain("4 waiting");
  });
  it("deciding moves to the next item's slide: a rollup's other item slides go with it; the deck reloads onto that key", () => {
    expect(nextSlideKey(SLIDES, 2)).toBe("rollup:dc_r:1");
    expect(nextSlideKey(SLIDES, 3)).toBe("record");
    expect(nextSlideKey(SLIDES, 5)).toBeNull();
    const after = SLIDES.filter((x) => x.itemId !== "gr_a");
    expect(landingSlide(after, "rollup:dc_r:1", 2)).toBe(2);
    expect(landingSlide(after.slice(0, 1), "record", 4)).toBe(1); // gone: clamp
  });
  it("the slide shows its decision buttons under it: Approve all on For the record; a decided item says so", () => {
    const html = renderToStaticMarkup(
      <DeckSlides deck={{ title: "Review deck", slides: SLIDES }} n={5} go={() => undefined}>
        <SlideDecision slide={SLIDES[4]!} n={5} grants={[]} reports={[]} onDecided={() => undefined} onOpenDoc={() => undefined} />
      </DeckSlides>,
    );
    expect(html).toContain("5 / 5");
    expect(html).toContain("Approve all");
    expect(renderToStaticMarkup(<SlideDecision slide={SLIDES[1]!} n={2} grants={[]} reports={[]} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("Already decided");
  });
});
