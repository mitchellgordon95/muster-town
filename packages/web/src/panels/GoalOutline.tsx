/**
 * The goal tree as an outline (grant gr_nhayb7s9bd step 2): one indented row per goal with its words, captain and open
 * key results. A phone (≤ 760 px) opens the goal tree on it; "Map" switches to the canvas (GoalCanvas.tsx). A tap (or
 * Enter) selects the goal and opens its detail below. For a keyboard and a screen reader it is a role=tree list:
 * one tab stop (the selected row), ↑ ↓ Home End move between rows.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { GoalTreeNode } from "@muster-town/schema";
import { outlineMeta, outlineStep, treeRows } from "./goalTree";

type Props = {
  root: GoalTreeNode;
  retired: boolean;
  selected: string;
  /** the building filter: goals outside it are dimmed */
  scope: ReadonlySet<string> | null;
  /** open proposals by goal id */
  proposals: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
  /** after a tap: bring the detail into view */
  onOpen?: () => void;
};

/** Indent per level, capped so a deep goal still has room for its words. */
const indent = (depth: number) => 10 + Math.min(depth, 6) * 14;

export function GoalOutline({ root, retired, selected, scope, proposals, onSelect, onOpen }: Props) {
  const rows = treeRows(root, retired);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const at = Math.max(0, rows.findIndex((r) => r.node.id === selected));
  useEffect(() => { items.current[at]?.scrollIntoView?.({ block: "nearest" }); }, [at]);
  const pick = (id: string) => { onSelect(id); onOpen?.(); };
  const key = (e: KeyboardEvent<HTMLLIElement>, i: number) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(rows[i].node.id); return; }
    const to = outlineStep(e.key, i, rows.length);
    if (to === null) return;
    e.preventDefault();
    items.current[to]?.focus();
  };
  return (
    <ul className="go-tree" role="tree" aria-label="Goals">
      {rows.map(({ node, depth }, i) => (
        <li key={node.id} ref={(el) => { items.current[i] = el; }} role="treeitem" aria-level={depth + 1} aria-selected={i === at}
          tabIndex={i === at ? 0 : -1} style={{ paddingLeft: indent(depth) }}
          className={`go-row ${i === at ? "on" : ""} ${depth === 0 ? "root" : ""} ${node.status === "retired" ? "retired" : ""} ${scope && !scope.has(node.id) ? "dim" : ""}`}
          onClick={() => pick(node.id)} onKeyDown={(e) => key(e, i)}>
          <span className="go-text">{node.text}</span>
          <span className="go-meta">{outlineMeta(node, proposals.get(node.id) ?? 0)}</span>
        </li>
      ))}
    </ul>
  );
}
