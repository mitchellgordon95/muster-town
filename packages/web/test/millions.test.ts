import { describe, expect, it } from "vitest";
import { fmtTokens, fromMillions, toMillions } from "../src/format";

describe("M tokens inputs", () => {
  it("prefills from a token count", () => {
    expect(toMillions(275_000_000)).toBe("275");
    expect(toMillions(500_000)).toBe("0.5");
    expect(toMillions(1_234_567)).toBe("1.234567");
  });
  it("converts back to whole tokens", () => {
    expect(fromMillions("275")).toBe(275_000_000);
    expect(fromMillions("0.5")).toBe(500_000);
    expect(fromMillions("1.1")).toBe(1_100_000);
    expect(fromMillions(" ")).toBeNaN();
    expect(fromMillions("x")).toBeNaN();
  });
  it("displays whole millions without .0", () => {
    expect(fmtTokens(4_000_000)).toBe("4M");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    expect(fmtTokens(40_000_000)).toBe("40M");
  });
});
