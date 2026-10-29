import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { townPlan } from "../src/map/townPlan";
import { PlanToolbar } from "../src/panels/PlanToolbar";
import { Buildings } from "../src/panels/PlanningPanel";
import { Settings } from "../src/panels/BuildingPanel";

vi.mock("../src/api", async (orig) => ({ ...(await orig<object>()), api: () => ({ mock: false, previewPlan: () => new Promise(() => {}) }) }));

describe("town planner desks follow floor space (Mitchell's flag dc_1hjoh9aurq)", () => {
  const lot = { x: 10, y: 20, w: 15, h: 12 };
  const desk = (id: string) => ({ id, kind: "desk", name: "", buildingId: "bl_x", pos: { x: 0, y: 0 } });
  const setup = () => {
    store.state = { ...store.state, buildings: [{ id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, lot }] as never,
      places: [desk("desk:ag_a"), desk("desk:ag_b"), desk("desk:ag_c"), desk("desk:free:bl_x:3"), desk("desk:free:bl_x:4")] as never };
    townPlan.start();
  };
  it("a move keeps the desks, a resize recomputes them (never below the 3 in use); the toolbar shows them read-only", () => {
    setup();
    townPlan.select("bl_x");
    townPlan.setLot("bl_x", { ...lot, x: 12 });
    expect(townPlan.desksOf("bl_x")).toBe(5);
    townPlan.setLot("bl_x", { ...lot, w: 21, h: 18 });
    expect(townPlan.desksOf("bl_x")).toBe(11);
    const html = renderToStaticMarkup(<PlanToolbar />);
    expect(html).toContain("21×18 · 11 desks");
    expect(html).not.toMatch(/<input[^>]*type="number"/);
    townPlan.setLot("bl_x", { ...lot, w: 13, h: 9 });
    expect(townPlan.desksOf("bl_x")).toBe(3);
    townPlan.cancel();
  });
  it("a drawn building's desks come from its lot, with no desks input", () => {
    setup();
    townPlan.drag({ id: "new", kind: "draw", ax: 40, ay: 10 }, 54, 18);
    expect(townPlan.desksOf("new")).toBe(3);
    const html = renderToStaticMarkup(<PlanToolbar />);
    expect(html).toContain("15×9 · 3 desks");
    expect(html).not.toContain("Desks <");
    townPlan.cancel();
  });
});

describe("the New building form and a building's Settings show desks read-only (flag dc_1hjoh9aurq part 2)", () => {
  it("New building: no desks input, the default lot's derived count", () => {
    vi.spyOn(store, "can").mockReturnValue(true);
    const html = renderToStaticMarkup(<Buildings />);
    expect(html).toContain("New building");
    expect(html).toContain("15×12 · 5 desks");
    expect(html).not.toMatch(/<input[^>]*type="number"/);
  });
  it("Settings: the lot and its desks as text, no desks input", () => {
    const b = { id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, lot: { x: 10, y: 20, w: 15, h: 12 }, goal: "", description: "", model: "m", cheapModel: "c",
      maxTurnsPerSession: 80, dailyTokensPerAgent: 2_000_000, managerAgentId: null, codeAccess: false, poolId: null } as never;
    store.state = { ...store.state, buildings: [b] };
    const html = renderToStaticMarkup(<Settings b={b} />);
    expect(html).toContain("15×12 · 5 desks");
    expect(html).not.toContain("headcount");
  });
});
