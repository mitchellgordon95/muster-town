/**
 * The CPU-heavy half of a backup run, in a worker thread (index.ts `inWorker`) so the server's event loop never stalls on
 * it: for a ~100 MB town.db the end of the online copy, integrity_check, gzip, AES-256-GCM and sha256 take seconds, all
 * synchronous (5.1 s of one stall per run on a performance-1x desk before this moved here; about 0.3 s after). A one-shot
 * worker: it reads `workerData` (a `Work`), posts one `WorkResult` and exits. It imports only node builtins, better-sqlite3 and
 * ./crypto.ts, so it loads as a worker entry with or without tsx.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import { decryptBackup, encryptBackup } from "./crypto.ts";

export type Work =
  /** copy the live database `src` to `file` with the online backup API (skipped when `src` is null: the caller made the
   * copy), seal it (journal_mode DELETE, integrity_check), then gzip and encrypt it */
  | { op: "pack"; src: string | null; file: string; key: Uint8Array }
  /** decrypt and gunzip the downloaded object, compare it to the uploaded copy, write it to `file` and integrity_check it */
  | { op: "verify"; file: string; key: Uint8Array; blob: Uint8Array; rawBytes: number; sha: string };

export type WorkResult =
  | { op: "pack"; check: string; blob?: Uint8Array; rawBytes?: number; sha?: string }
  | { op: "verify"; check: string };

/** the pragma half of core's sealCopy / integrityCheck (db.ts) */
function integrity(file: string, seal: boolean): string {
  const db = new Database(file, { readonly: !seal });
  try {
    if (seal) db.pragma("journal_mode = DELETE");
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join("; ") || "no result";
  } finally { db.close(); }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function doWork(w: Work): Promise<WorkResult> {
  const key = Buffer.from(w.key);
  if (w.op === "pack") {
    if (w.src) {
      // a second connection: WAL lets it read a consistent snapshot while the server keeps writing
      const live = new Database(w.src, { readonly: true });
      try { live.pragma("busy_timeout = 5000"); await live.backup(w.file); } finally { live.close(); }
    }
    const check = integrity(w.file, true);
    if (check !== "ok") return { op: "pack", check };
    const raw = readFileSync(w.file);
    return { op: "pack", check, blob: encryptBackup(key, gzipSync(raw, { level: 6 })), rawBytes: raw.byteLength, sha: sha256(raw) };
  }
  const plain = gunzipSync(decryptBackup(key, w.blob));
  if (plain.byteLength !== w.rawBytes || sha256(plain) !== w.sha) return { op: "verify", check: `the download is not the uploaded copy (${plain.byteLength} vs ${w.rawBytes} bytes)` };
  writeFileSync(w.file, plain);
  return { op: "verify", check: `integrity_check: ${integrity(w.file, false)}`.replace(/^integrity_check: ok$/, "ok") };
}

if (parentPort && workerData) parentPort.postMessage(await doWork(workerData as Work));
