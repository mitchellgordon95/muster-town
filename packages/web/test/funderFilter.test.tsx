import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { funderSlide, type FunderWeek, type GoalTreeNode, type IntrayRoute, type ReviewSlide } from "@muster-town/schema";
import { ReviewAsDeckButton, mineOnly } from "../src/panels/Places";
import { mineSlides } from "../src/panels/ReviewDeck";
import { fundedOnly, isFunder, treeScope } from "../src/panels/funderFilter";

const route = (goalId: string): IntrayRoute => ({ goalId, ownerId: null, ownerName: "the town admins", mine: false, canDecide: false });
const ROUTES: Record<string, IntrayRoute> = { gr_a: route("gl_child"), gr_b: route("gl_other"), dc_r: route("gl_child") };
const s = (key: string, itemId: string | null, extra: Partial<ReviewSlide> = {}): ReviewSlide =>
  ({ key, itemId, kind: "rollup", group: 5, buildingId: null, since: null, waiters: 0, history: "", text: `## ${key}`, notes: "", title: key, pictures: [], ...extra });

const week = (extra: Partial<FunderWeek> = {}): FunderWeek => ({
  userId: "us_d", userName: "Dana", days: 7, from: "2026-10-24T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z",
  streams: [{ inputId: "bi_k", label: "My key", source: "api-key", story: "literal", goalId: "gl_child", goalPath: "Town › Lab › Child", balance: 300_000, cancelledAt: null, creditedTokens: 0, sessions: 1, tokens: 84_000 }],
  literal: { tokens: 84_000, sessions: [{ sessionId: "se_1", at: "2026-10-30T10:00:00.000Z", purpose: "work", tokens: 84_000, assignmentId: "as_1", title: "Draft the brief", buildingId: "lab", buildingName: "Lab", goalId: "gl_child", keyResultId: "kr_1", keyResultText: "A thing", reportId: "dc_rep", reportTitle: "Brief", inputId: "bi_k" }] },
  proRata: { share: 0, yourCreditedTokens: 0, poolCreditedTokens: 0, poolSessions: 0, poolTokens: 0, tokens: 0, byAssignment: [] },
  goalIds: ["gl_child"], everything: false, ...extra,
});
const view = (w: FunderWeek) => ({ ...w, slide: funderSlide(w) });

describe("the funder filter (goal tree build step 8)", () => {
  it("a funder is someone with a Bank input", () => {
    expect(isFunder(week())).toBe(true);
    expect(isFunder(week({ streams: [] }))).toBe(false);
    expect(isFunder(null)).toBe(false);
  });

  it("the in-tray under Funded by me keeps the items under the goals the money reached; a pro rata share keeps all", () => {
    const items = [{ id: "gr_a" }, { id: "gr_b" }, { id: "dc_r" }, { id: "gp_unknown" }];
    expect(fundedOnly(items, ROUTES, week()).map((x) => x.id)).toEqual(["gr_a", "dc_r"]);
    expect(mineOnly(items, ROUTES, "funded", week()).map((x) => x.id)).toEqual(["gr_a", "dc_r"]);
    expect(fundedOnly(items, ROUTES, week({ everything: true }))).toHaveLength(4);
  });

  it("the deck under Funded by me: the funder's slide replaces the state of the town, then only their items", () => {
    const slides = [s("town", null, { kind: "town", group: 0 }), s("proposal:gr_a", "gr_a", { kind: "proposal", grantId: "gr_a" }), s("proposal:gr_b", "gr_b", { kind: "proposal", grantId: "gr_b" }),
      s("rollup:dc_r:1", "dc_r", { docIds: ["dc_r"] }), s("record", null, { kind: "record", docIds: ["dc_x"] })];
    const out = mineSlides(slides, ROUTES, "funded", view(week()));
    expect(out.map((x) => x.key)).toEqual(["funder:us_d", "proposal:gr_a", "rollup:dc_r:1"]);
    expect(out[0]!.text).toContain("## Sessions that ran on your key (1, 84k)");
    expect(out[0]!.text).toContain("Draft the brief");
    expect(mineSlides(slides, ROUTES, "funded", view(week({ everything: true }))).map((x) => x.key)).toEqual(["funder:us_d", "proposal:gr_a", "proposal:gr_b", "rollup:dc_r:1", "record"]);
  });

  it("the pro rata story names the share and what it bought", () => {
    const w = week({ streams: [], literal: { tokens: 0, sessions: [] }, everything: true,
      proRata: { share: 0.25, yourCreditedTokens: 1_000_000, poolCreditedTokens: 4_000_000, poolSessions: 10, poolTokens: 800_000, tokens: 200_000, byAssignment: [week().literal.sessions[0]!] } });
    const t = funderSlide(w).text;
    expect(t).toContain("## Your share of the pooled week (25%, 200k)");
    expect(t).toContain("1M of the window's 4M subscription tokens");
  });

  it("the tree under Funded by me lights the funded goals and the path to them", () => {
    const n = (id: string, children: GoalTreeNode[] = []): GoalTreeNode => ({ id, parentId: null, text: id, status: "active", ownerId: null, owner: { goalId: id, userId: null, name: "x" }, keyResults: [], children, buildings: [] } as unknown as GoalTreeNode);
    const root = n("gl_town", [n("gl_lab", [n("gl_child")]), n("gl_other")]);
    expect([...treeScope(root, week())!].sort()).toEqual(["gl_child", "gl_lab", "gl_town"]);
    expect(treeScope(root, week({ everything: true }))).toBeNull();
  });

  it("the header offers Funded by me only to a funder", () => {
    const html = renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} view={{ view: "funded", hidden: 1, set: () => undefined, funder: true }} />);
    expect(html).toContain("Funded by me");
    expect(html).toContain("slide 1 is your week as a funder");
    expect(renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} view={{ view: "all", hidden: 0, set: () => undefined }} />)).not.toContain("Funded by me");
  });
});
