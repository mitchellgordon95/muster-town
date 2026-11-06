import type { DB } from "./db.ts";

/**
 * One scheduler pass asks the same whole-town questions once per building and per queued assignment: free tokens under
 * every goal (the lane gate, the explore tick) and the Bank's available balance (every `canStart`). At the live size each
 * answer costs a few ms, so a pass with a dozen queued items spent most of its 100-250 ms recomputing them (gr_db6ofyd0yf
 * step 3). Inside `withTickMemo` each is computed once and reused until any row changes (SQLite `total_changes()`), and
 * only for a `now` within MEMO_NOW_MS of the one it was computed for: the answer is what a fresh computation gives.
 * Outside a scope (API requests, tests) nothing is cached.
 */
const MEMO_NOW_MS = 1_000;

let scope: { db: DB; changes: number; vals: WeakMap<object, Map<string, { at: number; v: unknown }>> } | null = null;

const changesOf = (db: DB): number => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

/** Runs `fn` with the memo on (nested calls share the outer scope). */
export function withTickMemo<T>(db: DB, fn: () => T): T {
  if (scope) return fn();
  scope = { db, changes: changesOf(db), vals: new WeakMap() };
  try { return fn(); } finally { scope = null; }
}

/** `compute()`, or its value from earlier in this scope if nothing was written since and `now` is within MEMO_NOW_MS. */
export function tickMemo<T>(owner: object, key: string, now: Date, compute: () => T): T {
  const s = scope;
  if (!s) return compute();
  const n = changesOf(s.db);
  if (n !== s.changes) { s.changes = n; s.vals = new WeakMap(); }
  let m = s.vals.get(owner);
  if (!m) s.vals.set(owner, m = new Map());
  const t = now.getTime(), hit = m.get(key);
  if (hit && Math.abs(t - hit.at) <= MEMO_NOW_MS) return hit.v as T;
  const v = compute();
  // a compute that wrote leaves s.changes behind, so the next call starts over
  m.set(key, { at: t, v });
  return v;
}
