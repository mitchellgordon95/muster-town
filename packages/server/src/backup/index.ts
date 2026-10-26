/**
 * Off-site backup of town.db (grant gr_jkorz4f49a; deploy/README.md "Backups"): every night at 04:17 UTC, plus once at
 * boot when the last copy is older than 24 h, the server copies the live database with SQLite's online backup API
 * (WAL-safe), checks the copy, gzips and encrypts it (crypto.ts) and PUTs it to the S3 bucket `fly storage create`
 * configured as `town/<YYYY-MM-DD>.db.gz.enc`, keeping the last 30 objects and the last local copy. Its state is one
 * row (migration 038) that `GET /api/health` shows read-only. Without the five env vars it is inert: `backup: null`.
 */
import { sealCopy, type DB } from "@muster-town/core";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { backupKeyFrom, encryptBackup } from "./crypto.ts";
import { S3 } from "./s3.ts";

export { backupKeyFrom, decryptBackup, encryptBackup } from "./crypto.ts";
export { S3 } from "./s3.ts";
export { signV4 } from "./sigv4.ts";

/** What `GET /api/health` shows: never the key or the bucket credentials. */
export interface BackupView { lastAt: string | null; bytes: number | null; dest: string; error: string | null }

export const BACKUP_ENV = ["BUCKET_NAME", "AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MUSTER_TOWN_BACKUP_KEY"] as const;
/** object keys: `town/<date>.db.gz.enc` */
export const OBJECT_PREFIX = "town/";
export const KEEP_OBJECTS = 30;
/** nightly at this UTC time */
export const RUN_AT_UTC = { hour: 4, minute: 17 };
/** the boot catch-up runs when the last copy is older than this (or there is none) */
const STALE_MS = 24 * 60 * 60 * 1000;
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

interface StateRow { lastAt: string | null; bytes: number | null; key: string | null; error: string | null; errorAt: string | null }

export interface BackupRunResult { key: string; bytes: number; rawBytes: number; deleted: string[]; localCopy: string }

/** The nightly key for a date: `town/2026-10-27.db.gz.enc`. */
export const objectKey = (d: Date) => `${OBJECT_PREFIX}${d.toISOString().slice(0, 10)}.db.gz.enc`;

/** ms until the next 04:17 UTC after `from` */
export function msUntilNextRun(from: Date, at = RUN_AT_UTC): number {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), at.hour, at.minute, 0, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
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
    return this.opts.db.prepare("SELECT lastAt, bytes, key, error, errorAt FROM backup_state WHERE id = 1").get() as StateRow;
  }

  /** `GET /api/health` `backup` (null when not configured) */
  snapshot(): BackupView | null {
    if (!this.s3) return null;
    const s = this.state();
    return { lastAt: s.lastAt, bytes: s.bytes, dest: this.s3.dest + OBJECT_PREFIX, error: s.error };
  }

  /**
   * Arm the timers: the nightly run, and one boot catch-up when the last copy is older than 24 h. One boot warning when
   * inert. The timers are unref'd so they never keep the process alive.
   */
  start(): void {
    if (!this.configured) {
      this.log.warn(`[backup] off: no off-site backup until ${this.missing.join(", ")} ${this.missing.length === 1 ? "is" : "are"} set in the server's env (deploy/README.md "Backups")`);
      return;
    }
    const s = this.state();
    const stale = !s.lastAt || this.now().getTime() - Date.parse(s.lastAt) > STALE_MS;
    this.log.log(`[backup] on: nightly at ${String(RUN_AT_UTC.hour).padStart(2, "0")}:${String(RUN_AT_UTC.minute).padStart(2, "0")} UTC to ${this.s3!.dest}${OBJECT_PREFIX} (last copy ${s.lastAt ?? "never"}${stale ? "; catch-up run in 30 s" : ""})`);
    if (stale) { const t = setTimeout(() => void this.run(), BOOT_DELAY_MS); t.unref(); }
    this.scheduleNightly();
  }

  private scheduleNightly(): void {
    this.timer = setTimeout(() => { void this.run().finally(() => this.scheduleNightly()); }, msUntilNextRun(this.now()));
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
      this.opts.db.prepare("UPDATE backup_state SET lastAt = ?, bytes = ?, key = ?, error = NULL, errorAt = NULL WHERE id = 1").run(this.now().toISOString(), r.bytes, r.key);
      this.log.log(`[backup] ${r.key}: ${r.bytes} bytes uploaded (${r.rawBytes} raw)${r.deleted.length ? `, ${r.deleted.length} old object(s) deleted` : ""}`);
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
    const stamp = at.toISOString().slice(0, 10);
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
    // retention: the newest KEEP_OBJECTS under the prefix stay; keys sort by date
    const keys = (await this.s3!.list(OBJECT_PREFIX)).filter((k) => /^town\/\d{4}-\d{2}-\d{2}\.db\.gz\.enc$/.test(k));
    const deleted: string[] = [];
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_OBJECTS))) { await this.s3!.delete(old); deleted.push(old); }
    // the last local copy stays; older ones go
    for (const f of readdirSync(this.opts.dir)) {
      if (/^town-\d{4}-\d{2}-\d{2}\.db(\.tmp(-wal|-shm)?)?$/.test(f) && f !== `town-${stamp}.db`) rmSync(join(this.opts.dir, f), { force: true });
    }
    return { key, bytes: blob.byteLength, rawBytes: statSync(localCopy).size, deleted, localCopy };
  }
}
