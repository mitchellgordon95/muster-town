/**
 * One backup run, off the server's event loop (docs/postmortem-2026-10-31-cpu-throttle-503.md suggestion 2). BackupJob
 * (index.ts) starts this file as a `worker_threads` worker per run, and the worker does every heavy step on its own thread:
 * it opens town.db again with its own connection, copies it with SQLite's online backup API (WAL-safe), seals and checks the
 * copy, gzips it as a stream, encrypts, uploads, downloads it back and checks it, then prunes. It posts one WorkerMessage;
 * the main thread only records the outcome in backup_state, so health and the monitor's `backup` rule read what they did before.
 *
 * Node loads this file directly (its own type stripping, or tsx's loader inherited through execArgv), so it imports no
 * workspace package and uses erasable TypeScript only, like scripts/backup/restore-helper.mjs's imports of crypto.ts and s3.ts.
 */
import Database from "better-sqlite3";
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";
import { decryptBackup, encryptBackup } from "./crypto.ts";
import { keysToDelete, OBJECT_PREFIX, parseTranscriptKey, transcriptKey } from "./retention.ts";
import { S3, type S3Target } from "./s3.ts";

export interface WorkerInput {
  /** the live database file (the main thread's `db.name`) */
  dbPath: string;
  /** where the local copies go */
  dir: string;
  /** this run's object key, `town/<date>T<HH>.db.gz.enc` */
  key: string;
  /** `<date>T<HH>`: the local copy is `town-<stamp>.db` */
  stamp: string;
  /** the 32-byte MUSTER_TOWN_BACKUP_KEY */
  cipherKey: Uint8Array;
  s3: S3Target;
  /** also integrity_check the downloaded copy (the nightly run); the sha256 match against the checked copy runs every hour */
  deepCheck: boolean;
  /** the other databases copied the same way after town.db, each under its own prefix (`hosted/hub/`, `hosted/<slug>/`) */
  dbs?: { prefix: string; path: string }[];
  /** transcript dirs (`<data>/transcripts`), each uploaded incrementally under its prefix (`transcripts/<town>/`) */
  transcripts?: { prefix: string; dir: string }[];
  /** transcript objects whose date is older than this many days (+1) are deleted */
  transcriptDays?: number;
}

/** One database copied this run (town.db or another one of `dbs`). */
export interface CopyResult { prefix: string; key: string; bytes: number; rawBytes: number; deleted: string[] }
/** The transcripts part of a run: files on disk, newly uploaded, deleted past retention. */
export interface TranscriptsResult { files: number; uploaded: number; uploadedBytes: number; deleted: number }

export interface WorkerResult {
  key: string; bytes: number; rawBytes: number; deleted: string[]; localCopy: string;
  /** the other databases' copies (town.db's is the fields above) */
  copies?: CopyResult[];
  transcripts?: TranscriptsResult;
  /** what failed among the other databases and the transcripts (town.db's copy itself throws): health backup.error */
  problems?: string[];
}

export type WorkerMessage = { ok: true; result: WorkerResult } | { ok: false; error: string };

/** A pass-through that hashes and counts the bytes flowing through it. */
function tap(hash: Hash, count: { n: number }): Transform {
  return new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); count.n += chunk.byteLength; done(null, chunk); } });
}

/** A sink that keeps the chunks (or drops them when `into` is null). */
function sink(into: Buffer[] | null): Writable {
  return new Writable({ write(chunk: Buffer, _enc, done) { into?.push(chunk); done(); } });
}

/** `PRAGMA integrity_check`: "ok" or the problems. `seal` first switches the copy to a rollback journal so it is one self-contained file. */
function integrity(path: string, seal: boolean): string {
  const db = new Database(path, seal ? {} : { readonly: true });
  try {
    if (seal) db.pragma("journal_mode = DELETE");
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join("; ") || "no result";
  } finally { db.close(); }
}

/**
 * Copy one live database to `localCopy` (online backup, sealed, integrity_checked), gzip + encrypt + PUT it as `key`, and
 * verify-by-download. Throws on any failure; the read-back as `verify <key> failed: ...`.
 */
