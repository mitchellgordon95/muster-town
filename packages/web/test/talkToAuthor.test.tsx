import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Doc } from "@muster-town/schema";
import { store } from "../src/state";
import { DocView } from "../src/panels/DocView";
import { grantTalkTarget, talkTarget } from "../src/panels/oneOnOne";
import { GrantRow } from "../src/panels/Places";
import { SlideDecision } from "../src/panels/ReviewDeck";

// sprites draw on a canvas and grant links read location, which node lacks
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, openDocLink: () => undefined }));

const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, kind: "resident", status: "idle", homeBuildingId: "workshop", buildingId: "workshop", forkOf: null, ...extra }) as Agent;
const AGENTS = {
  ag_pix: agent("ag_pix", "Pix"),
  ag_lena: agent("ag_lena", "Lena"),
  ag_pix1: agent("ag_pix1", "Pix 1", { forkOf: "ag_pix", status: "retired" }),
  ag_old: agent("ag_old", "Sage", { status: "retired" }),
  ag_mitchell: agent("ag_mitchell", "Mitchell", { kind: "human" }),
};
const BUILDINGS = [{ id: "workshop", managerAgentId: "ag_pix" }];
const report = (authorId: string, type = "report") => ({ id: "dc_rep", type, state: "building", title: "Layer A", body: "## Findings\nok", authorId, buildingId: "workshop", createdAt: "2026-10-28T21:00:00Z", updatedAt: "2026-10-28T21:00:00Z", provenance: { sourceIds: [], urls: [] }, tags: [], decision: "pending", verdict: "stop" }) as unknown as Doc;

