/**
 * The goal tree canvas's geometry (1:1 mt_cyd2t5ioob decision 4): a textbook tree, root box at the top centre, each
 * goal's children in a row beneath it joined by elbow lines. A simple recursive width-sum layout: a leaf is one box
 * wide, a parent is as wide as its children's row, centred over it, so no two subtrees overlap. Pure, so it is tested
 * without a DOM; GoalCanvas.tsx draws it and pans and zooms it.
 */
import type { GoalTreeNode } from "@muster-town/schema";

/** One box's size and the gaps between boxes, in canvas pixels (before zoom). */
export const BOX = { w: 210, h: 92, gapX: 26, gapY: 60, row: 21 };

/**
 * A box's height: three lines of words and one row of tags, a second tag row when it has more than three tags (desks,
 * captain, key results, due), and a row for each attached building (each shows its own desks).
 */
function boxHeight(n: Pick<GoalTreeNode, "buildings" | "ownerId" | "keyResults">): number {
  const open = n.keyResults.filter((k) => !k.archivedAt && k.status !== "met" && k.status !== "missed");
  const tags = 1 + (n.ownerId ? 1 : 0) + (open.length ? 1 : 0) + (open.some((k) => k.due) ? 1 : 0);
  return BOX.h + BOX.row * ((tags > 3 ? 1 : 0) + n.buildings.length);
}

export type Placed = {
  node: GoalTreeNode;
  /** top-left corner on the canvas */
  x: number; y: number; h: number; depth: number;
  parentId: string | null;
  /** goals hidden below it while it is collapsed (0 when open) */
  hidden: number;
  /** it has goals below it that the current retired toggle shows */
  kids: boolean;
};
type TreeLayout = { boxes: Placed[]; edges: { from: string; to: string; d: string }[]; width: number; height: number };

const shown = (n: GoalTreeNode, retired: boolean) => retired || n.status !== "retired";
const count = (n: GoalTreeNode, retired: boolean): number => n.children.filter((c) => shown(c, retired)).reduce((s, c) => s + 1 + count(c, retired), 0);

/** Lays the tree out top-down; collapsed goals keep their box and hide what is below it. */
export function layoutTree(root: GoalTreeNode, retired: boolean, collapsed: ReadonlySet<string>): TreeLayout {
  const kidsOf = (n: GoalTreeNode) => collapsed.has(n.id) ? [] : n.children.filter((c) => shown(c, retired));
  const widths = new Map<string, number>();
  const measure = (n: GoalTreeNode): number => {
    const kids = kidsOf(n);
    const row = kids.reduce((s, c) => s + measure(c), 0) + Math.max(0, kids.length - 1) * BOX.gapX;
    const w = Math.max(BOX.w, row);
    widths.set(n.id, w);
    return w;
  };
  // every row is as tall as its tallest box, so a row of boxes lines up
  const rowH: number[] = [];
  const rows = (n: GoalTreeNode, d: number) => { rowH[d] = Math.max(rowH[d] ?? 0, boxHeight(n)); for (const c of kidsOf(n)) rows(c, d + 1); };
  const rowY = (d: number) => rowH.slice(0, d).reduce((s, h) => s + h + BOX.gapY, 0);
  const boxes: Placed[] = [], edges: TreeLayout["edges"] = [];
  const place = (n: GoalTreeNode, left: number, depth: number, parentId: string | null): Placed => {
    const kids = kidsOf(n), w = widths.get(n.id)!;
    const row = kids.reduce((s, c) => s + widths.get(c.id)!, 0) + Math.max(0, kids.length - 1) * BOX.gapX;
    let at = left + (w - row) / 2;
    const y = rowY(depth), h = boxHeight(n);
    const me: Placed = { node: n, x: left + (w - BOX.w) / 2, y, h, depth, parentId, hidden: collapsed.has(n.id) ? count(n, retired) : 0, kids: n.children.some((c) => shown(c, retired)) };
    boxes.push(me);
    for (const c of kids) {
      const child = place(c, at, depth + 1, n.id);
      at += widths.get(c.id)! + BOX.gapX;
      const px = me.x + BOX.w / 2, cx = child.x + BOX.w / 2, mid = child.y - BOX.gapY / 2;
      edges.push({ from: n.id, to: c.id, d: `M${px} ${y + h}V${mid}H${cx}V${child.y}` });
    }
    return me;
  };
  if (!shown(root, retired)) return { boxes: [], edges: [], width: 0, height: 0 };
  const width = measure(root);
  rows(root, 0);
  place(root, 0, 0, null);
  return { boxes, edges, width, height: rowY(rowH.length) - BOX.gapY };
}

/**
 * Arrow keys on the canvas: up goes to the parent, down to the first child shown, left and right to the next box in
 * the same row (its sibling, or a cousin at a subtree's edge). Stays put at an edge.
 */
export function stepTree(layout: TreeLayout, id: string, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): string {
  const me = layout.boxes.find((b) => b.node.id === id);
  if (!me) return layout.boxes[0]?.node.id ?? id;
  if (key === "ArrowUp") return me.parentId ?? id;
  if (key === "ArrowDown") return layout.boxes.find((b) => b.parentId === id)?.node.id ?? id;
  const row = layout.boxes.filter((b) => b.depth === me.depth).sort((a, b) => a.x - b.x);
  const i = row.indexOf(me) + (key === "ArrowLeft" ? -1 : 1);
  return row[i]?.node.id ?? id;
}

export type View = { x: number; y: number; k: number };
const ZOOM = { min: 0.25, max: 2 };

/** The view that frames the whole tree in a viewport (never zoomed past 1:1), with a margin. Fit is not floored by
 * the minimum zoom: a wide tree in a narrow pane gets whatever scale shows every box. */
export function fitView(layout: Pick<TreeLayout, "width" | "height">, vw: number, vh: number, pad = 28): View {
  if (!layout.width || vw <= 0 || vh <= 0) return { x: pad, y: pad, k: 1 };
  const m = Math.min(pad, vw / 8, vh / 8);
  const k = Math.min(1, (vw - 2 * m) / layout.width, (vh - 2 * m) / layout.height);
  return { x: (vw - layout.width * k) / 2, y: Math.max(m, (vh - layout.height * k) / 2), k };
}

/** Zooms by `factor` keeping the canvas point under (px, py) in the viewport where it is. Below the minimum zoom
 * (only Fit gets there) zooming out stays put rather than jumping back up to the minimum. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = Math.min(ZOOM.max, Math.max(Math.min(ZOOM.min, v.k), v.k * factor));
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

/** The view that centres a box (keeping the zoom); null when it is already wholly in view. */
export function revealBox(v: View, b: Pick<Placed, "x" | "y" | "h">, vw: number, vh: number, force = false): View | null {
  const left = v.x + b.x * v.k, top = v.y + b.y * v.k, right = left + BOX.w * v.k, bottom = top + b.h * v.k;
  if (!force && left >= 0 && top >= 0 && right <= vw && bottom <= vh) return null;
  return { k: v.k, x: vw / 2 - (b.x + BOX.w / 2) * v.k, y: vh / 2 - (b.y + b.h / 2) * v.k };
}

/** A subtree's desks with headcounts changed in place on the canvas (`over`: building id → headcount) applied. */
export function deskTotal(node: Pick<GoalTreeNode, "buildings" | "children">, over: ReadonlyMap<string, number>): number {
  return node.buildings.reduce((n, b) => n + (over.get(b.id) ?? b.headcount), 0) + node.children.reduce((n, c) => n + deskTotal(c, over), 0);
}
