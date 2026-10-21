import { describe, expect, it } from "vitest";
import { avatarSize, modelTier } from "../src/map/avatarSize";

describe("avatar size by model tier", () => {
  it("maps model ids to tiers", () => {
    expect(modelTier("claude-fable-5-1")).toBe("xl");
    expect(modelTier("Astra")).toBe("xl");
    expect(modelTier("claude-opus-5-5")).toBe("standard");
    expect(modelTier("sol-2")).toBe("standard");
    expect(modelTier("claude-sonnet-5-5")).toBe("small");
    expect(modelTier("luna")).toBe("small");
    expect(modelTier("claude-haiku-5-5")).toBe("small");
  });
  it("falls back to standard, and to the building's model when the agent has none", () => {
    expect(modelTier(null)).toBe("standard");
    expect(modelTier("gpt-x")).toBe("standard");
    expect(avatarSize(null, "claude-fable-5-1")).toEqual({ w: 15, h: 20 });
    expect(avatarSize("claude-haiku-5-5", "claude-fable-5-1")).toEqual({ w: 10, h: 14 });
    expect(avatarSize(null, null)).toEqual({ w: 12, h: 16 });
  });
});
