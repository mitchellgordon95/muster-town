import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, GrantView, ScheduleView } from "@muster-town/schema";
import { store } from "../src/state";
import { GrantRow, askedOnOf } from "../src/panels/Places";

// sprites draw on a canvas and grant links read location, which node lacks
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const ask = (reportId: string, folded: boolean) => ({ reportId, buildingId: "workshop", buildingName: "Town Workshop", title: "Rollup 38", line: "gr_abc would let a stranger fund a goal.", at: "2026-11-02T03:00:00Z", folded });
const grant = (asks?: ReturnType<typeof ask>[]) => ({ id: "gr_abc", buildingId: "workshop", goalId: "gl_join", keyResultId: null, keyResult: null, keyResults: [{ id: "kr_1", text: "Deck review", howToCheck: "Open the in-tray", due: null, status: "not-started" }], objective: "Review as deck", approach: "", testingPlan: [], stopCondition: "done", askTokens: 1000, grantTokens: null, status: "proposed", outcome: null, findingsDocIds: [], checkpointsDone: [], checkpointDocId: null, proposedBy: "ag_pix", fundedBy: null, fundedWith: null, fundedAt: null, closedAt: null, history: [], spentTokens: 0, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", ...(asks ? { asks } : {}) }) as unknown as GrantView;

describe("a rollup's ask on the grant's own row (1:1 mt_7b4zc7yja3)", () => {
  it("the proposal row says '<building> asks you to fund this: <line>' with a link to the rollup; none without asks; the deck slide's row leaves it to the slide text", () => {
    store.state = { ...store.state, agents: { ag_pix: { id: "ag_pix", name: "Pix", kind: "resident" } as Agent }, buildings: [{ id: "workshop", managerAgentId: "ag_pix" }] as never, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never };
    const row = renderToStaticMarkup(<GrantRow grant={grant([ask("dc_r1", true)])} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(row).toContain("Town Workshop asks you to fund this:");
    expect(row).toContain("gr_abc would let a stranger fund a goal.");
    expect(row).toContain("the rollup →");
    expect(row.indexOf("asks you to fund this")).toBeLessThan(row.indexOf("Stop when"));
    expect(renderToStaticMarkup(<GrantRow grant={grant()} onDecided={() => undefined} onOpenDoc={() => undefined} />)).not.toContain("asks you to");
    expect(renderToStaticMarkup(<GrantRow grant={grant([ask("dc_r1", true)])} onDecided={() => undefined} onOpenDoc={() => undefined} deckSlide={3} />)).not.toContain("asks you to");
    expect(renderToStaticMarkup(<GrantRow grant={{ ...grant([ask("dc_r1", false)]), status: "checkpoint" }} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("asks you to continue this:");
  });

  it("maps each still-pending rollup to the rows that carry its ask", () => {
    const retainer = { id: "sc_1", asks: [ask("dc_r2", false)] } as unknown as ScheduleView;
    expect(askedOnOf([grant([ask("dc_r1", true), ask("dc_r2", false)])], [retainer])).toEqual(new Map([["dc_r1", ["gr_abc"]], ["dc_r2", ["gr_abc", "sc_1"]]]));
  });
});
