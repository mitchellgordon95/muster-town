import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaptainRequestView, GoalSpend, IntrayRoute, ReviewSlide } from "@muster-town/schema";
import { ReviewAsDeckButton, mineOnly } from "../src/panels/Places";
import { SlideDecision, mineSlides } from "../src/panels/ReviewDeck";
import { laneLine, seriesBars } from "../src/panels/GoalSpend";

vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span> }));

const route = (mine: boolean, canDecide = mine): IntrayRoute => ({ goalId: "gl_x", ownerId: mine ? "us_me" : "us_mitchell", ownerName: mine ? "Me" : "Mitchell", mine, canDecide });
const ROUTES: Record<string, IntrayRoute> = { gr_a: route(true), gr_b: route(false), gp_c: route(true), dc_r: route(false) };
const s = (key: string, itemId: string | null, extra: Partial<ReviewSlide> = {}): ReviewSlide =>
  ({ key, itemId, kind: "rollup", group: 5, buildingId: null, since: null, waiters: 0, history: "", text: `## ${key}`, notes: "", title: key, pictures: [], ...extra });

describe("Town Hall in-tray: Mine / All and goal proposals (docs/goals.md step 4)", () => {
  it("Mine keeps the items routed to me; All keeps everything", () => {
    const items = [{ id: "gr_a" }, { id: "gr_b" }, { id: "gp_c" }, { id: "gp_unknown" }];
    expect(mineOnly(items, ROUTES, "mine").map((x) => x.id)).toEqual(["gr_a", "gp_c"]);
    expect(mineOnly(items, ROUTES, "all")).toHaveLength(4);
  });
  it("the deck under Mine keeps slide 1, For the record and my items' slides", () => {
    const slides = [s("town", null, { kind: "town", group: 0 }), s("proposal:gr_a", "gr_a", { kind: "proposal", grantId: "gr_a" }), s("proposal:gr_b", "gr_b", { kind: "proposal", grantId: "gr_b" }),
      s("goal-proposal:gp_c", "gp_c", { kind: "goal-proposal", group: 4 }), s("rollup:dc_r:1", "dc_r", { docIds: ["dc_r"] }), s("record", null, { kind: "record", docIds: ["dc_x"] })];
    expect(mineSlides(slides, ROUTES, "mine").map((x) => x.key)).toEqual(["town", "proposal:gr_a", "goal-proposal:gp_c", "record"]);
    expect(mineSlides(slides, ROUTES, "all")).toHaveLength(6);
  });
  it("the header shows Mine / All for a signed-in viewer and how many more wait under All", () => {
    const html = renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} view={{ view: "mine", hidden: 3, set: () => undefined }} />);
    expect(html).toContain("Mine");
    expect(html).toContain("All");
    expect(html).toContain("3 more under All");
    expect(renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} />)).not.toContain("Mine");
  });
  it("a goal proposal slide whose proposal was decided says so", () => {
    const html = renderToStaticMarkup(<SlideDecision slide={s("goal-proposal:gp_z", "gp_z", { kind: "goal-proposal", group: 4 })} n={2} grants={[]} reports={[]} goalProposals={[]} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(html).toContain("Already decided");
  });

  it("a captain slide (gr_bwm0iz7rwl) carries Accept / Decline for whoever the route lets decide; the others see who decides", () => {
    const req: CaptainRequestView = { id: "cr_1", goalId: "gl_x", userId: "us_ana", note: "I run this", status: "pending", decidedBy: null, decisionNote: "", createdAt: new Date().toISOString(), decidedAt: null, name: "Ana", githubLogin: "ana", avatarUrl: null, goalText: "Grant pages show sessions", captainId: "us_mitchell", captainName: "Mitchell" };
    const slide = s("captain:cr_1", "cr_1", { kind: "captain", group: 4 });
    const yes = renderToStaticMarkup(<SlideDecision slide={slide} n={2} grants={[]} reports={[]} captains={[req]} routes={{ cr_1: route(true) }} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(yes).toContain("@ana</b> asks to captain");
    expect(yes).toContain("Accept");
    expect(yes).toContain("Decline");
    const no = renderToStaticMarkup(<SlideDecision slide={slide} n={2} grants={[]} reports={[]} captains={[req]} routes={{ cr_1: route(false) }} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(no).not.toContain("Accept");
    expect(no).toContain("Captained today by Mitchell");
    expect(renderToStaticMarkup(<SlideDecision slide={slide} n={2} grants={[]} reports={[]} captains={[]} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("Already decided");
  });
});

describe("the Bank's Spend by goal helpers", () => {
  it("lanes biggest first, empty lanes left out; bars scale to the biggest bucket", () => {
    expect(laneLine({ grant: 1_200_000, exploration: 0, directed: 300_000, none: 0 })).toMatch(/^grant .* · directed /);
    expect(laneLine({ grant: 0, exploration: 0, directed: 0, none: 0 })).toBe("nothing");
    const series: GoalSpend["series"] = [{ start: "2026-10-29T00:00:00Z", tokens: 50, byLane: { grant: 50, exploration: 0, directed: 0, none: 0 } }, { start: "2026-10-30T00:00:00Z", tokens: 200, byLane: { grant: 0, exploration: 0, directed: 200, none: 0 } }];
    expect(seriesBars(series).map((b) => b.pct)).toEqual([25, 100]);
  });
});
