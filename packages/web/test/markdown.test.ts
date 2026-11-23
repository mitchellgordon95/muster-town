// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { api, getApi } from "../src/api";
import { docIdParts, docIdsIn, idLabel, isGrantId, loadKrTexts, markdownHtml, rememberAssignmentTitle, rememberGrant, sanitize } from "../src/panels/Markdown";

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
    expect(docIdParts("gr_short and as_short stay text")).toEqual(["gr_short and as_short stay text"]);
    expect(isGrantId("gr_jqsqra0dlx")).toBe(true);
    expect(isGrantId("dc_k955hun6c4")).toBe(false);
  });
});

describe("docIdParts: every id with a panel (kr_utx7pmv1yk)", () => {
  it("splits meeting, agent, building, key result and media ids out", () => {
    const parts = docIdParts("mt_aaaaaaaaaa ag_bbbbbbbbbb bl_cccccccccc kr_dddddddddd mf_eeeeeeeeee");
    expect(parts.filter((p) => typeof p !== "string")).toEqual([{ id: "mt_aaaaaaaaaa" }, { id: "ag_bbbbbbbbbb" }, { id: "bl_cccccccccc" }, { id: "kr_dddddddddd" }, { id: "mf_eeeeeeeeee" }]);
  });
  it("splits assignment and session ids out (step 2: an assignment card, a session panel)", () => {
    expect(docIdParts("as_aaaaaaaaaa se_bbbbbbbbbb")).toEqual([{ id: "as_aaaaaaaaaa" }, " ", { id: "se_bbbbbbbbbb" }]);
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

describe("idLabel", () => {
  it("labels a past meeting or an assignment the store doesn't hold by its fetched title", () => {
    expect(idLabel("mt_pastmeet01")).toBeNull();
    rememberAssignmentTitle("mt_pastmeet01", "1:1: Mitchell and Cleo");
    rememberAssignmentTitle("as_otherwork1", "Bank interior redesign");
    expect(idLabel("mt_pastmeet01")).toBe("1:1: Mitchell and Cleo");
    expect(idLabel("as_otherwork1")).toBe("Bank interior redesign");
  });
});

describe("grant, key result and goal ids read as names (gr_4upa0og9zc step 1)", () => {
  it("splits goal ids out: minted, a building's own and the root's named goals, not a longer word", () => {
    const parts = docIdParts("gl_1ds3wl2n78 gl_bl_t7slw19vgg gl_town, gl_join. gl_townhall");
    expect(parts.filter((p) => typeof p !== "string")).toEqual([{ id: "gl_1ds3wl2n78" }, { id: "gl_bl_t7slw19vgg" }, { id: "gl_town" }, { id: "gl_join" }]);
  });
  it("labels a grant by its title (its objective when it has none) and its archived key results by their text", () => {
    expect(idLabel("gr_4upa0og9zc")).toBeNull();
    rememberGrant({ id: "gr_4upa0og9zc", title: "Every id reads as its name", objective: "A human sees names", keyResults: [{ id: "kr_x4cc0w6wac", text: "Grant ids read as their names" }] });
    rememberGrant({ id: "gr_untitled01", title: "", objective: "An old grant with no short name" });
    expect(idLabel("gr_4upa0og9zc")).toBe("Every id reads as its name");
    expect(idLabel("gr_untitled01")).toBe("An old grant with no short name");
    expect(idLabel("kr_x4cc0w6wac")).toBe("Grant ids read as their names");
  });
  it("labels a goal by its text from the goal tree", async () => {
    await getApi();
    const node = (id: string, text: string, children: unknown[] = []) => ({ id, text, keyResults: [], children });
    vi.spyOn(api(), "goalTree").mockResolvedValue(node("gl_town", "Make Muster Town something strangers can fund", [node("gl_bl_t7slw19vgg", "Make Muster Town beautiful and intuitive")]) as never);
    await loadKrTexts();
    expect(idLabel("gl_bl_t7slw19vgg")).toBe("Make Muster Town beautiful and intuitive");
    expect(idLabel("gl_town")).toBe("Make Muster Town something strangers can fund");
    expect(idLabel("gl_unknownxxx")).toBeNull();
  });
  it("renders the names in a report's markdown, the id kept in the tooltip", () => {
    const html = sanitize(markdownHtml("Under gl_bl_t7slw19vgg the grant gr_4upa0og9zc moved kr_x4cc0w6wac."));
    expect(html).toContain(">Make Muster Town beautiful and intuitive</a>");
    expect(html).toContain('title="goal gl_bl_t7slw19vgg: Make Muster Town beautiful and intuitive"');
    expect(html).toContain('title="grant gr_4upa0og9zc: Every id reads as its name"');
    expect(html).toContain(">Grant ids read as their names</a>");
  });
});
