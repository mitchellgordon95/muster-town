import { describe, expect, it } from "vitest";
import type { Agent } from "@muster-town/schema";
import { canDrag } from "../src/map/residentDrag";

/** The grasper hand (Mitchell's flag dc_mf6oelioq5): who may be picked up, by whom. */
describe("residentDrag.canDrag", () => {
  const agent = (over: Partial<Agent>) => ({ id: "ag_x", name: "X", kind: "resident", status: "idle", homeBuildingId: "bl_a", buildingId: "bl_a", ...over }) as Agent;
  const manages = (ids: string[]) => (_p: "building.manage", b: string) => ids.includes(b);
  it("a resident or visitor of a building the human manages; never a human's avatar, a retired agent or another building's", () => {
    expect(canDrag(agent({}), manages(["bl_a"]))).toBe(true);
    expect(canDrag(agent({ kind: "visitor" }), manages(["bl_a"]))).toBe(true);
    expect(canDrag(agent({ kind: "human" }), manages(["bl_a"]))).toBe(false);
    expect(canDrag(agent({ status: "retired" }), manages(["bl_a"]))).toBe(false);
    expect(canDrag(agent({}), manages(["bl_b"]))).toBe(false);
    expect(canDrag(undefined, manages(["bl_a"]))).toBe(false);
  });
});
