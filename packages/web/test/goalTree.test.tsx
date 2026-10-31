import { describe, expect, it } from "vitest";
import type { GoalTreeNode } from "@muster-town/schema";
import { archivedLine, buildingScope, canEditGoal, moveTargets, nodeGlance, pastDue, pathTo, proposalVerb, retireMoves, retirePlan, treeRows, visibleRows } from "../src/panels/goalTree";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalProposalView } from "../src/api";
import { ProposalCard, RetireConfirm, proposalNode } from "../src/panels/GoalTreePanel";
import { clock, dayClock } from "../src/panels/ui";

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

  it("move and retire cards say what happens: moves under, is retired and what goes where (mt_n25udpflus)", () => {
    expect(proposalVerb("move", "Steer")).toEqual({ verb: "moves under", dest: "Steer" });
    expect(proposalVerb("retire", "Steer")).toEqual({ verb: "is retired; its open key results and attached buildings go under", dest: "Steer" });
    expect(proposalVerb("retire", null)).toEqual({ verb: "is retired; nothing open hangs under it", dest: null });
    expect(proposalVerb("retire", null, true)!.verb).toMatch(/no sibling is named/);
    expect(proposalVerb("edit", "Steer")).toBeNull();
    expect(retireMoves(retirePlan(sample(), "gl_a"), "gl_b")).toEqual({ buildings: ["Workshop moves under gl_b"], krs: ['Key result "kr1" moves under gl_b'] });
  });

  it("a retire with a building attached asks to confirm, naming each building; one without accepts at once", () => {
    const me = { userId: "u_mitchell", townWide: true };
    const p = (over: Partial<GoalProposalView>): GoalProposalView => ({ id: "gp_1", action: "retire", targetId: "gl_a", parentId: "gl_b", fields: {}, why: "done", proposedBy: "ag_x", buildingId: null, reorgId: null, sourceDocIds: [], status: "open", decidedBy: null, decidedAt: null, note: "", resultId: null, createdAt: "2026-10-31T00:00:00Z", proposedByName: "Pix", outsideScope: false, ...over });
    const card = (over: Partial<GoalProposalView>) => renderToStaticMarkup(<ProposalCard root={sample()} p={p(over)} me={me} onDone={() => {}} />);
    const retire = card({});
    expect(retire).toContain("gl_a <span class=\"muted\">is retired; its open key results and attached buildings go under</span> <b>gl_b</b>");
    expect(retire).toContain("Accept…"); // opens the confirmation instead of accepting
    expect(card({ action: "move", targetId: "gl_b", parentId: "gl_c" })).toContain("gl_b <span class=\"muted\">moves under</span> <b>gl_c</b>");
    expect(card({ action: "move", targetId: "gl_b", parentId: "gl_c" })).not.toContain("→");
    expect(card({ targetId: "gl_b", parentId: null })).toContain("is retired; nothing open hangs under it");
    expect(card({ targetId: "gl_b", parentId: null })).not.toContain("Accept…");
    const plan = retirePlan(sample(), "gl_a");
    const confirm = renderToStaticMarkup(<RetireConfirm goal="gl_a" plan={plan} dest="Steer (goal-directed)" confirmLabel="Accept and retire" onConfirm={async () => {}} onCancel={() => {}} />);
    expect(confirm).toContain("Workshop moves under Steer (goal-directed)");
    expect(confirm).toContain("Key result &quot;kr1&quot; moves under Steer (goal-directed)");
    expect(confirm).toContain("A building is never archived here; it moves");
    expect(confirm).toContain("Accept and retire");
    expect(confirm).toContain("Cancel");
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

describe("goal History stamps (Feed)", () => {
  it("carries the month and day, so events days apart don't read as one day", () => {
    const a = new Date(2026, 9, 26, 9, 5).toISOString();
    const b = new Date(2026, 9, 29, 14, 2).toISOString();
    expect(dayClock(a)).toMatch(/^10-26 /);
    expect(dayClock(b)).toMatch(/^10-29 /);
    expect(dayClock(b)).toContain(clock(b));
  });
});

describe("the goal tree editor's nodes (UX pass dc_yn8gl1rmyt)", () => {
  it("collapsing a goal hides everything under it, not the goal itself", () => {
    const root = sample();
    expect(visibleRows(root, false, new Set()).map((r) => r.node.id)).toEqual(treeRows(root, false).map((r) => r.node.id));
    expect(visibleRows(root, false, new Set(["gl_fund"])).map((r) => r.node.id)).toEqual(["gl_town", "gl_fund", "gl_join", "gl_c"]);
    expect(visibleRows(root, true, new Set(["gl_town"])).map((r) => r.node.id)).toEqual(["gl_town"]);
  });

  it("a node at a glance: open key results, funded, late and the nearest due date (archived ones left out)", () => {
    const krs = [kr("k1", "on-track", "2026-10-01"), { ...kr("k2", "at-risk", "2026-12-01"), grantId: "gr_1" }, kr("k3", "met", "2026-09-01"), kr("k4", "not-started", null)];
    expect(nodeGlance({ keyResults: krs }, "2026-10-30")).toEqual({ open: 3, funded: 1, late: 1, nextDue: "2026-10-01" });
    expect(nodeGlance({ keyResults: [] }, "2026-10-30")).toEqual({ open: 0, funded: 0, late: 0, nextDue: null });
  });
});
