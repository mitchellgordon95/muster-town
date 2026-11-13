/**
 * The chain of command, as a pure transform of the goal tree (1:1 mt_msnjkpgwdb decisions 13 and 15; docs/goals.md
 * "Chain of command"). No World, DB or clock inside: plain data in, a plain map out. `Goals.ownerOf` and `Goals.route`
 * read through `answererOf`, so the live town and this transform are one rule.
 *
 * The rule, in Mitchell's words: "UI / UX has a direct connection to the root that bypasses Workshop ... a very clear
 * rule of how to transform the goal hierarchy to get a chain of command hierarchy". Each building answers to the
 * nearest captained goal at or above the goal it is attached to: the goal itself when it has a captain, else the
 * closest ancestor that has one, else the root. Buildings never answer to buildings: a building attached under another
 * building's goal (UI / UX under the Workshop's Steer) skips past it to whoever captains a goal above, and with no
 * captain in between, to the root.
 *
 * Invariants (packages/core/test/chain-of-command.test.ts, property-based):
 * - total: every building gets exactly one answerer;
 * - the answerer is the building's goal or an ancestor of it (a building on an unknown goal sits at the root);
 * - the answerer is captained, unless it is the root;
 * - no captained goal lies strictly between the building's goal and its answerer (it is the nearest);
 * - adding a captain to a goal never moves any answerer upward (it stays or moves down to the new captain).
 */

/** A goal as the transform needs it: its parent (null at the root) and its captain (a user id, or null). */
export interface ChainGoal { id: string; parentId: string | null; ownerId: string | null }
/** A building as the transform needs it: the goal it is attached to (null or unknown = the root). */
export interface ChainBuilding { id: string; goalId: string | null }
/** Who a building (or goal) answers to: the goal whose captain decides, and that captain (null only for an uncaptained root). */
interface Answerer { answererGoalId: string; userId: string | null }

/**
 * The answerer for one goal: the goal itself if captained, else its nearest captained ancestor, else the root (with the
 * root's captain, or null when the root has none: the shell fills in its fallback). `goal(id)` looks a goal up; a goal
 * it doesn't know, a broken parent link or a cycle ends the walk at the root.
 */
export function answererOf(goalId: string, goal: (id: string) => ChainGoal | undefined, rootId: string): Answerer {
  const seen = new Set<string>();
  for (let g = goal(goalId); g && !seen.has(g.id); g = g.parentId ? goal(g.parentId) : undefined) {
    if (g.ownerId) return { answererGoalId: g.id, userId: g.ownerId };
    seen.add(g.id);
  }
  return { answererGoalId: rootId, userId: goal(rootId)?.ownerId ?? null };
}

/** The whole chain of command: every building id → its answerer (`answererOf` its attached goal; no goal = the root). */
export function chainOfCommand(input: { goals: readonly ChainGoal[]; buildings: readonly ChainBuilding[]; rootId: string }): Map<string, Answerer> {
  const byId = new Map(input.goals.map((g) => [g.id, g]));
  const lookup = (id: string) => byId.get(id);
  return new Map(input.buildings.map((b) => [b.id, answererOf(b.goalId && byId.has(b.goalId) ? b.goalId : input.rootId, lookup, input.rootId)]));
}
