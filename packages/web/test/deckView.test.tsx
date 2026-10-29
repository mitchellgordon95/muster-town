import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDeck } from "@muster-town/schema";
import { DeckSlides, clampSlide, slideForKey } from "../src/panels/DeckView";
import { slideHash, slideOfHash } from "../src/route";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div> }));

const BODY = "# Demo deck\nHello\nNotes: budget first\n---\n## Two\n![shot](/api/media/mf_a.png)\n---\n## Three\n```\n---\n```";

describe("deck viewer (design dc_y7a8g257of §1)", () => {
  it("shows one slide, the n / count counter and one dot per slide; Notes stay hidden unless asked", () => {
    const deck = parseDeck(BODY);
    const html = renderToStaticMarkup(<DeckSlides deck={deck} n={2} go={() => undefined} />);
    expect(html).toContain("2 / 3");
    expect(html).toContain("![shot](/api/media/mf_a.png)");
    expect(html).not.toContain("Hello");
    expect(html.match(/class="deck-dot( on)?"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Slide 3: Three"');
    expect(renderToStaticMarkup(<DeckSlides deck={deck} n={1} go={() => undefined} />)).not.toContain("budget first");
    expect(renderToStaticMarkup(<DeckSlides deck={deck} n={1} go={() => undefined} showNotes />)).toContain("budget first");
  });
  it("an empty deck says how to split slides", () => {
    expect(renderToStaticMarkup(<DeckSlides deck={parseDeck("")} n={1} go={() => undefined} />)).toContain("no slides yet");
  });
  it("keys: → PgDn space forward, ← PgUp shift-space back, Home/End jump, clamped at the ends", () => {
    expect(["ArrowRight", "PageDown", " "].map((k) => slideForKey(k, false, 2, 3))).toEqual([3, 3, 3]);
    expect(["ArrowLeft", "PageUp"].map((k) => slideForKey(k, false, 2, 3))).toEqual([1, 1]);
    expect(slideForKey(" ", true, 2, 3)).toBe(1);
    expect(slideForKey("ArrowRight", false, 3, 3)).toBe(3);
    expect(slideForKey("ArrowLeft", false, 1, 3)).toBe(1);
    expect([slideForKey("Home", false, 3, 7), slideForKey("End", false, 1, 7)]).toEqual([1, 7]);
    expect(slideForKey("x", false, 1, 3)).toBeNull();
  });
  it("the URL names the slide: #/doc/<id>/<n>, slide 1 is the bare doc link", () => {
    expect(slideHash("dc_x", 1)).toBe("#/doc/dc_x");
    expect(slideHash("dc_x", 4)).toBe("#/doc/dc_x/4");
    expect(slideOfHash("#/doc/dc_x/4", "dc_x")).toBe(4);
    expect(slideOfHash("#/doc/dc_x", "dc_x")).toBe(1);
    expect(slideOfHash("#/doc/dc_y/4", "dc_x")).toBeNull();
    expect(slideOfHash("", "dc_x")).toBeNull();
    expect([clampSlide(9, 3), clampSlide(0, 3), clampSlide(2, 0)]).toEqual([3, 1, 1]);
  });
});
