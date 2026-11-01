/**
 * Off-site backup of town.db (grants gr_jkorz4f49a, gr_ba0juhlm7n; deploy/README.md "Backups"): every hour on the hour,
 * plus once at boot when the last copy is older than 1 h, the server copies the live database with SQLite's online backup
 * API (WAL-safe), checks the copy, gzips and encrypts it (crypto.ts), PUTs it to the S3 bucket `fly storage create`
 * configured as `town/<YYYY-MM-DD>T<HH>.db.gz.enc`, then downloads it back and checks that it decrypts to the same,
 * intact database (the 04:00 UTC run also integrity_checks the download). The run itself is worker.ts in a worker thread,
 * so none of it blocks the event loop; this class only schedules it and records the outcome. Retention: the newest 48 hourly objects plus the newest object of each of the last 30 days, and the
 * last local copy. Its state is one row (migrations 039, 072) that `GET /api/health` shows read-only. Without the five env
 * vars it is inert: `backup: null`.
 */
import type { DB } from "@muster-town/core";
import { Worker } from "node:worker_threads";
import { backupKeyFrom } from "./crypto.ts";
import { OBJECT_PREFIX, objectKey } from "./retention.ts";
import { S3, type S3Target } from "./s3.ts";
import type { WorkerInput, WorkerMessage, WorkerResult } from "./worker.ts";

export { backupKeyFrom, decryptBackup, encryptBackup } from "./crypto.ts";
export { keysToDelete, objectKey, parseObjectKey } from "./retention.ts";
export { S3 } from "./s3.ts";
export { signV4 } from "./sigv4.ts";

/** What `GET /api/health` shows: never the key or the bucket credentials. */
export interface BackupView { lastAt: string | null; verifiedAt: string | null; bytes: number | null; dest: string; error: string | null }

const BACKUP_ENV = ["BUCKET_NAME", "AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MUSTER_TOWN_BACKUP_KEY"] as const;
/** the boot catch-up runs only when the last copy is older than this (or there is none): a copy under 1 h old is skipped */
const STALE_MS = 60 * 60 * 1000;
/** the boot catch-up waits this long so startup (seed, runtime) is done first */
const BOOT_DELAY_MS = 30_000;
/** the run at this UTC hour also integrity_checks the downloaded copy (the others match its sha256 against the checked copy) */
const DEEP_CHECK_HOUR = 4;

interface BackupJobOptions {
  db: DB;
  /** where the local copies go (e.g. /data/workshop/backups) */
  dir: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn">;
}

interface StateRow { lastAt: string | null; verifiedAt: string | null; bytes: number | null; key: string | null; error: string | null; errorAt: string | null }

type BackupRunResult = WorkerResult & { deepCheck: boolean };

/** ms until the next top of the hour (UTC) after `from` */
export function msUntilNextRun(from: Date): number {
  const next = new Date(from.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - from.getTime();
}

export class BackupJob {
  private readonly s3: S3 | null;
  private readonly target: S3Target | null;
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
    this.target = this.missing.length ? null : {
      endpoint: env.AWS_ENDPOINT_URL_S3!.trim(),
      bucket: env.BUCKET_NAME!.trim(),
      creds: { accessKeyId: env.AWS_ACCESS_KEY_ID!.trim(), secretAccessKey: env.AWS_SECRET_ACCESS_KEY!.trim(), region: env.AWS_REGION?.trim() || "auto" },
    };
    this.s3 = this.target ? new S3(this.target) : null;
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
      this.log.log(`[backup] ${r.key}: ${r.bytes} bytes uploaded and verified${r.deepCheck ? " (download integrity_checked)" : ""} (${r.rawBytes} raw)${r.deleted.length ? `, ${r.deleted.length} old object(s) deleted` : ""}`);
      return r;
    }, (e: unknown) => {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      this.opts.db.prepare("UPDATE backup_state SET error = ?, errorAt = ? WHERE id = 1").run(message, this.now().toISOString());
      this.log.warn(`[backup] failed: ${message}`);
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  /**
   * The run itself, in a worker thread (worker.ts): copy, checks, gzip, encrypt, upload, verify-by-download and prune never
   * block the event loop that serves HTTP. Resolves with its result, rejects with its error (or the worker's crash).
   */
  private runOnce(): Promise<BackupRunResult> {
    const at = this.now();
    const deepCheck = at.getUTCHours() === DEEP_CHECK_HOUR;
    const input: WorkerInput = {
      dbPath: this.opts.db.name, dir: this.opts.dir, key: objectKey(at), stamp: at.toISOString().slice(0, 13),
      cipherKey: new Uint8Array(this.key!), s3: this.target!, deepCheck,
    };
    return new Promise<BackupRunResult>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { backupRun: input } });
      worker.once("message", (m: WorkerMessage) => {
        settled = true;
        if (m.ok) resolve({ ...m.result, deepCheck }); else reject(new Error(m.error));
        void worker.terminate();
      });
      worker.once("error", (e) => { if (!settled) { settled = true; reject(e); } });
      worker.once("exit", (code) => { if (!settled) { settled = true; reject(new Error(`the backup worker exited with code ${code} before reporting`)); } });
    });
  }
}
