/** Bodies that share a tile (legacy desk data, meetings, walking through someone) fan out sideways and get a "×N" badge, so a stack is never hidden. */

/** world px between neighbours in a stack */
export const STACK_SPREAD = 4;

export interface Stacked { dx: number; k: number; n: number }

/**
 * Per body (by id): its sideways offset in world px, its index in its tile's stack and the stack's size. Bodies are
 * grouped by the tile their feet are on; order within a stack is by id, so it doesn't shuffle from frame to frame.
 */
export function stackBodies(bodies: { id: string; x: number; y: number }[], tile: number): Map<string, Stacked> {
  const groups = new Map<string, string[]>();
  for (const b of bodies) {
    const key = `${Math.floor(b.x / tile)},${Math.floor(b.y / tile)}`;
    const g = groups.get(key);
    if (g) g.push(b.id); else groups.set(key, [b.id]);
  }
  const out = new Map<string, Stacked>();
  for (const ids of groups.values()) {
    ids.sort();
    const n = ids.length;
    ids.forEach((id, k) => out.set(id, { dx: n > 1 ? Math.round((k - (n - 1) / 2) * STACK_SPREAD) : 0, k, n }));
  }
  return out;
}
