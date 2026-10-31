/**
 * The funder filter (docs/goals.md "Funder attribution: one deck, two filters", goal tree build step 8): a signed-in
 * human who has put a Bank input in sees the Town Hall in-tray, the review deck, the goal tree and the Bank's Spend by goal
 * narrowed to what their own money reached (GET /api/funders/me/week). Pure helpers; guests never load it.
 */
import type { FunderWeek, GoalTreeNode, IntrayRoute, ReviewSlide } from "@muster-town/schema";
import type { FunderWeekView } from "../api";

export type IntrayView = "mine" | "all" | "funded";

/** A funder: someone with at least one Bank input (live, or one that still paid or credited in the window). */
export const isFunder = (w: FunderWeek | null | undefined): w is FunderWeek => !!w && w.streams.length > 0;

/** The goals the funder's money reached; null = every goal (a pro rata share reaches the whole pooled week). */
export function fundedGoals(w: FunderWeek): Set<string> | null {
  return w.everything ? null : new Set(w.goalIds);
}

const routed = (routes: Record<string, IntrayRoute>, id: string, goals: Set<string> | null) => !goals || (!!routes[id] && goals.has(routes[id]!.goalId));

/** The in-tray list under "Funded by me": items routed to a goal the funder's money reached. */
export function fundedOnly<T extends { id: string }>(items: T[], routes: Record<string, IntrayRoute>, w: FunderWeek): T[] {
  const goals = fundedGoals(w);
  return items.filter((x) => routed(routes, x.id, goals));
}

/** The deck under "Funded by me": the funder's slide in place of the state of the town, then the decisions under their goals. */
export function fundedSlides(slides: ReviewSlide[], routes: Record<string, IntrayRoute>, w: FunderWeekView): ReviewSlide[] {
  const goals = fundedGoals(w);
  const rest = slides.filter((s) => s.kind !== "town" && (s.kind === "record" ? !goals : !!s.itemId && routed(routes, s.grantId ?? s.docIds?.[0] ?? s.itemId, goals)));
  return [w.slide, ...rest];
}

/** The goal tree's filter value for "Funded by me". */
export const FUNDED = "funded:me";

/**
 * The goal tree under "Funded by me": the goals the money reached and their ancestors (so the path to each stays lit);
 * null = nothing dimmed (a pro rata share, or no week loaded).
 */
export function treeScope(root: GoalTreeNode, w: FunderWeek | null | undefined): Set<string> | null {
  const goals = w ? fundedGoals(w) : null;
  if (!goals) return null;
  const lit = new Set<string>();
  const walk = (n: GoalTreeNode, path: string[]): void => {
    if (goals.has(n.id)) for (const id of [...path, n.id]) lit.add(id);
    for (const c of n.children) walk(c, [...path, n.id]);
  };
  walk(root, []);
  return lit;
}
