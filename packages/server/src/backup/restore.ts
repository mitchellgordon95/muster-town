/**
 * First-boot restore (grant gr_z2v838adk9; deploy/README.md "Recover"): a server that starts with no town.db but with the
 * five backup env vars is a town on a new volume, not a new town. Before the world is opened (and seeded), it lists the
 * bucket, and takes the newest copy that downloads, decrypts, gunzips and passes integrity_check; a bad one is logged and
 * the next older one is tried. The copy carries the dead town's backup_state, so the hourly copies continue from it.
 * No env, an empty bucket, an unreachable one or no good copy: the server seeds as before, and an empty town never
 * uploads over the copies (index.ts FRESH_TOWN guard).
 */
import { integrityCheck } from "@muster-town/core";
import Database from "better-sqlite3";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { decryptBackup } from "./crypto.ts";
import { backupTargetFromEnv, FRESH_TOWN, OBJECT_PREFIX, parseObjectKey } from "./index.ts";

interface RestoreOptions {
  /** the town.db the world will open */
  dbPath: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  log?: Pick<Console, "log" | "warn">;
  /** pause between list attempts (tests: 0) */
  retryMs?: number;
}

/** Restores town.db from the newest good copy when it is missing; returns the copy's key and agent count, or null (seed as before). Never throws. */
export async function restoreOnFirstBoot(opts: RestoreOptions): Promise<{ key: string; agents: number } | null> {
  const log = opts.log ?? console;
  if (existsSync(opts.dbPath)) return null;
  const { s3, key, missing } = backupTargetFromEnv(opts.env ?? process.env, opts.fetchFn);
  if (!s3 || !key) {
    log.log(`[restore] no ${opts.dbPath} and no backup env (${missing.join(", ")}): seeding a new town`);
    return null;
  }
  let keys: string[] | null = null;
  for (let attempt = 1; attempt <= 3 && !keys; attempt++) {
    try { keys = await s3.list(OBJECT_PREFIX); } catch (e) {
      log.warn(`[restore] listing ${s3.dest}${OBJECT_PREFIX} failed (attempt ${attempt} of 3): ${e instanceof Error ? e.message : String(e)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, opts.retryMs ?? 5000));
    }
  }
  if (!keys) {
    log.warn(`[restore] the bucket could not be listed: seeding a new town; it will not upload over the copies ("${FRESH_TOWN}" on health)`);
    return null;
  }
  const copies = keys.filter((k) => parseObjectKey(k)).sort().reverse();
  if (!copies.length) {
    log.log(`[restore] no ${opts.dbPath} and no copies in ${s3.dest}${OBJECT_PREFIX}: seeding a new town`);
    return null;
  }
  log.log(`[restore] no ${opts.dbPath}: restoring from the newest good one of ${copies.length} copies in ${s3.dest}${OBJECT_PREFIX}`);
  const tmp = `${opts.dbPath}.restore`;
  for (const k of copies) {
    rmSync(tmp, { force: true });
    try {
      const blob = new Uint8Array(await (await s3.get(k)).arrayBuffer());
      writeFileSync(tmp, gunzipSync(decryptBackup(key, blob)));
      const check = integrityCheck(tmp);
      if (check !== "ok") throw new Error(`integrity_check: ${check}`);
      const db = new Database(tmp, { readonly: true });
      let agents: number;
      try { agents = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n; } finally { db.close(); }
      for (const side of ["-wal", "-shm"]) rmSync(opts.dbPath + side, { force: true });
      renameSync(tmp, opts.dbPath);
      log.log(`[restore] ${k}: ok, ${agents} agents; the town starts from it`);
      return { key: k, agents };
    } catch (e) {
      log.warn(`[restore] ${k}: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  rmSync(tmp, { force: true });
  log.warn(`[restore] none of the ${copies.length} copies is good: seeding a new town; it will not upload over them`);
  return null;
}