async function copyOne(s3: S3, cipherKey: Buffer, dbPath: string, localCopy: string, key: string, deepCheck: boolean): Promise<{ bytes: number }> {
  const tmp = `${localCopy}.tmp`;
  rmSync(tmp, { force: true });
  // the online backup API copies committed pages only and restarts on a concurrent write: safe with WAL and writers
  const live = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { await live.backup(tmp); } finally { live.close(); }
  const check = integrity(tmp, true);
  for (const side of ["-wal", "-shm"]) rmSync(tmp + side, { force: true });
  if (check !== "ok") { rmSync(tmp, { force: true }); throw new Error(`integrity_check on the copy failed: ${check}`); }
  renameSync(tmp, localCopy);

  // gzip as a stream, hashing the raw bytes on the way
  const rawHash = createHash("sha256");
  const raw = { n: 0 };
  const gz: Buffer[] = [];
  await pipeline(createReadStream(localCopy), tap(rawHash, raw), createGzip({ level: 6 }), sink(gz));
  const rawSha = rawHash.digest("hex");
  const blob = encryptBackup(cipherKey, Buffer.concat(gz));
  gz.length = 0;
  await s3.put(key, blob);

  // verify-by-download: the object must decrypt and gunzip to the very bytes that passed integrity_check above (every hour);
  // the nightly run also writes the download out and checks it as a database
  const file = `${localCopy}.verify`;
  try {
    const plainGz = decryptBackup(cipherKey, new Uint8Array(await (await s3.get(key)).arrayBuffer()));
    const hash = createHash("sha256");
    const n = { n: 0 };
    await pipeline(Readable.from([plainGz]), createGunzip(), tap(hash, n), deepCheck ? createWriteStream(file) : sink(null));
    if (n.n !== raw.n || hash.digest("hex") !== rawSha) throw new Error(`the download is not the uploaded copy (${n.n} vs ${raw.n} bytes)`);
    if (deepCheck) {
      const c = integrity(file, false);
      if (c !== "ok") throw new Error(`integrity_check: ${c}`);
    }
  } catch (e) {
    throw new Error(`verify ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(file, { force: true });
  }
  return { bytes: blob.byteLength };
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** The whole run. town.db's copy throws on any failure (then nothing is pruned); the other databases and the transcripts
 * come after it, each on its own, and what fails among them is returned as `problems`. */
export async function runBackup(input: WorkerInput): Promise<WorkerResult> {
  const { dir, key, stamp } = input;
  const cipherKey = Buffer.from(input.cipherKey);
  const s3 = new S3(input.s3);
  mkdirSync(dir, { recursive: true });
  const localCopy = join(dir, `town-${stamp}.db`);
  const { bytes } = await copyOne(s3, cipherKey, input.dbPath, localCopy, key, input.deepCheck);

  // retention: 48 hourly + the newest of each of 30 days (retention.ts); only after this run's object is verified
  const deleted: string[] = [];
  for (const old of keysToDelete(await s3.list(OBJECT_PREFIX))) { await s3.delete(old); deleted.push(old); }
  // the last local copy stays; older ones go
  for (const f of readdirSync(dir)) {
    if (/^town-\d{4}-\d{2}-\d{2}(T\d{2})?\.db(\.tmp(-wal|-shm)?|\.verify)?$/.test(f) && f !== `town-${stamp}.db`) rmSync(join(dir, f), { force: true });
  }

  const problems: string[] = [];
  const copies: CopyResult[] = [];
  for (const other of input.dbs ?? []) {
    try { copies.push(await copyOther(s3, cipherKey, input, other)); } catch (e) { problems.push(`${other.prefix}: ${message(e)}`); }
  }
  const transcripts: TranscriptsResult = { files: 0, uploaded: 0, uploadedBytes: 0, deleted: 0 };
  for (const t of input.transcripts ?? []) {
    try { await uploadTranscripts(s3, cipherKey, t, input.transcriptDays ?? 90, new Date(`${stamp}:00:00Z`), transcripts, problems); } catch (e) { problems.push(`${t.prefix}: ${message(e)}`); }
  }
  return { key, bytes, rawBytes: statSync(localCopy).size, deleted, localCopy, copies, transcripts, problems };
}

/** Another database (a hosted collective's town.db, hub.db): the same copy under its prefix, the same never-replace guard and
 * per-prefix retention; no local copy is kept (the volume holds the live file; the Workshop's last copy is the local one). */
async function copyOther(s3: S3, cipherKey: Buffer, input: WorkerInput, other: { prefix: string; path: string }): Promise<CopyResult> {
  const key = `${other.prefix}${input.stamp}.db.gz.enc`;
  if ((await s3.list(other.prefix)).includes(key)) throw new Error(`${key} is already in the bucket; a run never replaces an object`);
  const local = join(input.dir, `other-${other.prefix.replace(/[^A-Za-z0-9]+/g, "-")}${input.stamp}.db`);
  try {
    const { bytes } = await copyOne(s3, cipherKey, other.path, local, key, input.deepCheck);
    const rawBytes = statSync(local).size;
    const deleted: string[] = [];
    for (const old of keysToDelete(await s3.list(other.prefix), undefined, undefined, other.prefix)) { await s3.delete(old); deleted.push(old); }
    return { prefix: other.prefix, key, bytes, rawBytes, deleted };
  } finally {
    for (const side of ["", ".tmp", ".tmp-wal", ".tmp-shm", ".verify"]) rmSync(local + side, { force: true });
  }
}

/**
 * The incremental transcript upload for one town: every `<sessionId>.jsonl.br` in `dir` whose session has no object under
 * `prefix` yet is encrypted (already brotli: no gzip), PUT as `<prefix><file's UTC date>/<sessionId>.jsonl.br.enc` and
 * verified by download (sha256 of the decrypted bytes); an object is never re-uploaded. Objects dated more than
 * `days` + 1 days ago are deleted (the town deletes the files after `days`). A file that fails is a problem; the rest go on.
 */
async function uploadTranscripts(s3: S3, cipherKey: Buffer, t: { prefix: string; dir: string }, days: number, now: Date, out: TranscriptsResult, problems: string[]): Promise<void> {
  const existing = new Map<string, string>();
  const keys = await s3.list(t.prefix);
  for (const k of keys) { const p = parseTranscriptKey(k, t.prefix); if (p) existing.set(p.sessionId, k); }
  const files = existsSync(t.dir) ? readdirSync(t.dir).filter((f) => /^[a-z]{2}_[A-Za-z0-9]+\.jsonl\.br$/.test(f)) : [];
  out.files += files.length;
  const todo = files.filter((f) => !existing.has(f.slice(0, -".jsonl.br".length)));
  let failed = 0;
  let firstError = "";
  const one = async (f: string) => {
    const sessionId = f.slice(0, -".jsonl.br".length);
    try {
      const path = join(t.dir, f);
      const date = statSync(path).mtime.toISOString().slice(0, 10);
      const plain = readFileSync(path);
      const k = transcriptKey(t.prefix, date, sessionId);
      await s3.put(k, encryptBackup(cipherKey, plain));
      const back = decryptBackup(cipherKey, new Uint8Array(await (await s3.get(k)).arrayBuffer()));
      if (!createHash("sha256").update(back).digest().equals(createHash("sha256").update(plain).digest())) throw new Error(`verify ${k} failed: the download is not the file`);
      out.uploaded++;
      out.uploadedBytes += plain.byteLength;
    } catch (e) { failed++; firstError ||= message(e); }
  };
  // a few at a time: the first run uploads every file on the volume
  for (let i = 0; i < todo.length; i += TRANSCRIPT_PARALLEL) await Promise.all(todo.slice(i, i + TRANSCRIPT_PARALLEL).map(one));
  if (failed) problems.push(`${t.prefix}: ${failed} of ${todo.length} transcript upload(s) failed (first: ${firstError})`);
  const cutoff = new Date(now.getTime() - (days + 1) * 86_400_000).toISOString().slice(0, 10);
  for (const k of keys) {
    const p = parseTranscriptKey(k, t.prefix);
    if (p && p.date < cutoff) { await s3.delete(k); out.deleted++; }
  }
}

/** transcript uploads in flight at once */
const TRANSCRIPT_PARALLEL = 4;

// the worker entry (index.ts starts one worker per run with workerData { backupRun })
const run = !isMainThread ? (workerData as { backupRun?: WorkerInput } | null)?.backupRun : undefined;
if (run && parentPort) {
  const port = parentPort;
  runBackup(run).then(
    (result) => port.postMessage({ ok: true, result } satisfies WorkerMessage),
    (e: unknown) => port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies WorkerMessage),
  );
}
