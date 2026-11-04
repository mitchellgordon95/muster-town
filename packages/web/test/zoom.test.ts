import { describe, expect, it } from "vitest";
import { defaultZoom } from "../src/map/zoom";

describe("default map zoom", () => {
  it("starts a phone at 2 so two buildings and a street fit", () => {
    expect(defaultZoom(390, true)).toBe(2);
    expect(defaultZoom(390, false)).toBe(2);
    expect(defaultZoom(599, false)).toBe(2);
  });
  it("starts a touch screen at 2 whatever its width", () => {
    expect(defaultZoom(1024, true)).toBe(2);
  });
  it("keeps a laptop at 3", () => {
    expect(defaultZoom(1280, false)).toBe(3);
    expect(defaultZoom(600, false)).toBe(3);
  });
});
