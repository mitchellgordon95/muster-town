import { ROOT_GOAL_ID, type Building, type Place } from "@muster-town/schema";

/**
 * A building's purpose: the text of the goal it is attached to (1:1 mt_n25udpflus decision 3; core `Goals.purposeOf`).
 * The map carries every active goal as its plaza (`plaza:<goalId>`, named by the goal's text), so this needs no fetch;
 * old rows and the mock without that plaza fall back to the stored text.
 */
export function purposeOf(b: Pick<Building, "goalId" | "goal">, places: readonly Place[]): string {
  return places.find((p) => p.id === `plaza:${b.goalId ?? ROOT_GOAL_ID}`)?.name ?? b.goal;
}
