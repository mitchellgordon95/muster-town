/**
 * The Secretary's digest card (gr_kdlogzzo5s step 3): first in the Town Hall in-tray with its live decisions, Shipped
 * lines and the covered rollups under a fold; a decision made in a 1:1 reads "<Human> via Secretary in mt_…".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DigestCard, GrantView } from "@muster-town/schema";
import { store } from "../src/state";
import { DigestCardView, GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const card: DigestCard = {
  doc: { id: "dc_dig", title: "Digest 2026-11-05: 1 decision, 2 rollups", createdAt: new Date().toISOString() } as never,
  decisions: ["Fund gr_x (Workshop: \"A banner\") at its 300k ask?"],
  askedOfYou: null,
  shipped: "- A banner shows today's spend (dc_r1)",
  covered: [{ id: "dc_r1", title: "Rollup 44", buildingId: "workshop", buildingName: "Workshop", pending: false }, { id: "dc_r2", title: "Rollup 9", buildingId: "lab", buildingName: "Lab", pending: true }],
};

describe("the digest card", () => {
  it("Decisions needed first, then Shipped, then the covered rollups folded, archived or still asking", () => {
    const html = renderToStaticMarkup(<DigestCardView card={card} onOpen={() => undefined} />);
    const dec = html.indexOf("Decisions needed"), ship = html.indexOf("Shipped since last digest"), fold = html.indexOf("<details");
    expect(dec).toBeGreaterThan(-1);
    expect(ship).toBeGreaterThan(dec);
    expect(fold).toBeGreaterThan(ship);
    expect(html).toContain("at its 300k ask?");
    expect(html).toContain("Covered rollups (2)");
    expect(html).toContain("Workshop: Rollup 44</button> <span class=\"muted\">archived");
    expect(html).toContain("still asks a call");
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
