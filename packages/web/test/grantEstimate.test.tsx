import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@muster-town/schema";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

// sprites draw on a canvas and grant links read location, which node lacks
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));

describe("a grant's likely cost next to its ask (Mitchell, 1:1 mt_c9u1kr15jp)", () => {
  it("the proposal card (Town Hall in-tray, grant page) shows the estimate sentence beside the ask; signed out too", () => {
    store.state = { ...store.state, agents: { ag_moss: { id: "ag_moss", name: "Moss", kind: "resident", status: "idle" } as Agent }, buildings: [{ id: "bl_carbon", managerAgentId: "ag_moss" }] as never, me: null };
    const g = grants.find((x) => x.id === "gr_ocean")!;
    const html = renderToStaticMarkup(<GrantRow grant={g} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(html).toContain("asks 4M");
    expect(html).toContain("likely cost: ask 4,000,000 · 3 similar grants spent 1,800,000–6,100,000 (median spent/funded 1.21 across 5 closed grants; this building 0.95 across 2)");
    // a grant without one (proposed before estimates) shows no line
    expect(renderToStaticMarkup(<GrantRow grant={grants.find((x) => x.id === "gr_land")!} onDecided={() => undefined} onOpenDoc={() => undefined} />)).not.toContain("likely cost");
  });
});
