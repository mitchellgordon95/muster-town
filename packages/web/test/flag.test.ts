import { describe, expect, it } from "vitest";
import { flagTargets } from "../src/panels/flag";

const bs = [{ id: "town-hall", kind: "town-hall" }, { id: "workshop", kind: "lab" }, { id: "prod", kind: "lab" }, { id: "onb", kind: "lab" }];

describe("flagTargets", () => {
  it("lists the labs I may assign in, never the Town Hall", () => {
    expect(flagTargets(bs, (id) => id !== "onb").map((b) => b.id)).toEqual(["workshop", "prod"]);
  });
  it("puts the building I'm standing in first", () => {
    expect(flagTargets(bs, () => true, "prod").map((b) => b.id)).toEqual(["prod", "workshop", "onb"]);
  });
  it("keeps the order when I stand outside, in the Town Hall, or in a building I can't assign in", () => {
    expect(flagTargets(bs, () => true, null).map((b) => b.id)).toEqual(["workshop", "prod", "onb"]);
    expect(flagTargets(bs, () => true, "town-hall").map((b) => b.id)).toEqual(["workshop", "prod", "onb"]);
    expect(flagTargets(bs, (id) => id !== "prod", "prod").map((b) => b.id)).toEqual(["workshop", "onb"]);
  });
  it("is empty for a guest (no permissions)", () => {
    expect(flagTargets(bs, () => false, "workshop")).toEqual([]);
  });
});
