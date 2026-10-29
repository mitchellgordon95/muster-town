import { parseDeck } from "@muster-town/schema";
import { describe, expect, it } from "vitest";

describe("deck docs (design dc_y7a8g257of §1)", () => {
  it("an empty deck has no slides and no title", () => {
    expect(parseDeck("")).toEqual({ title: null, slides: [] });
    expect(parseDeck("\n---\n\n---\n")).toEqual({ title: null, slides: [] });
  });
  it("one slide: the # heading is the deck title", () => {
    const d = parseDeck("# Review deck\n\nFive items today.");
    expect(d.title).toBe("Review deck");
    expect(d.slides).toEqual([{ text: "# Review deck\n\nFive items today.", notes: "", title: "Review deck", pictures: [] }]);
  });
  it("splits on a line ---, but not on --- inside a code block", () => {
    const d = parseDeck("# Deck\n---\n## Two\n```yaml\n---\nkey: v\n---\n```\n---\n## Three\n~~~\n---\n~~~");
    expect(d.slides.map((s) => s.title)).toEqual(["Deck", "Two", "Three"]);
    expect(d.slides[1]!.text).toBe("## Two\n```yaml\n---\nkey: v\n---\n```");
    expect(d.slides[2]!.text).toBe("## Three\n~~~\n---\n~~~");
  });
  it("the last line Notes: … is presenter-only and cut from the shown text", () => {
    const d = parseDeck("# Deck\nHello\nNotes: say the budget first\n\n---\n## B\nNotes: mid-slide line\nbody\n");
    expect(d.slides[0]).toMatchObject({ text: "# Deck\nHello", notes: "say the budget first" });
    // only the last line counts
    expect(d.slides[1]).toMatchObject({ text: "## B\nNotes: mid-slide line\nbody", notes: "" });
  });
  it("keeps pictures in the text and lists them", () => {
    const d = parseDeck("# Deck\n---\n## Bank\n![The Bank panel](/api/media/mf_rrewqy3t6x.png)\n![clip](/api/media/mf_a1.webm)");
    expect(d.slides[1]!.text).toContain("![The Bank panel](/api/media/mf_rrewqy3t6x.png)");
    expect(d.slides[1]!.pictures).toEqual([{ alt: "The Bank panel", src: "/api/media/mf_rrewqy3t6x.png" }, { alt: "clip", src: "/api/media/mf_a1.webm" }]);
  });
  it("no # heading on the first slide: no deck title; CRLF bodies split the same", () => {
    expect(parseDeck("## Only h2\r\n---\r\nx").title).toBeNull();
    expect(parseDeck("## Only h2\r\n---\r\nx").slides).toHaveLength(2);
  });
});
