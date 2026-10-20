import { describe, expect, it } from "vitest";
import { markdownHtml } from "../src/panels/Markdown";

describe("markdownHtml", () => {
  it("keeps a single newline as a soft wrap by default (docs)", () => {
    expect(markdownHtml("one\ntwo")).not.toContain("<br");
  });
  it("turns a single newline into <br> with breaks (Talk bubbles)", () => {
    expect(markdownHtml("one\ntwo", true)).toMatch(/one<br\s*\/?>\s*two/);
  });
  it("still renders lists and emphasis with breaks", () => {
    const html = markdownHtml("**PR** ready:\n- a\n- b", true);
    expect(html).toContain("<strong>PR</strong>");
    expect(html).toMatch(/<li>a<\/li>\s*<li>b<\/li>/);
  });
});
