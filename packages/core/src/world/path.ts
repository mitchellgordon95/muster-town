import { WALKABLE, type Tile } from "@muster-town/schema";
import { type Grid, tileAt } from "./layout.ts";

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  return WALKABLE.has(tileAt(grid, x, y));
}

/**
 * 4-neighbour BFS over walkable tiles (bodies don't block). Returns the steps after `from`,
 * ending at `to`, or (if `to` isn't walkable) at the nearest walkable tile adjacent to it.
 * Empty array = already there. Null = unreachable.
 */
export function findPath(grid: Grid, from: Tile, to: Tile): Tile[] | null {
  const goalWalkable = isWalkable(grid, to.x, to.y);
  const isGoal = (x: number, y: number) =>
    goalWalkable ? x === to.x && y === to.y : Math.max(Math.abs(x - to.x), Math.abs(y - to.y)) === 1;
  if (isGoal(from.x, from.y)) return [];
  const W = grid.w;
  const prev = new Int32Array(grid.w * grid.h).fill(-1);
  const start = from.y * W + from.x;
  if (from.x < 0 || from.y < 0 || from.x >= grid.w || from.y >= grid.h) return null;
  prev[start] = start;
  const queue = [start];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cx = cur % W, cy = (cur - cx) / W;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const ni = ny * W + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      if (isGoal(nx, ny)) {
        const path: Tile[] = [];
        for (let i = ni; i !== start; i = prev[i]) path.push({ x: i % W, y: Math.floor(i / W) });
        return path.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

/** Nearest walkable tile to `from` (BFS over any tile), `from` itself if walkable. */
export function nearestWalkable(grid: Grid, from: Tile): Tile {
  if (isWalkable(grid, from.x, from.y)) return from;
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  for (let i = 0; i < q.length && i < grid.w * grid.h; i++) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = { x: q[i].x + dx, y: q[i].y + dy };
      if (t.x < 0 || t.y < 0 || t.x >= grid.w || t.y >= grid.h || seen.has(`${t.x},${t.y}`)) continue;
      if (isWalkable(grid, t.x, t.y)) return t;
      seen.add(`${t.x},${t.y}`); q.push(t);
    }
  }
  return from;
}
