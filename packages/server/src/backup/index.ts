/**
 * Off-site backup of town.db (grants gr_jkorz4f49a, gr_ba0juhlm7n; deploy/README.md "Backups"): every hour on the hour,
 * plus once at boot when the last copy is older than 1 h, the server copies the live database with SQLite's online backup
 * API (WAL-safe), checks the copy, gzips and encrypts it (crypto.ts), PUTs it to the S3 bucket `fly storage create`
 * configured as `town/<YYYY-MM-DD>T<HH>.db.gz.enc`, then downloads it back and checks that it decrypts to the same,
 * intact database. Retention: the newest 48 hourly objects plus the newest object of each of the last 30 days, and the
 * last local copy. Its state is one row (migrations 039, 069) that `GET /api/health` shows read-only. Without the five env
 * vars it is inert: `backup: null`.
 */
import { integrityCheck, sealCopy, type DB } from "@muster-town/core";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { backupKeyFrom, decryptBackup, encryptBackup } from "./crypto.ts";
import { S3 } from "./s3.ts";

export { backupKeyFrom, decryptBackup, encryptBackup } from "./crypto.ts";
export { S3 } from "./s3.ts";
export { signV4 } from "./sigv4.ts";

/** What `GET /api/health` shows: never the key or the bucket credentials. */
export interface BackupView { lastAt: string | null; verifiedAt: string | null; bytes: number | null; dest: string; error: string | null }

export const BACKUP_ENV = ["BUCKET_NAME", "AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MUSTER_TOWN_BACKUP_KEY"] as const;
/** object keys: `town/<date>T<HH>.db.gz.enc` (hourly); `town/<date>.db.gz.enc` are the nightly objects from before 2026-11-01 */
export const OBJECT_PREFIX = "town/";
/** retention: the newest this many hourly objects... */
export const KEEP_HOURLY = 48;
/** ...plus the newest object of each of the newest this many days */
export const KEEP_DAILY = 30;
/** the boot catch-up runs when the last copy is older than this (or there is none) */
export const STALE_MS = 60 * 60 * 1000;
/** the boot catch-up waits this long so startup (seed, runtime) is done first */
const BOOT_DELAY_MS = 30_000;

export interface BackupJobOptions {
  db: DB;
  /** where the local copies go (e.g. /data/workshop/backups) */
  dir: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn">;
}

interface StateRow { lastAt: string | null; verifiedAt: string | null; bytes: number | null; key: string | null; error: string | null; errorAt: string | null }

export interface BackupRunResult { key: string; bytes: number; rawBytes: number; deleted: string[]; localCopy: string }

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

