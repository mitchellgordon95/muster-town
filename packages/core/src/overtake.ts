/**
 * Which open asks a human's decision may have made moot (1:1 mt_msnjkpgwdb decisions 10 and 20a): after every human
 * decision on a Town Hall ask, the Secretary settles the asks that decision overtook, re-ranks, and tells the buildings.
 *
 * This file is the pure core (decision 15): data in, data out. No World, no database, no clock. The shell is
 * `overtakeAsk` (asks.ts) and the Secretary's decision run (secretary.ts).
 *
 * What it holds (test/overtake.test.ts):
 * - the Secretary may settle only a live click or policy ask that is not a Do (a request a human must carry out): never
 *   a money, credential or meeting ask;
 * - a decision never overtakes its own ask;
 * - every candidate is one the Secretary may settle, and is tied to the decision: it is on the same target, or its
 *   words name the decided item by id.
 */

/** An ask, as far as this file reads it. */
export interface AskFacts {
  id: string; type: string; status: string; targetKind: string | null; targetId: string | null;
  title: string; body: string; deferredUntil?: string | null;
}

/** What a human decided: the ask they answered, and the item it was about (a grant, a retainer, a request…). */
export interface DecisionFacts { askId?: string | null; targetKind?: string | null; targetId?: string | null }

const SETTLEABLE = new Set(["click", "policy"]);
const LIVE = new Set(["open", "deferred"]);

/** May the Secretary close this ask as overtaken? A live click or policy ask that is not a Do. Money, credentials and meetings are the humans'. */
export function maySettle(a: AskFacts): boolean {
  return LIVE.has(a.status) && SETTLEABLE.has(a.type) && a.targetKind !== "request" && a.type !== "do";
}

const ID_CHAR = /[a-z0-9_]/i;
/** Whether `text` names `id` as a whole id, not inside a longer one. */
export function namesId(text: string, id: string): boolean {
  if (!id) return false;
  for (let i = text.indexOf(id); i >= 0; i = text.indexOf(id, i + 1)) {
    if (!ID_CHAR.test(text[i - 1] ?? "") && !ID_CHAR.test(text[i + id.length] ?? "")) return true;
  }
  return false;
}

/**
 * The open asks `d` may have overtaken, in the order given: candidates for the Secretary's judgment, never closed by
 * this function. An ask is one when the Secretary may settle it (`maySettle`), it is not the decided ask itself, and it
 * is about the same item or names the decided ask or item by id in its title, body or what it is deferred behind.
 */
export function overtakeCandidates(d: DecisionFacts, asks: AskFacts[]): AskFacts[] {
  const ids = [d.askId, d.targetId].filter((x): x is string => !!x);
  if (!ids.length) return [];
  return asks.filter((a) => {
    if (!maySettle(a) || a.id === d.askId) return false;
    const sameTarget = !!d.targetId && a.targetId === d.targetId && (!d.targetKind || a.targetKind === d.targetKind);
    const words = `${a.title}\n${a.body}\n${a.deferredUntil ?? ""}`;
    return sameTarget || ids.some((id) => namesId(words, id));
  });
}
