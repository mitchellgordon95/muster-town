import { describe, expect, it } from "vitest";
import { GHOST_ALPHA, buildingTint, forkLabel, forkTip, ghostAlpha } from "../src/forks.ts";

describe("manager forks on the web", () => {
  it("tints by building, stably, and differently for different buildings", () => {
    expect(buildingTint("bl_workshop")).toBe(buildingTint("bl_workshop"));
    expect(buildingTint("bl_workshop")).not.toBe(buildingTint("bl_carbon"));
    expect(buildingTint("bl_workshop")).toMatch(/^hsla\(\d+, 80%, 82%, 0.9\)$/);
  });
  it("labels a fork as its manager's name with a subscript n", () => {
    expect(forkLabel({ name: "Pix 3", forkN: 3 })).toEqual({ base: "Pix", n: 3 });
    expect(forkLabel({ name: "Pix", forkN: null })).toEqual({ base: "Pix", n: null });
  });
  it("hovers 'fork of Pix · as_… · session se_…' and nothing for a named agent", () => {
    const nameOf = (id: string) => (id === "ag_pix" ? "Pix" : id);
    expect(forkTip({ forkOf: "ag_pix" }, nameOf, "as_1", "se_2")).toBe("fork of Pix · as_1 · session se_2");
    expect(forkTip({ forkOf: "ag_pix" }, nameOf, "as_1")).toBe("fork of Pix · as_1");
    expect(forkTip({ forkOf: null }, nameOf, "as_1")).toBe("");
  });
  it("fades the ghost in over 400 ms to 0.6", () => {
    expect(ghostAlpha(0)).toBe(0);
    expect(ghostAlpha(200)).toBeCloseTo(GHOST_ALPHA / 2);
    expect(ghostAlpha(5000)).toBe(GHOST_ALPHA);
  });
});
