/**
 * Pure helpers for the Town Hall goal editor (docs/goals.md "The Town Hall goal editor"): who may edit a node, the
 * rows the tree shows, archived key results folded under their goal, past-due dates, and the retire dialog's choices.
 */
import type { GoalTreeNode } from "@muster-town/schema";

export type TreeKr = GoalTreeNode["keyResults"][number];

/** A key result is archived once a human marks it met or missed (or it was archived on its own). */
export const isArchived = (k: Pick<TreeKr, "status" | "archivedAt">) => !!k.archivedAt || k.status === "met" || k.status === "missed";

/** "✓ 4 done, 1 missed" for a goal's archived key results, or null when it has none. */
export function archivedLine(krs: Pick<TreeKr, "status" | "archivedAt">[]): string | null {
  const done = krs.filter((k) => isArchived(k) && k.status !== "missed").length;
  const missed = krs.filter((k) => isArchived(k) && k.status === "missed").length;
  if (!done && !missed) return null;
  return `✓ ${done} done${missed ? `, ${missed} missed` : ""}`;
}

/** An open key result's due date is past (amber in the tree). `today` is YYYY-MM-DD. */
export function pastDue(k: Pick<TreeKr, "due" | "status" | "archivedAt">, today: string): boolean {
  return !!k.due && !isArchived(k) && k.due < today;
}

/** Find a goal in the tree. */
export function findGoal(root: GoalTreeNode, id: string): GoalTreeNode | null {
  if (root.id === id) return root;
  for (const c of root.children) { const hit = findGoal(c, id); if (hit) return hit; }
  return null;
}

/** The goal's path from the root (the root first, the goal last). */
export function pathTo(root: GoalTreeNode, id: string): GoalTreeNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) { const p = pathTo(c, id); if (p.length) return [root, ...p]; }
  return [];
}

/**
 * `goals.edit` at a node as the web sees it: a town admin (or a role with goals.edit) anywhere; otherwise the owner of
 * the node or of a goal above it (the tree carries each node's effective owner, so one comparison covers inheritance).
 * Mirrors core Goals.canEdit; the server checks again.
 */
export function canEditGoal(node: Pick<GoalTreeNode, "owner">, me: { userId: string | null; townWide: boolean }): boolean {
  if (me.townWide) return true;
  return !!me.userId && node.owner.userId === me.userId;
}

/** Every goal id at or under `id`. */
export function subtreeIds(node: GoalTreeNode): Set<string> {
  const out = new Set<string>([node.id]);
  for (const c of node.children) for (const id of subtreeIds(c)) out.add(id);
  return out;
}

/** The goals a building's subtree covers: its attachment and everything under it (the building filter). */
export function buildingScope(root: GoalTreeNode, buildingId: string): Set<string> {
  const walk = (n: GoalTreeNode): GoalTreeNode | null => n.buildings.some((b) => b.id === buildingId) ? n : n.children.map(walk).find(Boolean) ?? null;
  const at = walk(root);
  return at ? subtreeIds(at) : new Set();
}

/** Every building attached anywhere in the tree, in tree order. */
export function allBuildings(root: GoalTreeNode): { id: string; name: string }[] {
  return [...root.buildings, ...root.children.flatMap(allBuildings)];
}

/** One line of the tree as the editor lists it: the goal and its depth. Retired goals only when `retired`. */
export function treeRows(root: GoalTreeNode, retired: boolean, depth = 0): { node: GoalTreeNode; depth: number }[] {
  if (root.status === "retired" && !retired) return [];
  return [{ node: root, depth }, ...root.children.flatMap((c) => treeRows(c, retired, depth + 1))];
}

/**
 * The Retire dialog's picture: the open key results and attached buildings that must move (the goal's and any below
 * it), and the active siblings they may move to. Without a sibling, retiring is refused while anything must move.
 */
export function retirePlan(root: GoalTreeNode, id: string): { openKrs: TreeKr[]; buildings: { id: string; name: string }[]; siblings: GoalTreeNode[] } {
  const node = findGoal(root, id);
  if (!node) return { openKrs: [], buildings: [], siblings: [] };
  const below = (n: GoalTreeNode): GoalTreeNode[] => [n, ...n.children.flatMap(below)];
  const nodes = below(node);
  const parent = node.parentId ? findGoal(root, node.parentId) : null;
  return {
    openKrs: nodes.flatMap((n) => n.keyResults.filter((k) => !isArchived(k))),
    buildings: nodes.flatMap((n) => n.buildings),
    siblings: (parent?.children ?? []).filter((c) => c.id !== id && c.status === "active"),
  };
}

/** Goals a node may move under: any active goal outside its own subtree (a goal can't move under itself). */
export function moveTargets(root: GoalTreeNode, id: string): { node: GoalTreeNode; depth: number }[] {
  const node = findGoal(root, id);
  const mine = node ? subtreeIds(node) : new Set<string>();
  return treeRows(root, false).filter((r) => !mine.has(r.node.id) && r.node.id !== node?.parentId);
}

/** The tree rows with collapsed goals' subtrees left out (the editor's expand/collapse). */
export function visibleRows(root: GoalTreeNode, retired: boolean, collapsed: ReadonlySet<string>, depth = 0): { node: GoalTreeNode; depth: number }[] {
  if (root.status === "retired" && !retired) return [];
  const below = collapsed.has(root.id) ? [] : root.children.flatMap((c) => visibleRows(c, retired, collapsed, depth + 1));
  return [{ node: root, depth }, ...below];
}

/** A tree node at a glance: its open key results, how many are funded and past due, and the nearest open due date. */
export function nodeGlance(node: Pick<GoalTreeNode, "keyResults">, today: string): { open: number; funded: number; late: number; nextDue: string | null } {
  const open = node.keyResults.filter((k) => !isArchived(k));
  const dues = open.map((k) => k.due).filter((d): d is string => !!d).sort();
  return { open: open.length, funded: open.filter((k) => !!k.grantId).length, late: open.filter((k) => pastDue(k, today)).length, nextDue: dues[0] ?? null };
}
