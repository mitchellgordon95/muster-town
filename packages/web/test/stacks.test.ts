import { describe, expect, it } from "vitest";
import { stackBodies, STACK_SPREAD } from "../src/map/stacks";

describe("stacked bodies", () => {
  it("a lone body stays put", () => {
    expect(stackBodies([{ id: "a", x: 40, y: 50 }], 16).get("a")).toEqual({ dx: 0, k: 0, n: 1 });
  });
  it("two bodies on one tile fan out either side and both know the stack is 2", () => {
    const m = stackBodies([{ id: "keel", x: 504, y: 520 }, { id: "lena", x: 505, y: 521 }, { id: "pix", x: 520, y: 520 }], 16);
    expect(m.get("keel")).toEqual({ dx: -STACK_SPREAD / 2, k: 0, n: 2 });
    expect(m.get("lena")).toEqual({ dx: STACK_SPREAD / 2, k: 1, n: 2 });
    expect(m.get("pix")).toEqual({ dx: 0, k: 0, n: 1 });
  });
  it("order within a stack is by id, whatever order the bodies come in", () => {
    const a = stackBodies([{ id: "b", x: 1, y: 1 }, { id: "a", x: 2, y: 2 }, { id: "c", x: 3, y: 3 }], 16);
    expect(["a", "b", "c"].map((id) => a.get(id)!.dx)).toEqual([-STACK_SPREAD, 0, STACK_SPREAD]);
  });
});
