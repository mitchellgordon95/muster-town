import { describe, expect, it } from "vitest";
import { BLOCKED_LABEL, UNBLOCK_LINE, blockedLabel, krAuthorLine, unfundableReason, explorationLine, grantSpendLine, grantStateLine, keyResultRows, krFundingLine, objectiveGroups, objectiveLine, krStatusLabel, krTone, proposalLine, settableStatuses, spentShare } from "../src/panels/keyResults";
import { MockApi } from "../src/mock/server";
import { stoplightOf } from "@muster-town/schema";
import { stoplightLabel } from "../src/format";

describe("board key-results view", () => {
  it("grant bar: spend / grant with a percentage, clamped", () => {
    expect(grantSpendLine({ spentTokens: 1_040_000, grantTokens: 2_000_000 })).toBe("1M / 2M adj. tokens (52%)");
    expect(spentShare(3, 2)).toBe(1);
    expect(spentShare(5, 0)).toBe(0);
    expect(grantStateLine({ status: "checkpoint" })).toMatch(/held/);
  });
  it("exploration meter and the proposal line (no buttons: it points at the Town Hall in-tray)", () => {
    expect(explorationLine({ spentTodayTokens: 1_150_000, allowanceTokens: 3_000_000 })).toBe("1.1M / 3M adj. tokens today");
    expect(proposalLine({ objective: "X", status: "proposed", askTokens: 4_000_000 })).toBe('Proposal "X" (asks 4M adj. tokens) is waiting for a human in the Town Hall in-tray.');
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
    expect(ws.proposals.map((p) => p.id)).toEqual(["gr_cli"]);
    expect(ws.exploration).toEqual({ allowanceTokens: 3_000_000, spentTodayTokens: 1_150_000 });
    const carbon = await api.board("bl_carbon");
    expect(carbon.grants).toEqual([]);
    expect(Array.isArray(carbon.docs)).toBe(true);
  });
  it("objective groups: each objective with its key results, then the ones under none; no objectives = one plain group", async () => {
    const api = new MockApi();
    const ws = await api.board("bl_workshop");
    const { rows } = keyResultRows(ws);
    const groups = objectiveGroups(ws.objectives, rows);
    expect(groups.map((g) => [g.objective?.kpiName ?? null, g.rows.map((r) => r.kr.id)])).toEqual([
      ["Trust", ["kr_bl_workshop_3"]], ["Join", ["kr_bl_workshop_0", "kr_bl_workshop_1"]], ["Fund", []], [null, ["kr_bl_workshop_2"]],
    ]);
    expect(objectiveLine(groups[0]!.objective!)).toBe("Moves Trust · 2026-Q4");
    expect(objectiveGroups({ objectives: [], unsorted: [] }, rows)).toEqual([{ objective: null, rows }]);
    const k = await api.kpis();
    expect(k.kpis.map((x) => x.name)).toEqual(["Fund", "Join", "Trust"]);
    expect(k.buildings.find((b) => b.buildingId === "bl_workshop")!.objectives).toHaveLength(3);
  });
  it("board rows: the goal's key results in order with the live grant on each; grants naming none are orphans", async () => {
    const api = new MockApi();
    const ws = await api.board("bl_workshop");
    expect(ws.blocked).toBeNull();
    const { rows, orphans } = keyResultRows(ws);
    expect(rows.map((r) => [r.kr.id, r.kr.status, r.grant?.id ?? null])).toEqual([
      ["kr_bl_workshop_0", "claimed", "gr_hud"], ["kr_bl_workshop_1", "met", "gr_tour"], ["kr_bl_workshop_2", "not-started", null], ["kr_bl_workshop_3", "not-started", null],
    ]);
    expect(orphans).toEqual([]);
    expect(krFundingLine(null)).toMatch(/open for exploration/);
    expect(krFundingLine(rows[0].grant)).toMatch(/held/);
    expect(krStatusLabel("not-started")).toBe("not started");
    const orphan = keyResultRows({ keyResults: [], grants: ws.grants });
    expect(orphan.orphans.map((g) => g.id)).toEqual(["gr_hud", "gr_tour"]);
  });
  it("settings edit path: a human adds, edits, judges and deletes a key result; one a grant names can't be deleted", async () => {
    const api = new MockApi();
    const k = await api.createKeyResult("bl_workshop", { text: " Strangers can fund ", howToCheck: "Open the Bank logged out" });
    expect(k.text).toBe("Strangers can fund");
    expect((await api.keyResults("bl_workshop")).keyResults.map((x) => x.id)).toContain(k.id);
    const edited = await api.updateKeyResult(k.id, { text: "Strangers can fund the Bank" });
    expect([edited.text, edited.status]).toEqual(["Strangers can fund the Bank", "not-started"]);
    expect((await api.updateKeyResult(k.id, { status: "met" })).status).toBe("met");
    await api.deleteKeyResult(k.id);
    expect((await api.keyResults("bl_workshop")).keyResults.map((x) => x.id)).not.toContain(k.id);
    await expect(api.deleteKeyResult("kr_bl_workshop_0")).rejects.toThrow(/gr_hud/);
    expect(settableStatuses(false)).not.toContain("met");
    expect(settableStatuses(true)).toContain("missed");
  });
  it("stoplight: the mock board and snapshot carry it for goal-directed buildings; the rule is the schema's", async () => {
    const api = new MockApi();
    const ws = await api.board("bl_workshop");
    expect(ws.stoplight).toEqual({ light: "yellow", reason: 'grant "HUD works on narrow screens" is held at its checkpoint; 2 of 4 key results have no funded grant' });
    const snap = await api.town();
    expect(snap.buildings.find((b) => b.id === "bl_workshop")?.stoplight?.light).toBe("yellow");
    expect(snap.buildings.find((b) => b.id === "bl_carbon")?.stoplight).toBeNull();
    expect((await api.board("bl_carbon")).stoplight).toBeNull();
    const kr = (grantId: string | null) => ({ grantId });
    expect(stoplightOf([kr("g")], [{ status: "funded", objective: "x" }])).toEqual({ light: "green", reason: "1 funded grant running on its key result" });
    expect(stoplightOf([kr(null)], [])).toEqual({ light: "red", reason: "no funded grant on its key result" });
    expect(stoplightOf([], [])).toEqual({ light: "red", reason: "no key results to work toward" });
    expect([stoplightLabel("green"), stoplightLabel("yellow"), stoplightLabel("red")]).toEqual(["Running", "Partly blocked", "Blocked"]);
  });

  it("mock: a lab with no key results and no live grant is blocked", async () => {
    const api = new MockApi();
    const b = await api.createBuilding({ name: "Empty", goal: "Nothing yet", headcount: 2 });
    expect((await api.board(b.id)).blocked).toMatch(/no key results/);
    await api.createKeyResult(b.id, { text: "One", howToCheck: "Look" });
    expect((await api.board(b.id)).blocked).toBeNull();
  });
});