describe("a report's Talk to <author> (1:1 mt_uf1bwd3exq)", () => {
  it("targets the author; a fork or a gone author reaches the manager and says why", () => {
    expect(talkTarget("ag_lena", AGENTS, BUILDINGS)).toMatchObject({ agent: { id: "ag_lena" }, via: null });
    expect(talkTarget("ag_pix1", AGENTS, BUILDINGS)).toMatchObject({ agent: { id: "ag_pix" }, via: "fork" });
    expect(talkTarget("ag_old", AGENTS, BUILDINGS)).toMatchObject({ agent: { id: "ag_pix" }, via: "gone" });
    expect(talkTarget("ag_nobody", AGENTS, BUILDINGS)).toBeNull();
  });

  it("the report view (in-tray review too) renders Talk to <author> and no Ask about this", () => {
    store.state = { ...store.state, agents: AGENTS, buildings: BUILDINGS as never, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never };
    const html = renderToStaticMarkup(<DocView doc={report("ag_lena")} review />);
    expect(html).toContain("Talk to Lena");
    expect(html).not.toContain("Ask about this");
    const fork = renderToStaticMarkup(<DocView doc={report("ag_pix1")} />);
    expect(fork).toContain("Talk to Pix");
    expect(fork).toContain("Pix 1 is a fork of Pix");
    // signed out: no button
    store.state = { ...store.state, me: null };
    expect(renderToStaticMarkup(<DocView doc={report("ag_lena")} />)).not.toContain("Talk to");
  });

  it("a pending report's actions are exactly Talk to <author> and Archive, no Reply (1:1 mt_cz11aqe81a); a decided one has no Archive", () => {
    store.state = { ...store.state, agents: AGENTS, buildings: BUILDINGS as never, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never };
    const card = renderToStaticMarkup(<DocView doc={report("ag_lena")} review />);
    expect(card).toContain("Talk to Lena");
    expect(card).toContain(">Archive<");
    expect(card).not.toMatch(/reply/i);
    expect(card).not.toContain("<textarea");
    const slide = { key: "r", kind: "report", itemId: "dc_rep", docIds: ["dc_rep"], title: "Layer A", text: "" } as never;
    const deck = renderToStaticMarkup(<SlideDecision slide={slide} n={2} grants={[]} reports={[report("ag_lena")]} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(deck).toContain("Talk to Lena");
    expect(deck).toContain(">Archive<");
    expect(deck).not.toMatch(/reply/i);
    const decided = renderToStaticMarkup(<DocView doc={{ ...report("ag_lena"), decision: "approve" }} review />);
    expect(decided).not.toContain(">Archive<");
    expect(decided).not.toMatch(/reply/i);
  });

  it("every agent-authored doc type gets the button, a human's doc doesn't, and a grant row gets Talk to <manager> (1:1 mt_u6euky43hg)", () => {
    store.state = { ...store.state, agents: AGENTS, buildings: BUILDINGS as never, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never };
    const article = renderToStaticMarkup(<DocView doc={report("ag_lena", "article")} />);
    expect(article).toContain("Talk to Lena");
    expect(article).toContain("about this article");
    expect(talkTarget("ag_mitchell", AGENTS, BUILDINGS)).toBeNull();
    expect(renderToStaticMarkup(<DocView doc={report("ag_mitchell", "note")} />)).not.toContain("Talk to");
    // a grant: its proposer when it works there (a fork reaches its manager), else the building's manager
    expect(grantTalkTarget("ag_pix1", "workshop", AGENTS, BUILDINGS)?.id).toBe("ag_pix");
    expect(grantTalkTarget("ag_nobody", "workshop", AGENTS, BUILDINGS)?.id).toBe("ag_pix");
    const grant = { id: "gr_abc", buildingId: "workshop", goalId: "gl_join", keyResultId: "kr_1", keyResult: { id: "kr_1", text: "Deck review", status: "on-track" }, keyResults: [{ id: "kr_1", text: "Deck review", howToCheck: "Open the in-tray", due: null, status: "on-track" }], objective: "Review as deck", approach: "", testingPlan: [], stopCondition: "done", askTokens: 1000, grantTokens: null, status: "proposed", outcome: null, findingsDocIds: [], checkpointsDone: [], checkpointDocId: null, proposedBy: "ag_pix", fundedBy: null, fundedWith: null, fundedAt: null, closedAt: null, history: [], spentTokens: 0, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z" } as never;
    expect(renderToStaticMarkup(<GrantRow grant={grant} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("Talk to Pix");
    store.state = { ...store.state, me: null };
    expect(renderToStaticMarkup(<GrantRow grant={grant} onDecided={() => undefined} onOpenDoc={() => undefined} />)).not.toContain("Talk to");
  });

  it("the buttons that act on a report or grant sit in a big footer after the body, not in the header (flag dc_4uiv48047s)", () => {
    store.state = { ...store.state, agents: AGENTS, buildings: BUILDINGS as never, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never };
    const card = renderToStaticMarkup(<DocView doc={report("ag_lena")} review />);
    const body = card.indexOf("## Findings"), footer = card.indexOf("decide-footer");
    expect(body).toBeGreaterThan(card.indexOf("doc-byline"));
    expect(footer).toBeGreaterThan(body);
    expect(card.indexOf("Talk to Lena")).toBeGreaterThan(footer);
    expect(card.indexOf(">Archive<")).toBeGreaterThan(footer);
    expect(card).not.toContain("btn primary sm");
    const grant = { id: "gr_abc", buildingId: "workshop", goalId: "gl_join", keyResultId: "kr_1", keyResult: { id: "kr_1", text: "Deck review", status: "on-track" }, keyResults: [{ id: "kr_1", text: "Deck review", howToCheck: "Open the in-tray", due: null, status: "on-track" }], objective: "Review as deck", approach: "", testingPlan: [], stopCondition: "done", askTokens: 1000, grantTokens: null, status: "proposed", outcome: null, findingsDocIds: [], checkpointsDone: [], checkpointDocId: null, proposedBy: "ag_pix", fundedBy: null, fundedWith: null, fundedAt: null, closedAt: null, history: [], spentTokens: 0, createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z" } as never;
    const row = renderToStaticMarkup(<GrantRow grant={grant} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    const foot = row.indexOf("decide-footer");
    expect(foot).toBeGreaterThan(row.indexOf("Stop when"));
    expect(row.indexOf(">Fund</button>")).toBeGreaterThan(foot);
    expect(row.indexOf("Talk to Pix")).toBeGreaterThan(foot);
  });
});
