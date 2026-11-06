/**
 * The Secretary's digest (gr_kdlogzzo5s step 3): first in the Town Hall in-tray as one line like every other item that
 * opens the full doc (Mitchell, 1:1 mt_pr3347g2w2), the overtaken rollups' Approve-all under the opened doc; a decision
 * made in a 1:1 reads "<Human> via Secretary in mt_…".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DigestCard, GrantView } from "@muster-town/schema";
import { store } from "../src/state";
import { DigestLine, DigestOvertaken, GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const card: DigestCard = {
  doc: { id: "dc_dig", title: "Digest 2026-11-05: 1 decision, 2 rollups", createdAt: new Date().toISOString() } as never,
  decisions: [
    { heading: "Money (1)", note: null, lines: ["Fund gr_x (Workshop: \"A banner\") at its 300k ask?"] },
    { heading: "Already overtaken (2)", note: "Approve these 2 and they drop out; nothing to decide.", lines: ["Lab (dc_r2, \"Item 1\"): kr_a is already met.", "Lab (dc_r3, \"Item 1\"): gr_y is closed (done)."], docIds: ["dc_r2", "dc_r3"] },
  ],
  shipped: "**Bank and speed**\n\n- A banner shows today's spend (dc_r1)",
  covered: [{ id: "dc_r1", title: "Rollup 44", buildingId: "workshop", buildingName: "Workshop", pending: false }, { id: "dc_r2", title: "Rollup 9", buildingId: "lab", buildingName: "Lab", pending: true }],
};

describe("the digest card", () => {
  it("one line like any other in-tray item: title and date, nothing of the groups or Shipped list inline; the click opens the doc", () => {
    let opened: string | null = null;
    const html = renderToStaticMarkup(<DigestLine card={card} onOpen={(id) => { opened = id; }} />);
    expect(html).toContain("Digest 2026-11-05: 1 decision, 2 rollups");
    expect(html).toMatch(/<button class="doc-row intray-line"/);
    expect(html).toContain(">digest<");
    for (const inline of ["Decisions needed", "Shipped since last digest", "Money (1)", "at its 300k ask?", "**Bank and speed**", "Covered rollups", "Approve all"]) expect(html).not.toContain(inline);
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(opened).toBeNull();
  });

  it("under the opened doc, one Approve-all for the overtaken rollups; nothing when no group is overtaken", () => {
    const html = renderToStaticMarkup(<DigestOvertaken card={card} />);
    expect(html).toContain("2 covered rollups ask only what the town has since decided.");
    expect(html).toMatch(/<button[^>]*>Approve all 2<\/button>/);
    expect(renderToStaticMarkup(<DigestOvertaken card={{ ...card, decisions: [card.decisions[0]!] }} />)).toBe("");
  });

  it("a 1:1 decision shows \"<Human> via Secretary in mt_…\" and the human's words, not the prefix twice", () => {
    const hud = grants.find((g) => g.id === "gr_hud")!;
    store.state = { ...store.state, me: { isAdmin: true, roles: [], user: { id: "us_m", name: "Mitchell" } } as never,
      agents: { ag_keel: { id: "ag_keel", name: "Keel", kind: "resident", status: "idle", homeBuildingId: "bl_workshop", buildingId: "bl_workshop", forkOf: null }, ag_sec: { id: "ag_sec", name: "Secretary", kind: "resident", status: "idle", homeBuildingId: "town-hall", buildingId: "town-hall", forkOf: null }, ag_mit: { id: "ag_mit", name: "Mitchell", kind: "human", ownerUserId: "us_m", status: "idle" } } as never,
      buildings: [{ id: "bl_workshop", name: "Workshop", managerAgentId: "ag_keel" }] as never };
    const g: GrantView = { ...hud, history: [{ at: new Date().toISOString(), byId: "us_m", byKind: "user", action: "adjust", tokens: 200_000, note: "by Mitchell via Secretary in mt_abc: \"continue at 200k\"", viaAgentId: "ag_sec", viaMeetingId: "mt_abc" }] };
    const html = renderToStaticMarkup(<GrantRow grant={g} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(html).toContain("Mitchell via Secretary in mt_abc (adjust): <span>&quot;continue at 200k&quot;</span>");
  });
});
