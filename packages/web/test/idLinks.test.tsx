import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Assignment, SnapshotBuilding } from "@muster-town/schema";
import { DocText, IdLink, openIdLink } from "../src/panels/Markdown";
import { store } from "../src/state";

// kr_utx7pmv1yk "No dead ids": every id with a panel is a link, labelled by name where the client knows it
describe("id links in plain text", () => {
  store.set({
    agents: { ag_bbbbbbbbbb: { id: "ag_bbbbbbbbbb", name: "Teo 1" } as Agent },
    buildings: [{ id: "bl_cccccccccc", name: "UI / UX" } as SnapshotBuilding],
  });

  it("labels agents and buildings by name, with the id in the tooltip", () => {
    const html = renderToStaticMarkup(<DocText text="ag_bbbbbbbbbb works in bl_cccccccccc" />);
    expect(html).toContain('<a class="doc-id named" title="agent ag_bbbbbbbbbb" href="ag_bbbbbbbbbb">Teo 1</a>');
    expect(html).toContain('>UI / UX</a>');
    expect(html).not.toContain(">ag_bbbbbbbbbb<");
  });

  it("falls back to the id when the name isn't known", () => {
    const html = renderToStaticMarkup(<DocText text="see mt_aaaaaaaaaa and kr_dddddddddd" />);
    expect(html).toContain('<a class="doc-id" title="meeting" href="mt_aaaaaaaaaa">mt_aaaaaaaaaa</a>');
    expect(html).toContain('>kr_dddddddddd</a>');
  });

  it("opens media as its file in a new tab", () => {
    const html = renderToStaticMarkup(<DocText text="mf_eeeeeeeeee" />);
    expect(html).toContain('href="/api/media/mf_eeeeeeeeee"');
    expect(html).toContain('target="_blank"');
  });

  it("in a live meeting (newTab) links an agent to its hash URL", () => {
    vi.stubGlobal("location", { origin: "https://muster.town", pathname: "/" });
    expect(renderToStaticMarkup(<DocText text="ag_bbbbbbbbbb" newTab />)).toContain("#/agent/ag_bbbbbbbbbb");
  });

  it("links assignments by title (from the store) and sessions by id; both open their panels", () => {
    store.set({ assignments: { as_ffffffffff: { id: "as_ffffffffff", title: "No dead ids, step 2" } as Assignment } });
    const html = renderToStaticMarkup(<IdLink id="as_ffffffffff" />);
    expect(html).toContain('title="assignment as_ffffffffff: No dead ids, step 2" href="as_ffffffffff">No dead ids, step 2</a>');
    expect(renderToStaticMarkup(<DocText text="ran in se_gggggggggg" />)).toContain('<a class="doc-id" title="session" href="se_gggggggggg">se_gggggggggg</a>');
    openIdLink("as_ffffffffff");
    expect(store.state.panel).toMatchObject({ kind: "assignment", id: "as_ffffffffff" });
    openIdLink("se_gggggggggg");
    expect(store.state.panel).toMatchObject({ kind: "session", id: "se_gggggggggg" });
  });
});
