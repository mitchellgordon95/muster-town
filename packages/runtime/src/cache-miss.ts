/**
 * The cache-miss check's runtime half (gr_lwgus14rd2 step 2; core `cache-miss.ts` is the check): after any session of
 * the UTC day ends, the next tick re-checks the day and raises `alert: cache-miss` at most once per purpose per day.
 * A session's first-turn usage is read from its stored transcript once and memoized for the day.
 */
import { checkCacheMiss, storedFirstTurn, utcDay, type FirstTurn, type World } from "@muster-town/core";

let checkedThrough = "";
let memoDay = "";
const memo = new Map<string, FirstTurn | null>();

/** Run the check when a session ended since the last run (the runtime calls this every tick). → how many alerts fired. */
export function cacheMissDue(world: World, now: Date): number {
  const day = utcDay(now);
  const since = checkedThrough > `${day}T00:00:00.000Z` ? checkedThrough : `${day}T00:00:00.000Z`;
  if (!world.sessions.exists("status != 'running' AND endedAt >= ?", [since])) return 0;
  checkedThrough = now.toISOString();
  if (memoDay !== day) { memo.clear(); memoDay = day; }
  return checkCacheMiss(world, now, (id) => {
    if (!memo.has(id)) memo.set(id, storedFirstTurn(world, id));
    return memo.get(id);
  }).length;
}
