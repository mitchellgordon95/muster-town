/**
 * The Secretary's digest (gr_kdlogzzo5s step 3): its line and Approve-all went with the Town Hall in-tray (the decision
 * queue replaced it, 2026-11-09); a decision made in a 1:1 still reads "<Human> via Secretary in mt_…".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GrantView } from "@muster-town/schema";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

describe("a decision made in the Secretary's 1:1", () => {
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
