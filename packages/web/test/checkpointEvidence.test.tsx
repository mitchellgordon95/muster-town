import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GrantView } from "@muster-town/schema";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

// sprites draw on a canvas and grant links read location, which node lacks
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

// no history: its last note names an agent through the live api
const hud = { ...grants.find((g) => g.id === "gr_hud")!, history: [] };
const STATE = {
  me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never,
  agents: { ag_keel: { id: "ag_keel", name: "Keel", kind: "resident", status: "idle", homeBuildingId: "bl_workshop", buildingId: "bl_workshop", forkOf: null }, ag_moss: { id: "ag_moss", name: "Moss", kind: "resident", status: "idle", homeBuildingId: "bl_carbon", buildingId: "bl_carbon", forkOf: null } } as never,
  buildings: [{ id: "bl_workshop", name: "Workshop", managerAgentId: "ag_keel" }, { id: "bl_carbon", name: "Carbon", managerAgentId: "ag_moss" }] as never,
};
const row = (g: GrantView) => renderToStaticMarkup(<GrantRow grant={g} onDecided={() => undefined} onOpenDoc={() => undefined} />);

describe("the checkpoint card shows evidence (1:1 mt_7b4zc7yja3)", () => {
  it("one line per key result with the manager's note, the top-up line and the report's Shipped titles, then Continue / Adjust / Cut; the plan under a fold", () => {
    store.state = { ...store.state, ...STATE };
    const html = row(hud);
    expect(html).toContain("✓ shipped: Live: at 650px the HUD folds into one row (PR #41).");
    expect(html).toContain("~ partly: The panel still covers the HUD&#x27;s last button at 650px.");
    expect(html).toContain("A top-up of 400,000 tokens buys: KR 2: the meeting panel docks under the HUD at 650px, so nothing overlaps.");
    expect(html).toContain("The HUD collapses below 700px");
    const evidence = html.indexOf("checkpoint-evidence"), buttons = html.indexOf(">Continue</button>"), fold = html.indexOf("<details");
    expect(evidence).toBeGreaterThan(-1);
    expect(buttons).toBeGreaterThan(evidence);
    expect(fold).toBeGreaterThan(buttons);
    expect(html.indexOf("Stop when")).toBeGreaterThan(fold);
    expect(html.indexOf("How to check")).toBeGreaterThan(fold);
  });

  it("an old checkpoint says the top-up is not stated; a not-started key result reads not shipped", () => {
    store.state = { ...store.state, ...STATE };
    const e = hud.evidence!;
    const old = { ...hud, evidence: { ...e, topUpTokens: null, whatTopUpBuys: "", keyResults: [{ ...e.keyResults[0]!, status: "not-started" as const, verdict: "not" as const, note: "" }] } };
    const html = row(old);
    expect(html).toContain("A top-up: not stated");
    expect(html).toContain("✗ not shipped: HUD collapses below 700px");
  });

  it("an overspent checkpoint says how far over, not a capped 100% (gr_5ltmbf3a2f live: 545k of 500k)", () => {
    store.state = { ...store.state, ...STATE };
    const html = row({ ...hud, spentTokens: 545_488, grantTokens: 500_000 });
    expect(html).toContain("spent (109%)");
  });

  it("a proposal asking again for that work shows the earlier grant's evidence above its own key results", () => {
    store.state = { ...store.state, ...STATE };
    const proposal = { ...grants.find((g) => g.status === "proposed")!, history: [] };
    const html = row({ ...proposal, evidence: hud.evidence });
    expect(html).toContain("Asks again for work an earlier grant stopped at its checkpoint");
    expect(html).toContain("Spent 2M of 2M adj. tokens granted.");
    expect(html.indexOf("checkpoint-evidence")).toBeLessThan(html.indexOf("How to check"));
    expect(html).not.toContain("<details");
  });
});
