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
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";
import { decryptBackup, encryptBackup } from "./crypto.ts";
import { keysToDelete, OBJECT_PREFIX } from "./retention.ts";
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
}

export interface WorkerResult { key: string; bytes: number; rawBytes: number; deleted: string[]; localCopy: string }

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

/** The whole run. Throws on any failure; the read-back as `verify <key> failed: ...`, and then nothing is pruned. */
export async function runBackup(input: WorkerInput): Promise<WorkerResult> {
  const { dir, key, stamp } = input;
  const cipherKey = Buffer.from(input.cipherKey);
  const s3 = new S3(input.s3);
  mkdirSync(dir, { recursive: true });
  const localCopy = join(dir, `town-${stamp}.db`);
  const tmp = `${localCopy}.tmp`;
  rmSync(tmp, { force: true });
  // the online backup API copies committed pages only and restarts on a concurrent write: safe with WAL and writers
  const live = new Database(input.dbPath, { readonly: true, fileMustExist: true });
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
  const file = join(dir, `town-${stamp}.db.verify`);
  try {
    const plainGz = decryptBackup(cipherKey, new Uint8Array(await (await s3.get(key)).arrayBuffer()));
    const hash = createHash("sha256");
    const n = { n: 0 };
    await pipeline(Readable.from([plainGz]), createGunzip(), tap(hash, n), input.deepCheck ? createWriteStream(file) : sink(null));
    if (n.n !== raw.n || hash.digest("hex") !== rawSha) throw new Error(`the download is not the uploaded copy (${n.n} vs ${raw.n} bytes)`);
    if (input.deepCheck) {
      const c = integrity(file, false);
      if (c !== "ok") throw new Error(`integrity_check: ${c}`);
    }
  } catch (e) {
    throw new Error(`verify ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(file, { force: true });
  }

  // retention: 48 hourly + the newest of each of 30 days (retention.ts); only after this run's object is verified
  const deleted: string[] = [];
  for (const old of keysToDelete(await s3.list(OBJECT_PREFIX))) { await s3.delete(old); deleted.push(old); }
  // the last local copy stays; older ones go
  for (const f of readdirSync(dir)) {
    if (/^town-\d{4}-\d{2}-\d{2}(T\d{2})?\.db(\.tmp(-wal|-shm)?|\.verify)?$/.test(f) && f !== `town-${stamp}.db`) rmSync(join(dir, f), { force: true });
  }
  return { key, bytes: blob.byteLength, rawBytes: statSync(localCopy).size, deleted, localCopy };
}

// the worker entry (index.ts starts one worker per run with workerData { backupRun })
const run = !isMainThread ? (workerData as { backupRun?: WorkerInput } | null)?.backupRun : undefined;
if (run && parentPort) {
  const port = parentPort;
  runBackup(run).then(
    (result) => port.postMessage({ ok: true, result } satisfies WorkerMessage),
    (e: unknown) => port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies WorkerMessage),
  );
}
