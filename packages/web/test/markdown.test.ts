import { describe, expect, it } from "vitest";
import { docIdParts, docIdsIn, isGrantId, markdownHtml } from "../src/panels/Markdown";

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
  it("splits grant ids out too, so a proposal can be clicked through from a report or chat", () => {
    expect(docIdParts("fund gr_jqsqra0dlx (see dc_k955hun6c4)")).toEqual(["fund ", { id: "gr_jqsqra0dlx" }, " (see ", { id: "dc_k955hun6c4" }, ")"]);
    expect(docIdParts("gr_short and as_s1n1xknj8n stay text")).toEqual(["gr_short and as_s1n1xknj8n stay text"]);
    expect(isGrantId("gr_jqsqra0dlx")).toBe(true);
    expect(isGrantId("dc_k955hun6c4")).toBe(false);
  });
});

describe("docIdParts: every id with a panel (kr_utx7pmv1yk)", () => {
  it("splits meeting, agent, building, key result and media ids out", () => {
    const parts = docIdParts("mt_aaaaaaaaaa ag_bbbbbbbbbb bl_cccccccccc kr_dddddddddd mf_eeeeeeeeee");
    expect(parts.filter((p) => typeof p !== "string")).toEqual([{ id: "mt_aaaaaaaaaa" }, { id: "ag_bbbbbbbbbb" }, { id: "bl_cccccccccc" }, { id: "kr_dddddddddd" }, { id: "mf_eeeeeeeeee" }]);
  });
  it("leaves assignment and session ids as text until they have a panel (step 2)", () => {
    expect(docIdParts("as_aaaaaaaaaa se_bbbbbbbbbb")).toEqual(["as_aaaaaaaaaa se_bbbbbbbbbb"]);
  });
});

describe("docIdsIn", () => {
  it("lists each cited doc id once, in order of first mention", () => {
    expect(docIdsIn("dc_k955hun6c4 then dc_r3d2hrkvhf, dc_k955hun6c4 again")).toEqual(["dc_k955hun6c4", "dc_r3d2hrkvhf"]);
  });
  it("is empty for a draft with no doc id", () => {
    expect(docIdsIn("hello dc_ world")).toEqual([]);
  });
  it("lists docs only: a grant id has no title to preview", () => {
    expect(docIdsIn("gr_jqsqra0dlx and dc_k955hun6c4")).toEqual(["dc_k955hun6c4"]);
  });
});
