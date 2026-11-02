/**
 * Backup object naming and tiered retention, shared by the job (index.ts) and its worker (worker.ts). Plain erasable
 * TypeScript with no imports, so the worker can load it with node's type stripping.
 */

/** object keys: `town/<date>T<HH>.db.gz.enc` (hourly); `town/<date>.db.gz.enc` are the nightly objects from before 2026-11-01 */
export const OBJECT_PREFIX = "town/";
/** retention: the newest this many hourly objects... */
const KEEP_HOURLY = 48;
/** ...plus the newest object of each of the newest this many days */
const KEEP_DAILY = 30;

/** The key for an hour (UTC): `town/2026-10-27T04.db.gz.enc`. Keys sort by time, a nightly `town/<date>.db.gz.enc` before that date's hours. */
export const objectKey = (d: Date) => `${OBJECT_PREFIX}${d.toISOString().slice(0, 13)}.db.gz.enc`;

/** A backup object key (hourly or the older nightly form): its date and hour (null for a nightly one); null for any other key. */
export function parseObjectKey(key: string): { date: string; hour: string | null } | null {
  const m = /^town\/(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?\.db\.gz\.enc$/.exec(key);
  return m ? { date: m[1]!, hour: m[2] ?? null } : null;
}

/**
 * Tiered retention over the bucket's keys: keep the newest KEEP_HOURLY hourly objects and the newest object (of either form)
 * of each of the newest KEEP_DAILY dates; everything else under the backup naming goes. A nightly object stays until a
 * newer object of its date exists or its date falls out of the daily window. Returns the keys to delete, oldest first.
 */
export function keysToDelete(keys: string[], keepHourly = KEEP_HOURLY, keepDaily = KEEP_DAILY): string[] {
  const ours = keys.filter((k) => parseObjectKey(k)).sort();
  const keep = new Set(ours.filter((k) => parseObjectKey(k)!.hour != null).slice(-keepHourly));
  const newestOfDay = new Map<string, string>();
  for (const k of ours) newestOfDay.set(parseObjectKey(k)!.date, k); // ascending, so the last one wins
  for (const date of [...newestOfDay.keys()].sort().slice(-keepDaily)) keep.add(newestOfDay.get(date)!);
  return ours.filter((k) => !keep.has(k));
}
