import { describe, expect, it } from "vitest";
import { drawBankSign } from "../src/map/overlay";

/** A canvas context that records the text drawn and ignores everything else. */
function fakeCtx() {
  const texts: string[] = [];
  const grad = { addColorStop() {} };
  const g = new Proxy({} as Record<string, unknown>, {
    get(_, k) {
      if (k === "fillText") return (t: string) => texts.push(t);
      if (k === "measureText") return (t: string) => ({ width: t.length * 7 });
      if (k === "createLinearGradient") return () => grad;
      return () => {};
    },
    set() { return true; },
  });
  return { g: g as unknown as CanvasRenderingContext2D, texts };
}

describe("the Bank's marquee", () => {
  it("shows the town total, then claimed (reservations + asks + funded remaining) and free", () => {
    const { g, texts } = fakeCtx();
    drawBankSign(g, 0, 0, { townTokens: 1_234_567, free: { reservedTokens: 50, openAsksTokens: 200, fundedRemainingTokens: 500, freeTokens: 250 } }, 0);
    expect(texts).toContain("1,234,567");
    expect(texts).toEqual(expect.arrayContaining(["CLAIMED", "750", "FREE", "250"]));
    for (const old of ["EXPIRES TODAY", "PERMANENT", "HELD BY BUILDINGS"]) expect(texts).not.toContain(old);
  });
  it("shows … for claimed and free when the server has no free-tokens figure", () => {
    const { g, texts } = fakeCtx();
    drawBankSign(g, 0, 0, { townTokens: 10, free: null }, 0);
    expect(texts.filter((t) => t === "…").length).toBe(2);
  });
});
