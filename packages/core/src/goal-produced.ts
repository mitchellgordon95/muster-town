import { grantName, type GoalProduced } from "@muster-town/schema";
import { worldGoalSpend } from "./goal-spend.ts";
import { goalNoticeWhere } from "./notices.ts";
import type { World } from "./world.ts";

const DAY = 86_400_000;

/**
 * GET /api/goals/:id/produced (grant gr_6kangldj4t step 1): what the goal and every goal under it produced in the last
 * `days` days. Shipped notices match the feed's goal filter (`goalNoticeWhere`); a grant belongs by its goal (or, on old
 * grants with none, its building's attachment); tokens come from `worldGoalSpend`, so
 * they agree with Spend by goal; key results count met, met unverified and missed by when they were judged. `limit` caps the shipped list, never the counts. Read-only.
 */
export function goalProduced(world: World, goalId: string, days = 30, now = new Date(), limit = 10): GoalProduced {
  const spend = worldGoalSpend(world, goalId, days, now);
  const subtree = world.goalTree.subtreeIds(goalId);
  const from = new Date(now.getTime() - days * DAY).toISOString(), to = now.toISOString();
  const g = goalNoticeWhere(world, goalId);
  const window = "createdAt > ? AND createdAt <= ?";
  const shipped = world.notices.where(`kind = 'shipped' AND ${window} AND ${g.sql}`, [from, to, ...g.args], "ORDER BY createdAt DESC, rowid DESC");
  const grants = world.grants.where("status = 'closed' AND closedAt > ? AND closedAt <= ?", [from, to], "ORDER BY closedAt DESC, rowid DESC")
    .filter((x) => subtree.has(x.goalId ?? world.goalTree.attachmentOf(x.buildingId)))
    .map((x) => ({ id: x.id, title: grantName(x), goalId: x.goalId, buildingId: x.buildingId, outcome: x.outcome, closedAt: x.closedAt!, spentTokens: world.grantDesk.spent(x.id), grantTokens: x.grantTokens }));
  // judged key results in the window: met, met on code and tests ("met, unverified", how close_grant marks them) and missed
  const keyResults = world.keyResults.where("status IN ('met', 'met-unverified', 'missed') AND updatedAt > ? AND updatedAt <= ?", [from, to], "ORDER BY updatedAt, rowid")
    .filter((k) => k.goalId && subtree.has(k.goalId))
    .map((k) => ({ id: k.id, text: k.text, status: k.status as GoalProduced["keyResults"][number]["status"], at: k.updatedAt }));
  return {
    goalId, days, from, to,
    counts: {
      shipped: shipped.length, grantsClosed: grants.length,
      keyResultsMet: keyResults.filter((k) => k.status !== "missed").length,
      keyResultsUnverified: keyResults.filter((k) => k.status === "met-unverified").length,
      keyResultsMissed: keyResults.filter((k) => k.status === "missed").length,
      tokens: spend.total,
    },
    shipped: shipped.slice(0, Math.max(0, limit)).map((n) => ({ id: n.id, title: n.title, body: n.body, picture: n.picture, buildingId: n.buildingId, goalId: n.goalId, refs: n.refs, createdAt: n.createdAt })),
    grants,
    keyResults,
  };
}
