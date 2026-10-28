import { describe, expect, it } from "vitest";
import { clipText } from "../src/panels/showMore";

describe("clipText", () => {
  it("keeps a short text whole", () => {
    expect(clipText("curl -X PATCH /api/buildings/workshop", 400)).toEqual({ head: "curl -X PATCH /api/buildings/workshop", cut: false });
  });
  it("collapses a long text at a word boundary and says it cut", () => {
    const { head, cut } = clipText("one two three four five six seven", 20);
    expect(cut).toBe(true);
    expect(head).toBe("one two three four…");
  });
});
