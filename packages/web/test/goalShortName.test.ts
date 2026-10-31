import { describe, expect, it } from "vitest";
import { goalShortName } from "../src/purpose";

describe("goalShortName", () => {
  it("takes the text before the first colon", () => {
    expect(goalShortName("Steer (goal-directed): a human can own a piece of the goal tree and steer work")).toBe("Steer (goal-directed)");
  });
  it("keeps a short text whole", () => {
    expect(goalShortName("Host Muster Town at muster.town")).toBe("Host Muster Town at muster.town");
  });
  it("cuts a long text without an early colon at a word, with an ellipsis", () => {
    const s = goalShortName("Minimize confusion when joining a Muster Town through UX design");
    expect(s).toBe("Minimize confusion when joining a…");
    expect(s.length).toBeLessThanOrEqual(41);
  });
});
