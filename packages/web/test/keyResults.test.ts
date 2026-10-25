import { describe, expect, it } from "vitest";
import { explorationLine, grantSpendLine, grantStateLine, krTone, proposalLine, spentShare } from "../src/panels/keyResults";
import { MockApi } from "../src/mock/server";

describe("board key-results view", () => {
  it("grant bar: spend / grant with a percentage, clamped", () => {
    expect(grantSpendLine({ spentTokens: 1_040_000, grantTokens: 2_000_000 })).toBe("1M / 2M tokens (52%)");
    expect(spentShare(3, 2)).toBe(1);
    expect(spentShare(5, 0)).toBe(0);
    expect(grantStateLine({ status: "checkpoint" })).toMatch(/held/);
  });
  it("exploration meter and the proposal line (no buttons: it points at the Town Hall in-tray)", () => {
    expect(explorationLine({ spentTodayTokens: 1_150_000, allowanceTokens: 3_000_000 })).toBe("1.1M / 3M tokens today");
    expect(proposalLine({ objective: "X", status: "proposed", askTokens: 4_000_000 })).toBe('Proposal "X" (asks 4M tokens) is waiting for a human in the Town Hall in-tray.');
    expect(proposalLine({ objective: "X", status: "countered", askTokens: 1 })).toMatch(/countered/);
  });
  it("key-result tones", () => {
    expect([krTone("met"), krTone("missed"), krTone("claimed"), krTone("not-started")]).toEqual(["ok", "bad", "warn", ""]);
  });
  it("mock board: a goal-directed building gets its live grants, open proposal and exploration; an open one none", async () => {
    const api = new MockApi();
    const ws = await api.board("bl_workshop");
    expect(ws.goal).toMatch(/Muster Town/);
    expect(ws.grants.map((g) => [g.id, g.status])).toEqual([["gr_hud", "checkpoint"], ["gr_tour", "funded"]]);
    expect(ws.proposal?.id).toBe("gr_cli");
    expect(ws.exploration).toEqual({ allowanceTokens: 3_000_000, spentTodayTokens: 1_150_000 });
    const carbon = await api.board("bl_carbon");
    expect(carbon.grants).toEqual([]);
    expect(Array.isArray(carbon.docs)).toBe(true);
  });
});