/** ms until the next top of the hour (UTC) after `from` */
export function msUntilNextRun(from: Date): number {
  const next = new Date(from.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - from.getTime();
}

export class BackupJob {
  private readonly s3: S3 | null;
  private readonly key: Buffer | null;
  /** the env var names that are missing (or malformed): the job is inert while any is */
  readonly missing: string[];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupRunResult | null> | null = null;
  private readonly now: () => Date;
  private readonly log: Pick<Console, "log" | "warn">;

  constructor(private opts: BackupJobOptions) {
    const env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? console;
    this.missing = BACKUP_ENV.filter((k) => !env[k]?.trim());
    let key: Buffer | null = null;
    try { key = backupKeyFrom(env.MUSTER_TOWN_BACKUP_KEY); } catch (e) { this.missing.push(`MUSTER_TOWN_BACKUP_KEY (${(e as Error).message})`); }
    this.key = key;
    this.s3 = this.missing.length ? null : new S3({
      endpoint: env.AWS_ENDPOINT_URL_S3!.trim(),
      bucket: env.BUCKET_NAME!.trim(),
      creds: { accessKeyId: env.AWS_ACCESS_KEY_ID!.trim(), secretAccessKey: env.AWS_SECRET_ACCESS_KEY!.trim(), region: env.AWS_REGION?.trim() || "auto" },
    }, opts.fetchFn);
  }

  /** false without the five env vars: nothing runs and health shows `backup: null` */
  get configured(): boolean { return !!this.s3 && !!this.key; }

  private state(): StateRow {
    return this.opts.db.prepare("SELECT lastAt, verifiedAt, bytes, key, error, errorAt FROM backup_state WHERE id = 1").get() as StateRow;
  }

  /** `GET /api/health` `backup` (null when not configured) */
  snapshot(): BackupView | null {
    if (!this.s3) return null;
    const s = this.state();
    return { lastAt: s.lastAt, verifiedAt: s.verifiedAt, bytes: s.bytes, dest: this.s3.dest + OBJECT_PREFIX, error: s.error };
  }

  /**
   * Arm the timers: the hourly run, and one boot catch-up when the last copy is older than 1 h. One boot warning when
   * inert. The timers are unref'd so they never keep the process alive.
   */
  start(): void {
    if (!this.configured) {
      this.log.warn(`[backup] off: no off-site backup until ${this.missing.join(", ")} ${this.missing.length === 1 ? "is" : "are"} set in the server's env (deploy/README.md "Backups")`);
      return;
    }
    const s = this.state();
    const stale = this.stale();
    this.log.log(`[backup] on: hourly on the hour to ${this.s3!.dest}${OBJECT_PREFIX} (last copy ${s.lastAt ?? "never"}${stale ? "; catch-up run in 30 s" : ""})`);
    if (stale) { const t = setTimeout(() => void this.run(), BOOT_DELAY_MS); t.unref(); }
    this.scheduleHourly();
  }

  /** true when the boot catch-up would run now: no copy yet, or the last one is older than 1 h */
  stale(): boolean {
    const s = this.state();
    return !s.lastAt || this.now().getTime() - Date.parse(s.lastAt) > STALE_MS;
  }

  private scheduleHourly(): void {
    this.timer = setTimeout(() => { void this.run().finally(() => this.scheduleHourly()); }, msUntilNextRun(this.now()));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One run now (no-op when not configured; a run already in flight is returned instead of starting a second). Never throws. */
  run(): Promise<BackupRunResult | null> {
    if (!this.configured) return Promise.resolve(null);
    if (this.running) return this.running;
    this.running = this.runOnce().then((r) => {
      const at = this.now().toISOString();
      this.opts.db.prepare("UPDATE backup_state SET lastAt = ?, verifiedAt = ?, bytes = ?, key = ?, error = NULL, errorAt = NULL WHERE id = 1").run(at, at, r.bytes, r.key);
      this.log.log(`[backup] ${r.key}: ${r.bytes} bytes uploaded and verified (${r.rawBytes} raw)${r.deleted.length ? `, ${r.deleted.length} old object(s) deleted` : ""}`);
      return r;
    }, (e: unknown) => {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      this.opts.db.prepare("UPDATE backup_state SET error = ?, errorAt = ? WHERE id = 1").run(message, this.now().toISOString());
      this.log.warn(`[backup] failed: ${message}`);
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async runOnce(): Promise<BackupRunResult> {
    const at = this.now();
    const key = objectKey(at);
    const stamp = at.toISOString().slice(0, 13);
    mkdirSync(this.opts.dir, { recursive: true });
    const localCopy = join(this.opts.dir, `town-${stamp}.db`);
    const tmp = `${localCopy}.tmp`;
    rmSync(tmp, { force: true });
    // the online backup API copies committed pages only and restarts on a concurrent write: safe with WAL and writers
    await this.opts.db.backup(tmp);
    // one self-contained file (no -wal/-shm beside it), then integrity_check
    const check = sealCopy(tmp);
    for (const side of ["-wal", "-shm"]) rmSync(tmp + side, { force: true });
    if (check !== "ok") { rmSync(tmp, { force: true }); throw new Error(`integrity_check on the copy failed: ${check}`); }
    renameSync(tmp, localCopy);
    const raw = readFileSync(localCopy);
    const blob = encryptBackup(this.key!, gzipSync(raw, { level: 6 }));
    await this.s3!.put(key, blob);
    // a run that cannot read its own object back fails here: no lastAt, the error on health, and nothing is pruned
    await this.verify(key, raw);
    // retention: 48 hourly + the newest of each of 30 days (keysToDelete); only after this run's object is verified
    const deleted: string[] = [];
    for (const old of keysToDelete(await this.s3!.list(OBJECT_PREFIX))) { await this.s3!.delete(old); deleted.push(old); }
    // the last local copy stays; older ones go
    for (const f of readdirSync(this.opts.dir)) {
      if (/^town-\d{4}-\d{2}-\d{2}(T\d{2})?\.db(\.tmp(-wal|-shm)?|\.verify)?$/.test(f) && f !== `town-${stamp}.db`) rmSync(join(this.opts.dir, f), { force: true });
    }
    return { key, bytes: blob.byteLength, rawBytes: statSync(localCopy).size, deleted, localCopy };
  }

  /**
   * Verify-by-download: GET the object back, decrypt and gunzip it (the restore path's crypto.ts / s3.ts), and check that it is
   * byte for byte the copy that was uploaded and passes integrity_check. Throws `verify <key> failed: ...` otherwise.
   */
  private async verify(key: string, raw: Buffer): Promise<void> {
    const file = join(this.opts.dir, `town-${key.slice(OBJECT_PREFIX.length).replace(/\.gz\.enc$/, "")}.verify`);
    try {
      const blob = new Uint8Array(await (await this.s3!.get(key)).arrayBuffer());
      const plain = gunzipSync(decryptBackup(this.key!, blob));
      const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
      if (plain.byteLength !== raw.byteLength || sha(plain) !== sha(raw)) throw new Error(`the download is not the uploaded copy (${plain.byteLength} vs ${raw.byteLength} bytes)`);
      writeFileSync(file, plain);
      const check = integrityCheck(file);
      if (check !== "ok") throw new Error(`integrity_check: ${check}`);
    } catch (e) {
      throw new Error(`verify ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      rmSync(file, { force: true });
    }
  }
}
