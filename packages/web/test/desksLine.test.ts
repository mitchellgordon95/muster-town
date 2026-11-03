import { describe, expect, it } from "vitest";
import type { GoalTreeNode } from "@muster-town/schema";
import { desksText } from "../src/panels/FreeTokens";

const funding = (desksTotal: GoalTreeNode["funding"]["desksTotal"]) => ({ exploreCap: null, explore: { on: true, onFrom: null, chunkTokens: 100_000, chunkFrom: null }, exploreSpentTodayTokens: 0, desksTotal, free: {} as never });
const leaf = { id: "gl_a1", parentId: "gl_a", text: "A1", status: "active", ownerId: null, owner: { goalId: "gl_town", userId: null, name: "M" }, buildings: [], keyResults: [], exploreCapTokensPerDay: null, explore: null, exploreChunkTokens: null, children: [], funding: funding({ total: 8, goalId: "gl_a", desks: 5 }) } as GoalTreeNode;
const a = { ...leaf, id: "gl_a", parentId: "gl_town", text: "Steer the town", children: [leaf], funding: funding({ total: 8, goalId: "gl_a", desks: 5 }) } as GoalTreeNode;
const root = { ...leaf, id: "gl_town", parentId: null, text: "Town", children: [a], funding: funding(null) } as GoalTreeNode;

describe("the goal tree's desk line (gr_yu6qw3j9x5)", () => {
  it("names the desks under the goal that sets the total, the total, and that goal; nothing when none is set", () => {
    expect(desksText(a, root)).toBe("Desks: 5 of 8 (set on this goal)");
    expect(desksText(leaf, root)).toMatch(/^Desks: 5 of 8 \(set on goal Steer the town\)$/);
    expect(desksText(root, root)).toBeNull();
  });
});
