import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { townPlan } from "../src/map/townPlan";
import { PlanToolbar } from "../src/panels/PlanToolbar";
import { Buildings } from "../src/panels/PlanningPanel";
import { Settings } from "../src/panels/BuildingPanel";

vi.mock("../src/api", async (orig) => ({ ...(await orig<object>()), api: () => ({ mock: false }) }));

describe("the town map is drawn from the goal tree (docs/goals.md \"The map is the tree\")", () => {
  const lot = { x: 10, y: 20, w: 15, h: 12 };
  it("is read-only: a click selects the building under it, the toolbar has no inputs, nothing to save", () => {
    store.state = { ...store.state, buildings: [{ id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, lot }] as never };
    townPlan.start();
    expect(townPlan.buildingAt(12, 25)).toBe("bl_x");
    expect(townPlan.buildingAt(2, 2)).toBeNull();
    townPlan.select(townPlan.buildingAt(12, 25));
    const html = renderToStaticMarkup(<PlanToolbar />);
    expect(html).toContain("Drawn from the goal tree");
    expect(html).toContain("15×12 · 5 desks");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Save");
    townPlan.cancel();
    expect(townPlan.draft).toBeNull();
  });
});

describe("Desks is the size setting", () => {
  const b = { id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, lot: { x: 10, y: 20, w: 15, h: 12 }, goal: "", description: "", model: "m", cheapModel: "c",
    maxTurnsPerSession: 80, dailyTokensPerAgent: 2_000_000, managerAgentId: null, codeAccess: false, poolId: null } as never;
  it("New building: no desks input, the default count", () => {
    vi.spyOn(store, "can").mockReturnValue(true);
    const html = renderToStaticMarkup(<Buildings />);
    expect(html).toContain("New building");
    expect(html).toContain("15×12 · 5 desks");
    expect(html).not.toMatch(/<input[^>]*type="number"/);
  });
  it("Settings: a desks number for town.manage_buildings, read-only text otherwise", () => {
    store.state = { ...store.state, buildings: [b] };
    vi.spyOn(store, "can").mockImplementation((p: string) => p === "town.manage_buildings" || p === "building.manage");
    expect(renderToStaticMarkup(<Settings b={b} />)).toMatch(/<input[^>]*type="number"[^>]*value="5"/);
    vi.spyOn(store, "can").mockImplementation((p: string) => p === "building.manage");
    const html = renderToStaticMarkup(<Settings b={b} />);
    expect(html).toContain("15×12 · 5 desks");
    expect(html).not.toMatch(/<input[^>]*type="number"[^>]*value="5"/);
  });
});

describe("building settings are a thin layer on goals (1:1 mt_n25udpflus decision 3)", () => {
  const b = { id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, lot: { x: 10, y: 20, w: 15, h: 12 }, goal: "old text", description: "old description", model: "m", cheapModel: "c",
    maxTurnsPerSession: 80, dailyTokensPerAgent: 2_000_000, managerAgentId: null, codeAccess: false, poolId: null, goalId: "gl_town" } as never;
  it("Settings: Name (optional), Attached to, Desks, Manager in one form; no goal or description text", () => {
    store.state = { ...store.state, buildings: [b] };
    vi.spyOn(store, "can").mockReturnValue(true);
    const html = renderToStaticMarkup(<Settings b={b} />);
    const at = (label: string) => html.indexOf(`>${label}<`);
    expect(at("Name")).toBeGreaterThan(-1);
    expect([at("Name"), at("Attached to"), at("Desks"), at("Manager")]).toEqual([...[at("Name"), at("Attached to"), at("Desks"), at("Manager")]].sort((x, y) => x - y));
    expect(html).toContain("placeholder=\"defaults to the goal&#x27;s short text\"");
    expect(html).toContain("gets its manager when it is built");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("old description");
    expect(html).not.toContain(">Attach<"); // the attachment is saved with the form, no own section and button
  });
  it("Planning desk: a new building is goal, optional name, desks; each building opens its Settings", () => {
    vi.spyOn(store, "can").mockReturnValue(true);
    store.state = { ...store.state, buildings: [b] };
    const html = renderToStaticMarkup(<Buildings />);
    expect(html).not.toContain("Purpose");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Open its Settings");
    expect(html).toContain("Optional: blank names it after the goal");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Create building/);
  });
});
