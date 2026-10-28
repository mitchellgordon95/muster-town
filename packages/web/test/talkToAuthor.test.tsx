import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Doc } from "@muster-town/schema";
import { store } from "../src/state";
import { DocView } from "../src/panels/DocView";
import { talkTarget } from "../src/panels/oneOnOne";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, openDocLink: () => undefined }));

const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, kind: "resident", status: "idle", homeBuildingId: "workshop", buildingId: "workshop", forkOf: null, ...extra }) as Agent;
const AGENTS = {
  ag_pix: agent("ag_pix", "Pix"),
  ag_lena: agent("ag_lena", "Lena"),
  ag_pix1: agent("ag_pix1", "Pix 1", { forkOf: "ag_pix", status: "retired" }),
  ag_old: agent("ag_old", "Sage", { status: "retired" }),
};
const BUILDINGS = [{ id: "workshop", managerAgentId: "ag_pix" }];
const report = (authorId: string) => ({ id: "dc_rep", type: "report", state: "building", title: "Layer A", body: "## Findings\nok", authorId, buildingId: "workshop", createdAt: "2026-10-28T21:00:00Z", updatedAt: "2026-10-28T21:00:00Z", provenance: { sourceIds: [], urls: [] }, tags: [], decision: "pending", verdict: "stop" }) as unknown as Doc;

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
});
