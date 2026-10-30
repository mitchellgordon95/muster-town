import { useEffect, useState } from "react";
import { ROOT_GOAL_ID, type GoalTreeNode } from "@muster-town/schema";
import { api } from "../api";

/** The town goal tree flattened for a select: each active goal with its depth (docs/goals.md). */
function flatten(n: GoalTreeNode, depth = 0): { id: string; text: string; depth: number }[] {
  return [{ id: n.id, text: n.text, depth }, ...n.children.filter((c) => c.status === "active").flatMap((c) => flatten(c, depth + 1))];
}

/** Loads GET /api/goals once; null until it arrives. */
export function useGoalTree(): GoalTreeNode | null {
  const [root, setRoot] = useState<GoalTreeNode | null>(null);
  useEffect(() => { api().goalTree().then(setRoot, () => undefined); }, []);
  return root;
}

/** "Root › … › goal" for a goal id, from a loaded tree. */
export function goalPath(root: GoalTreeNode | null, id: string | null | undefined): string {
  const find = (n: GoalTreeNode, trail: string[]): string[] | null => {
    const here = [...trail, n.text];
    if (n.id === id) return here;
    for (const c of n.children) { const r = find(c, here); if (r) return r; }
    return null;
  };
  return (root && find(root, []))?.join(" › ") ?? id ?? "";
}

/** A select of the tree's active goals, indented by depth; never empty (a building is always attached: default the root). */
export function GoalPicker({ value, onChange, disabled }: { value: string | null | undefined; onChange: (goalId: string) => void; disabled?: boolean }) {
  const root = useGoalTree();
  const options = root ? flatten(root) : [{ id: value ?? ROOT_GOAL_ID, text: value ?? "The town goal", depth: 0 }];
  return (
    <select value={value ?? ROOT_GOAL_ID} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.id} value={o.id}>{`${"  ".repeat(o.depth)}${o.depth ? "› " : ""}${o.text.length > 70 ? `${o.text.slice(0, 69)}…` : o.text}`}</option>)}
    </select>
  );
}