describe("blocked state", () => {
  it("only a goal-directed building with blockedAt reads blocked; the Town Hall never does", () => {
    const at = "2026-10-25T18:00:00.000Z";
    expect(blockedLabel({ kind: "lab", budgetMode: "goal-directed", blockedAt: at })).toBe(BLOCKED_LABEL);
    expect(blockedLabel({ kind: "lab", budgetMode: "goal-directed", blockedAt: null })).toBeNull();
    expect(blockedLabel({ kind: "lab", budgetMode: "open", blockedAt: at })).toBeNull();
    expect(blockedLabel({ kind: "town-hall", budgetMode: "goal-directed", blockedAt: at })).toBeNull();
    expect(UNBLOCK_LINE).toMatch(/human/);
    expect(UNBLOCK_LINE).toMatch(/Settings/);
  });
  it("names who wrote a key result (a human or the manager) and who edited it; nothing for older ones", () => {
    expect(krAuthorLine({ createdByName: "Pix", editedByName: null })).toBe("Written by Pix");
    expect(krAuthorLine({ createdByName: "Pix", editedByName: "Pix" })).toBe("Written by Pix");
    expect(krAuthorLine({ createdByName: "Pix", editedByName: "Mitchell" })).toBe("Written by Pix, edited by Mitchell");
    expect(krAuthorLine({ createdByName: null, editedByName: "Mitchell" })).toBe("Edited by Mitchell");
    expect(krAuthorLine({})).toBeNull();
  });
  it("a proposal naming no key result can't be funded; one naming one can", () => {
    expect(unfundableReason({ status: "proposed", keyResult: null })).toMatch(/counter/);
    expect(unfundableReason({ status: "countered", keyResult: null })).toBeNull();
  });
  it("mock Town Hall in-tray lists blocked buildings; a building's own in-tray doesn't", async () => {
    const api = new MockApi();
    expect((await api.intray("bl_townhall")).blocked).toEqual([]);
    for (const id of ["gr_ocean", "gr_land"]) await api.decideGrant(id, { action: "reject", note: "" });
    for (const k of (await api.board("bl_carbon")).keyResults) await api.deleteKeyResult(k.id);
    expect((await api.intray("bl_townhall")).blocked?.map((x) => x.buildingId)).toEqual(["bl_carbon"]);
    expect((await api.intray("bl_carbon")).blocked).toEqual([]);
  });
});
