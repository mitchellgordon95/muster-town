import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@muster-town/schema";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";
import { grantsSentence } from "../src/panels/BankFinance";

// sprites draw on a canvas and grant links read location, which node lacks
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));

describe("a grant's likely cost next to its ask (Mitchell, 1:1 mt_c9u1kr15jp)", () => {
  it("the proposal card (Town Hall in-tray, grant page) shows the estimate sentence beside the ask; signed out too", () => {
    store.state = { ...store.state, agents: { ag_moss: { id: "ag_moss", name: "Moss", kind: "resident", status: "idle" } as Agent }, buildings: [{ id: "bl_carbon", managerAgentId: "ag_moss" }] as never, me: null };
    const g = grants.find((x) => x.id === "gr_ocean")!;
    const html = renderToStaticMarkup(<GrantRow grant={g} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(html).toContain("asks 4M");
    // the cheap model answered (step 2): its range first, the similar grants' beside it
    expect(html).toContain("estimate 1.5M–4M (model) · similar grants spent 1.8M–6.1M");
    // before the model answers, the history sentence alone
    const noModel = { ...g, estimate: { ...g.estimate!, model: null } };
    expect(renderToStaticMarkup(<GrantRow grant={noModel} onDecided={() => undefined} onOpenDoc={() => undefined} />))
      .toContain("likely cost: ask 4,000,000 · 3 similar grants spent 1,800,000–6,100,000 (median spent/funded 1.21 across 5 closed grants; this building 0.95 across 2)");
    // a grant without one (proposed before estimates) shows no line
    expect(renderToStaticMarkup(<GrantRow grant={grants.find((x) => x.id === "gr_land")!} onDecided={() => undefined} onOpenDoc={() => undefined} />)).not.toContain("likely cost");
  });

  it("a closed grant shows its estimate against what it spent", () => {
    const g = grants.find((x) => x.id === "gr_ocean")!;
    const closed = { ...g, status: "closed" as const, outcome: "done" as const, grantTokens: 4_000_000, spentTokens: 4_600_000 };
    expect(renderToStaticMarkup(<GrantRow grant={closed} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("estimated 1.5M–4M (model), spent 4.6M: outside the range");
    const inside = { ...closed, spentTokens: 2_000_000, estimate: { ...g.estimate!, model: null } };
    expect(renderToStaticMarkup(<GrantRow grant={inside} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("estimated 1.8M–6.1M (similar grants), spent 2M: inside the range");
  });

  it("the Spending tab's sentence says how many closed grants landed inside their estimate, once any had one", () => {
    const base = { count: 3, funded: 500, spent: 600, byOutcome: { done: { count: 2, tokens: 400 }, cut: { count: 1, tokens: 200 }, open: { count: 0, tokens: 0 } }, overFunding: { count: 0, tokens: 0 } };
    const none = grantsSentence({ grants: { ...base, estimates: { closed: 0, inside: 0, unit: "adjusted tokens", badRanges: [] } } } as never)!;
    expect(none).not.toContain("estimate");
    const some = grantsSentence({ grants: { ...base, estimates: { closed: 3, inside: 2, unit: "adjusted tokens", badRanges: [] } } } as never)!;
    expect(some).toMatch(/ 2 of 3 closed grants landed inside their estimate\.$/);
  });
});
