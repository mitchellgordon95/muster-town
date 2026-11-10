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

/** The key for an hour (UTC): `town/2026-10-27T04.db.gz.enc`. Keys sort by time, a nightly `town/<date>.db.gz.enc` before that date's hours.
 * Another database's copies use the same naming under their own prefix (`hosted/hub/`, `hosted/<slug>/`). */
export const objectKey = (d: Date, prefix = OBJECT_PREFIX) => `${prefix}${d.toISOString().slice(0, 13)}.db.gz.enc`;

/** A backup object key under `prefix` (hourly or the older nightly form): its date and hour (null for a nightly one); null for any other key. */
export function parseObjectKey(key: string, prefix = OBJECT_PREFIX): { date: string; hour: string | null } | null {
  if (!key.startsWith(prefix)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?\.db\.gz\.enc$/.exec(key.slice(prefix.length));
  return m ? { date: m[1]!, hour: m[2] ?? null } : null;
}

/**
 * Tiered retention over the bucket's keys: keep the newest KEEP_HOURLY hourly objects and the newest object (of either form)
 * of each of the newest KEEP_DAILY dates; everything else under the backup naming goes. A nightly object stays until a
 * newer object of its date exists or its date falls out of the daily window. Returns the keys to delete, oldest first.
 */
export function keysToDelete(keys: string[], keepHourly = KEEP_HOURLY, keepDaily = KEEP_DAILY, prefix = OBJECT_PREFIX): string[] {
  const ours = keys.filter((k) => parseObjectKey(k, prefix)).sort();
  const keep = new Set(ours.filter((k) => parseObjectKey(k, prefix)!.hour != null).slice(-keepHourly));
  const newestOfDay = new Map<string, string>();
  for (const k of ours) newestOfDay.set(parseObjectKey(k, prefix)!.date, k); // ascending, so the last one wins
  for (const date of [...newestOfDay.keys()].sort().slice(-keepDaily)) keep.add(newestOfDay.get(date)!);
  return ours.filter((k) => !keep.has(k));
}

/** Transcript objects: `transcripts/<town>/<YYYY-MM-DD>/<sessionId>.jsonl.br.enc`, the date being the file's (UTC). Already
 * brotli, so encrypted only. Uploaded once each; deleted once the date is older than the town's retention (+1 day). */
export const TRANSCRIPT_PREFIX = "transcripts/";
export const transcriptKey = (prefix: string, date: string, sessionId: string) => `${prefix}${date}/${sessionId}.jsonl.br.enc`;
export function parseTranscriptKey(key: string, prefix: string): { date: string; sessionId: string } | null {
  if (!key.startsWith(prefix)) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\/([a-z]{2}_[A-Za-z0-9]+)\.jsonl\.br\.enc$/.exec(key.slice(prefix.length));
  return m ? { date: m[1]!, sessionId: m[2]! } : null;
}
