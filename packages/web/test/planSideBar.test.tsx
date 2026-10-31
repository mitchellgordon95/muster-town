import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { MockApi } from "../src/mock/server";
import { PlanSideBar } from "../src/panels/PlanSideBar";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));

describe("town planning's side bar (Mitchell, mt_xywhisvdcm decision 12)", () => {
  it("a selected lab shows its goal, what it is attached to (no goal editing: the map is the tree), Budget (today, no daily cap) and Stats", () => {
    const b = { id: "bl_x", name: "Ocean Lab", kind: "lab", goal: "Measure ocean heat uptake well enough to fund", headcount: 4, dailyTokensPerAgent: 1_000_000,
      budget: { allocatedTokens: 0, spentTokens: 0, remainingTokens: 2_000_000, bankTokens: 2_000_000, tokensToday: 500_000, tokensAllTime: 9_000_000 } };
    store.state = { ...store.state, buildings: [b] as never };
    const html = renderToStaticMarkup(<PlanSideBar id="bl_x" />);
    expect(html).toContain("Ocean Lab");
    expect(html).toContain("Measure ocean heat uptake well enough to fund");
    expect(html).toContain("Attached to");
    expect(html).not.toContain("Objectives and key results");
    expect(html).toContain("Budget");
    expect(html).toMatch(/500k<\/b> adj. tokens/);
    expect(html).not.toMatch(/500k<\/b> of /);
    expect(html).toContain("Stats");
    expect(renderToStaticMarkup(<PlanSideBar id="bl_gone" />)).toBe("");
  });
  it("the mock's buildingStats counts the building's work and residents", async () => {
    const s = await new MockApi().buildingStats("bl_carbon");
    expect(s.agents).toBeGreaterThan(0);
    expect(Object.keys(s.assignments).sort()).toEqual(["blocked", "queued", "running", "scheduled"]);
  });
});
