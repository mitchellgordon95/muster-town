import { ROOT_GOAL_ID, type Building, type Place } from "@muster-town/schema";

/**
 * A building's purpose: the text of the goal it is attached to (1:1 mt_n25udpflus decision 3; core `Goals.purposeOf`).
 * The map carries every active goal as its plaza (`plaza:<goalId>`, named by the goal's text), so this needs no fetch;
 * old rows and the mock without that plaza fall back to the stored text.
 */
export function purposeOf(b: Pick<Building, "goalId" | "goal">, places: readonly Place[]): string {
  return places.find((p) => p.id === `plaza:${b.goalId ?? ROOT_GOAL_ID}`)?.name ?? b.goal;
}

/**
 * A goal's short name for one-line places ("Exploration cap: 5k / day (from goal X)"): the text before its first colon when that is
 * short enough, else its first ~40 characters cut at a word with "…". Callers put the full text in a title tooltip.
 */
export function goalShortName(text: string, max = 40): string {
  const colon = text.indexOf(":");
  if (colon > 0 && colon <= max) return text.slice(0, colon).trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const space = slice.search(/\s\S*$/);
  return (space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,.;:]+$/, "") + "…";
}
