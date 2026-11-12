import { expect, test } from "vitest";
import { DOORS } from "../src/threeDoors";
import { CAPTAIN_DOOR } from "../src/panels/goalTree";
import { routeOf } from "../src/route";

// The three doors (gr_y9bpvx197c): each opens the real thing in one click.
test("Fund opens the Bank (its Donate tab), Captain the goal tree at a goal, Bring your agent Connect", () => {
  expect(DOORS.map((d) => [d.door, d.label])).toEqual([["fund", "Fund"], ["captain", "Captain a goal"], ["agent", "Bring your agent"]]);
  expect(DOORS[0].opens).toEqual({ kind: "bank" });
  expect(DOORS[1].opens).toEqual({ kind: "goals", id: CAPTAIN_DOOR });
  expect(DOORS[2].opens).toEqual({ kind: "connect" });
  // the home card's Donate link lands on the same Bank panel
  expect(routeOf("#/bank")).toEqual({ panel: { kind: "bank" } });
});
