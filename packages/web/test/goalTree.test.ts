import { describe, expect, it } from "vitest";
import type { GoalTreeNode } from "@muster-town/schema";
import { archivedLine, buildingScope, canEditGoal, moveTargets, pastDue, pathTo, retirePlan, treeRows } from "../src/panels/goalTree";
import { proposalNode } from "../src/panels/GoalTreePanel";

const kr = (id: string, status: string, due: string | null = "2026-12-01", archivedAt: string | null = null) =>
  ({ id, text: id, howToCheck: "look", status, due, archivedAt, buildingId: "b", grantId: null });
const admins = { goalId: "gl_town", userId: null, name: "the town admins" };
function goal(id: string, parentId: string | null, over: Partial<GoalTreeNode> = {}): GoalTreeNode {
  return { id, parentId, text: id, status: "active", ownerId: null, owner: admins, buildings: [], keyResults: [], children: [], ...over };
}
/** root › fund › (a [workshop, kr1 open, kr2 met], b), join (owned by u_ann) › c [kr3 missed] */
function sample(): GoalTreeNode {
  const ann = { goalId: "gl_join", userId: "u_ann", name: "Ann" };
  const a = goal("gl_a", "gl_fund", { buildings: [{ id: "workshop", name: "Workshop" }], keyResults: [kr("kr1", "on-track", "2026-10-01"), kr("kr2", "met")] });
  const b = goal("gl_b", "gl_fund");
  const c = goal("gl_c", "gl_join", { owner: ann, keyResults: [kr("kr3", "missed")] });
  const old = goal("gl_old", "gl_join", { status: "retired", owner: ann });
  return goal("gl_town", null, { children: [goal("gl_fund", "gl_town", { children: [a, b] }), goal("gl_join", "gl_town", { ownerId: "u_ann", owner: ann, children: [c, old] })] });
}

describe("the Town Hall goal editor (docs/goals.md, step 3)", () => {
  it("rows: retired goals only behind Show retired; archived key results fold to one line; past due is amber", () => {
    const root = sample();
    expect(treeRows(root, false).map((r) => r.node.id)).toEqual(["gl_town", "gl_fund", "gl_a", "gl_b", "gl_join", "gl_c"]);
    expect(treeRows(root, true).map((r) => r.node.id)).toContain("gl_old");
    expect(treeRows(root, false).find((r) => r.node.id === "gl_c")!.depth).toBe(2);
    expect(archivedLine(pathTo(root, "gl_a").at(-1)!.keyResults)).toBe("✓ 1 done");
    expect(archivedLine([kr("x", "missed"), kr("y", "met"), kr("z", "on-track")])).toBe("✓ 1 done, 1 missed");
    expect(archivedLine([kr("z", "on-track")])).toBeNull();
    expect(pastDue(kr("x", "on-track", "2026-10-01"), "2026-10-30")).toBe(true);
    expect(pastDue(kr("x", "met", "2026-10-01"), "2026-10-30")).toBe(false);
    expect(pastDue(kr("x", "on-track", "2026-11-01"), "2026-10-30")).toBe(false);
  });

  it("goals.edit: admins anywhere; an owner within their subtree only; guests nowhere", () => {
    const root = sample();
    const c = pathTo(root, "gl_c").at(-1)!, a = pathTo(root, "gl_a").at(-1)!;
    expect(canEditGoal(a, { userId: "u_mitchell", townWide: true })).toBe(true);
    expect(canEditGoal(c, { userId: "u_ann", townWide: false })).toBe(true);
    expect(canEditGoal(a, { userId: "u_ann", townWide: false })).toBe(false);
    expect(canEditGoal(a, { userId: null, townWide: false })).toBe(false);
  });

  it("retire: open key results and buildings must move to an active sibling; move never goes under itself", () => {
    const root = sample();
    const plan = retirePlan(root, "gl_a");
    expect(plan.openKrs.map((k) => k.id)).toEqual(["kr1"]);
    expect(plan.buildings.map((b) => b.id)).toEqual(["workshop"]);
    expect(plan.siblings.map((s) => s.id)).toEqual(["gl_b"]);
    expect(retirePlan(root, "gl_c").siblings.map((s) => s.id)).toEqual([]); // the retired sibling doesn't count
    const targets = moveTargets(root, "gl_fund").map((r) => r.node.id);
    expect(targets).not.toContain("gl_a");
    expect(targets).not.toContain("gl_fund");
    expect(targets).not.toContain("gl_town"); // already its parent
    expect(targets).toContain("gl_c");
  });

  it("the building filter covers the building's attachment and everything under it", () => {
    expect([...buildingScope(sample(), "workshop")]).toEqual(["gl_a"]);
    expect(buildingScope(sample(), "nowhere").size).toBe(0);
  });

  it("a proposal belongs to its target goal, a target key result's goal, or where it goes", () => {
    const root = sample();
    expect(proposalNode(root, { action: "edit", targetId: "gl_c", parentId: null }).id).toBe("gl_c");
    expect(proposalNode(root, { action: "edit", targetId: "kr1", parentId: null }).id).toBe("gl_a");
    expect(proposalNode(root, { action: "add-kr", targetId: null, parentId: "gl_b" }).id).toBe("gl_b");
    expect(proposalNode(root, { action: "move", targetId: "gl_a", parentId: "gl_join" }).id).toBe("gl_a");
    expect(proposalNode(root, { action: "add-goal", targetId: null, parentId: null }).id).toBe("gl_town");
  });
});
