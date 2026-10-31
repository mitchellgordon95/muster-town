import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { BuildingPanel } from "../src/panels/BuildingPanel";
import { PlanningPanel } from "../src/panels/PlanningPanel";

vi.mock("../src/api", async (orig) => ({ ...(await orig<object>()), api: () => ({ mock: false, budget: () => new Promise(() => {}), roles: () => new Promise(() => {}) }) }));
vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), iconUrl: () => "", portraitUrl: () => "" }));

describe("building tabs (Mitchell's flag dc_v7ejy1j5ri)", () => {
  const lab = { id: "bl_x", name: "Ocean Lab", kind: "lab", headcount: 5, managerAgentId: "ag_m", goal: "", description: "", model: "m", cheapModel: "c", dailyTokensPerAgent: 1 };
  const sched = { id: "sc_1", buildingId: "bl_x", title: "Daily refresh", description: "", lane: "exploration", nextRunAt: null, everyMinutes: null, dailyAt: ["19:30"], runs: 0, paused: false };
  const setup = () => { store.state = { ...store.state, buildings: [lab] as never, scheduled: [sched] as never, agents: { ag_m: { id: "ag_m", name: "Moss", kind: "resident", homeBuildingId: "bl_x", status: "idle", sprite: 0 } } as never }; };
  const tabsOf = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

  it("a lab has a Schedule tab and no Members tab; the schedule is off the Overview", () => {
    setup();
    const overview = renderToStaticMarkup(<BuildingPanel id="bl_x" />);
    expect(tabsOf(overview)).toEqual(["Overview", "Goals", "Grants", "Queue", "Schedule"]);
    expect(overview).not.toContain("Daily refresh");
    const schedule = renderToStaticMarkup(<BuildingPanel id="bl_x" tab="Schedule" />);
    expect(schedule).toContain("Daily refresh");
    expect(schedule).toContain("daily 19:30 UTC");
  });
  it("the planning desk's Managers tab names each building's manager", () => {
    setup();
    const html = renderToStaticMarkup(<PlanningPanel tab="Managers" />);
    expect(html).toContain("Ocean Lab");
    expect(html).toContain("Moss");
  });
  it("re-opening the same tab deep-link stores a fresh ref, so the panel re-lands on that tab (app.tsx keys on it)", () => {
    const ref = { kind: "building" as const, id: "bl_x", tab: "Schedule" };
    store.open(ref); const a = store.state.panel;
    store.open(ref); const b = store.state.panel;
    expect(a).toEqual(ref); expect(b).toEqual(ref); expect(a).not.toBe(b);
    store.open(null);
  });
});
