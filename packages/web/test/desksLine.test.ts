import { describe, expect, it } from "vitest";
import type { GoalTreeNode } from "@muster-town/schema";
import { desksBuyLine } from "../src/panels/FreeTokens";

const funding = (desksTotal: GoalTreeNode["funding"]["desksTotal"], cap: number, on = true) => ({ exploreCap: { tokensPerDay: cap, goalId: desksTotal?.goalId ?? "gl_town" }, explore: { on, onFrom: null, chunkTokens: 100_000, chunkFrom: null }, exploreSpentTodayTokens: 0, desksTotal, free: {} as never });
const b = (id: string, headcount: number) => ({ id, name: id, headcount, inUse: 0 });
const leaf = { id: "gl_a1", parentId: "gl_a", text: "A1", status: "active", ownerId: null, owner: { goalId: "gl_town", userId: null, name: "M" }, buildings: [b("l1", 3)], keyResults: [], exploreCapTokensPerDay: null, explore: null, exploreChunkTokens: null, children: [], funding: funding({ total: 8, goalId: "gl_a", desks: 5 }, 181_816) } as unknown as GoalTreeNode;
const a = { ...leaf, id: "gl_a", parentId: "gl_town", text: "Steer the town", buildings: [b("l2", 2)], children: [leaf], funding: funding({ total: 8, goalId: "gl_a", desks: 5 }, 181_816) } as GoalTreeNode;
const root = { ...leaf, id: "gl_town", parentId: null, text: "Town", buildings: [b("th", 1)], children: [a], funding: funding(null, 136_362) } as GoalTreeNode;

describe("what a goal's desks buy (gr_bre43gflz9 step 2)", () => {
  it("names the desks in force, the goal that sets them, the exploration they buy and the forks at once", () => {
    expect(desksBuyLine(a, root).long).toMatch(/^8 desks: up to 182k exploration a day, 100k per explorer, grants in flight no limit, 8 forks at once/);
    expect(desksBuyLine(leaf, root).short).toBe("8 desks (set on goal Steer the town)");
  });
  it("counts the desks of the buildings under a goal when no total is set, and says when exploration is off", () => {
    expect(desksBuyLine(root, root).desks).toBe(6);
    expect(desksBuyLine({ ...root, funding: funding(null, 136_362, false) }, root).long).toMatch(/^6 desks: exploration off for the town, grants in flight no limit, 6 forks at once$/);
  });
});
