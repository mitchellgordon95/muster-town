import { describe, expect, it } from "vitest";
import { BLOCKED_LABEL, UNBLOCK_LINE, blockedLabel, goalsSummary, grantGroups, grantSteps, grantsSummary, krAuthorLine, krGrantWord, unfundableReason, grantSpendLine, objectiveLine, krStatusLabel, krTone, settableStatuses, spentShare } from "../src/panels/keyResults";
import type { FinanceSpend } from "../src/api";
import { MockApi } from "../src/mock/server";
import { stoplightOf } from "@muster-town/schema";
import { stoplightLabel } from "../src/format";

describe("board key-results view", () => {
  it("grant bar: spend / grant with a percentage, clamped", () => {
    expect(grantSpendLine({ spentTokens: 1_040_000, grantTokens: 2_000_000 })).toBe("1M / 2M adj. tokens (52%)");
    expect(spentShare(3, 2)).toBe(1);
    expect(spentShare(5, 0)).toBe(0);
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
    // no allowance: the root's town-wide cap with today's use, and the free tokens under the building's goal
    expect(ws.exploration).toMatchObject({ spentTodayTokens: 1_150_000, cap: { tokensPerDay: 3_000_000, goalId: "gl_town", spentTodayTokens: 1_150_000 } });
    expect(ws.exploration.freeTokens).toBeGreaterThan(0);
    const carbon = await api.board("bl_carbon");
    expect(carbon.grants).toEqual([]);
    expect(Array.isArray(carbon.docs)).toBe(true);
  });
  it("Goals tab: one grant word per key result and the Overview line; the mock's objectives carry their KPI", async () => {
    const api = new MockApi();
    const tree = await api.objectives("bl_workshop");
    const grants = await api.grants("bl_workshop");
    expect(grants.map((g) => [g.id, g.status]).sort()).toEqual([["gr_cli", "countered"], ["gr_hud", "checkpoint"], ["gr_tour", "funded"]]);
    const all = [...tree.objectives.flatMap((o) => o.keyResults), ...tree.unsorted];
    expect(all.map((k) => [k.id, krGrantWord(k.id, grants)]).sort()).toEqual([
      ["kr_bl_workshop_0", "funded"], ["kr_bl_workshop_1", "funded"], ["kr_bl_workshop_2", "proposed"], ["kr_bl_workshop_3", "open"],
    ]);
    expect(goalsSummary(tree, grants)).toBe("3 objectives, 4 key results, 2 funded");
    expect(objectiveLine(tree.objectives[0]!)).toBe("Moves Trust · 2026-Q4");
    expect(krStatusLabel("not-started")).toBe("not started");
    expect(krGrantWord("kr_x", [{ keyResultId: "kr_x", status: "closed" }])).toBe("open");
    const k = await api.kpis();
    expect(k.kpis.map((x) => x.name)).toEqual(["Fund", "Join", "Trust"]);
  });
  it("Grants tab: open proposals oldest first, then funded, then checkpoint / closed / rejected; drafts left out", () => {
    const g = (id: string, status: string, createdAt: string, updatedAt = createdAt) => ({ id, status, createdAt, updatedAt, fundedAt: null }) as unknown as Parameters<typeof grantGroups>[0][number];
    const list = [g("a", "closed", "1", "5"), g("b", "proposed", "3"), g("c", "funded", "2"), g("d", "countered", "1"), g("e", "checkpoint", "1", "9"), g("f", "draft", "1"), g("h", "rejected", "1", "2")];
    const { proposals, funded, settled } = grantGroups(list);
    expect([proposals.map((x) => x.id), funded.map((x) => x.id), settled.map((x) => x.id)]).toEqual([["d", "b"], ["c"], ["e", "a", "h"]]);
    expect(grantsSummary(list)).toBe("2 proposals, 1 funded, 3 closed or held");
    expect(grantsSummary([g("b", "proposed", "3")])).toBe("1 proposal, 0 funded");
    // funded grants on key results outside the goal (named before the building moved) are called out against the Goals line
    const on = (id: string, kr: string) => ({ ...g(id, "funded", "2"), keyResultId: kr });
    expect(grantsSummary([on("x", "kr_in"), on("y", "kr_old")], new Set(["kr_in"]))).toBe("0 proposals, 2 funded (1 on a key result outside this goal)");
    expect(grantsSummary([on("x", "kr_old"), on("y", "kr_old2")], new Set(["kr_in"]))).toBe("0 proposals, 2 funded (all on key results outside this goal)");
    expect(grantsSummary([on("x", "kr_old")], new Set())).toBe("0 proposals, 1 funded (on a key result outside this goal)");
    expect(grantsSummary([on("x", "kr_in")], new Set(["kr_in"]))).toBe("0 proposals, 1 funded");
  });
  it("a grant's step assignments come from the finance spend tree (building → grant → assignment)", () => {
    const spend = { rows: [{ kind: "building", id: "b1", name: "B", tokens: 9, share: 1, sessions: 3, children: [
      { kind: "grant", id: "gr_1", name: "G", tokens: 9, share: 1, sessions: 3, children: [
        { kind: "assignment", id: "as_1", name: "Step 1", tokens: 5, share: 0.5, sessions: 2 },
        { kind: "no-assignment", id: null, name: "other", tokens: 4, share: 0.5, sessions: 1 },
      ] },
    ] }] } as unknown as FinanceSpend;
    expect(grantSteps(spend, "b1", "gr_1").map((s) => s.name)).toEqual(["Step 1"]);
    expect(grantSteps(spend, "b1", "gr_2")).toEqual([]);
    expect(grantSteps(null, "b1", "gr_1")).toEqual([]);
  });
  it("settings edit path: a human edits and judges a grant's key result; one an open grant carries can't be deleted", async () => {
    const api = new MockApi();
    const k = (await api.keyResults("bl_workshop")).keyResults[0]!;
    const edited = await api.updateKeyResult(k.id, { text: "Strangers can fund the Bank" });
    expect(edited.text).toBe("Strangers can fund the Bank");
    expect((await api.updateKeyResult(k.id, { status: "met" })).status).toBe("met");
    await expect(api.deleteKeyResult("kr_bl_workshop_0")).rejects.toThrow(/gr_hud/);
    expect(settableStatuses(false)).not.toContain("met");
    expect(settableStatuses(true)).toContain("missed");
  });
  it("stoplight: the mock board and snapshot carry it for every lab, never the Town Hall; the rule is the schema's", async () => {
    const api = new MockApi();
    const ws = await api.board("bl_workshop");
    expect(ws.stoplight).toEqual({ light: "yellow", reason: 'grant "HUD works on narrow screens" is held at its checkpoint' });
    const snap = await api.town();
    expect(snap.buildings.find((b) => b.id === "bl_workshop")?.stoplight?.light).toBe("yellow");
    expect(snap.buildings.find((b) => b.id === "bl_carbon")?.stoplight?.light).toBe("grey");
    expect((await api.board("bl_carbon")).stoplight?.light).toBe("grey");
    expect(snap.buildings.find((b) => b.id === "bl_townhall")?.stoplight).toBeNull();
    expect(stoplightOf([{ status: "funded", objective: "x" }])).toEqual({ light: "green", reason: "1 funded grant running" });
    expect(stoplightOf([{ status: "checkpoint", objective: "x" }])).toEqual({ light: "yellow", reason: 'grant "x" is held at its checkpoint' });
    expect(stoplightOf([])).toEqual({ light: "grey", reason: "no funded grant: the building explores or idles" });
    expect([stoplightLabel("green"), stoplightLabel("yellow"), stoplightLabel("grey")]).toEqual(["Running", "Held at a checkpoint", "No funded grant"]);
  });

  it("mock: a lab with no grant is not blocked (key results belong to grants)", async () => {
    const api = new MockApi();
    const b = await api.createBuilding({ name: "Empty", headcount: 2 });
    expect((await api.board(b.id)).blocked).toBeNull();
    expect((await api.board(b.id)).stoplight?.light).toBe("grey");
  });
});

describe("blocked state", () => {
  it("only a lab with blockedAt reads blocked; the Town Hall never does", () => {
    const at = "2026-10-25T18:00:00.000Z";
    expect(blockedLabel({ kind: "lab", blockedAt: at })).toBe(BLOCKED_LABEL);
    expect(blockedLabel({ kind: "lab", blockedAt: null })).toBeNull();
    expect(blockedLabel({ kind: "town-hall", blockedAt: at })).toBeNull();
    expect(UNBLOCK_LINE).toMatch(/human/);
    expect(UNBLOCK_LINE).toMatch(/grant with its own key results/);
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
  it("mock Town Hall in-tray: a building with no grants and no key results is not blocked", async () => {
    const api = new MockApi();
    expect((await api.intray("bl_townhall")).blocked).toEqual([]);
    for (const id of ["gr_ocean", "gr_land"]) await api.decideGrant(id, { action: "reject", note: "" });
    for (const k of (await api.board("bl_carbon")).keyResults) await api.deleteKeyResult(k.id);
    expect((await api.intray("bl_townhall")).blocked).toEqual([]);
    expect((await api.intray("bl_carbon")).blocked).toEqual([]);
  });
});
