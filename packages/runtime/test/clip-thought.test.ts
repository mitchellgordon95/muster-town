import { describe, expect, test } from "vitest";
import { clipThought } from "../src/session.ts";

// Grant gr_7h6r66d10i: a thought in Talk never ends in a word cut in half or an open ** / ` marker.
describe("clipThought", () => {
  test("a short thought is kept as it is", () => {
    expect(clipThought("Reading the **Bank** panel.")).toBe("Reading the **Bank** panel.");
  });
  test("a long thought cuts at the last sentence end when that keeps at least half", () => {
    const t = `${"First sentence goes on for a while. ".repeat(4)}Then a second part that runs well past the limit of two hundred characters and more.`;
    const c = clipThought(t);
    expect(c.length).toBeLessThan(200);
    expect(c.endsWith("a while.")).toBe(true);
  });
  test("with no sentence end it cuts at a whole word and ends in …", () => {
    const t = "word ".repeat(60).trim() + "ending";
    const c = clipThought(t);
    expect(c.length).toBeLessThan(200);
    expect(c).toMatch(/ word…$/);
    expect(clipThought("x".repeat(150) + " abcdefghijklmnopqrstuvwxyz".repeat(3))).toMatch(/ abcdefghijklmnopqrstuvwxyz…$/);
  });
  test("drops trailing punctuation before the …", () => {
    const t = "a ".repeat(98) + "b, cccccccccccccccc";
    expect(clipThought(t)).toMatch(/a b…$/);
  });
  test("an unpaired ** or ` left by the cut is dropped", () => {
    const t = `Checking ${"the town ".repeat(19)}**bold words here run past the cut ${"x ".repeat(20)}**`;
    const c = clipThought(t);
    expect(c).not.toContain("**");
    const u = `Checking ${"the town ".repeat(19)}\`grants.ts and more ${"y ".repeat(30)}\``;
    expect(clipThought(u)).not.toContain("`");
    expect(clipThought("**a** and **b")).toBe("**a** and b");
  });
});
