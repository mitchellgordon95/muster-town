/**
 * The hourly export's worker_threads entry (exportInWorker in export.ts starts one per run with workerData { exportRun }):
 * opens town.db read-only on its own connection and runs writeExport (reads, ~1,600 file writes, git) on this thread, then
 * posts one ExportWorkerMessage. The main thread appends `export.done` from the result. Bundled as dist/export-worker.js.
 */
import Database from "better-sqlite3";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { dbSource, writeExport, type ExportWorkerMessage } from "./export.ts";

const run = !isMainThread ? (workerData as { exportRun?: { dbPath: string; dir: string } } | null)?.exportRun : undefined;
if (run && parentPort) {
  let msg: ExportWorkerMessage;
  try {
    const db = new Database(run.dbPath, { readonly: true, fileMustExist: true });
    try { msg = { ok: true, result: writeExport(dbSource(db), run.dir) }; } finally { db.close(); }
  } catch (e) {
    msg = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort.postMessage(msg);
}
