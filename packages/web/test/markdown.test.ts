import { describe, expect, it } from "vitest";
import { docIdParts, markdownHtml } from "../src/panels/Markdown";

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

describe("docIdParts", () => {
  it("splits bare doc ids out of text", () => {
    expect(docIdParts("see dc_k955hun6c4, and dc_r3d2hrkvhf.")).toEqual(["see ", { id: "dc_k955hun6c4" }, ", and ", { id: "dc_r3d2hrkvhf" }, "."]);
  });
  it("leaves text without a full id alone", () => {
    expect(docIdParts("dc_short and xdc_k955hun6c4 and dc_k955hun6c4x")).toEqual(["dc_short and xdc_k955hun6c4 and dc_k955hun6c4x"]);
  });
});
