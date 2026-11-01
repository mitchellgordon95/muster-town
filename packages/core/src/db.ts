import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPlaintextTokens } from "./store.ts";

export type DB = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));
/** core/migrations, from core/src (the sources) or from packages/server/dist (the prebuilt server, server/build.mjs) */
const MIGRATIONS_DIR = [join(HERE, "..", "migrations"), join(HERE, "..", "..", "core", "migrations")].find((d) => existsSync(d)) ?? join(HERE, "..", "migrations");

/** Open (creating if needed) the SQLite file, enable WAL, apply pending migrations. */
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  // login tokens are stored hashed (docs/secrets.md "Login tokens"): hash any plaintext row left by an older server
  const hashed = hashPlaintextTokens(db);
  if (hashed) console.log(`[secrets] hashed ${hashed} plaintext login token${hashed === 1 ? "" : "s"} in place`);
  return db;
}

export function migrate(db: DB, dir = MIGRATIONS_DIR): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  // apply every file whose number isn't recorded yet (not just those above the max), so migrations
  // from branches merged out of order still run
  const applied = new Set((db.prepare("SELECT version FROM schema_version").all() as { version: number }[]).map((r) => r.version));
  const files = readdirSync(dir)
    .map((f) => ({ f, n: Number(/^(\d+)/.exec(f)?.[1] ?? NaN) }))
    .filter((x) => x.f.endsWith(".sql") && Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);
  // two files with one number: the second would be skipped silently once the first is recorded
  const dup = files.find((x, i) => i > 0 && files[i - 1].n === x.n);
  if (dup) throw new Error(`[core] two migrations numbered ${dup.n}: renumber ${dup.f}`);
  for (const { f, n } of files) {
    if (applied.has(n)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(n);
    })();
    applied.add(n);
  }
  return Math.max(0, ...applied);
}

/**
 * Seal a backup copy into one self-contained file: `db.backup()` of a WAL database leaves the copy in WAL mode (the mode is
 * in the file header) with `-wal`/`-shm` beside it; switching it to `journal_mode = DELETE` checkpoints and removes them,
 * so the copy restores as a single `town.db`. Then `PRAGMA integrity_check`: "ok" or the first problems.
 */
export function sealCopy(path: string): string {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join("; ") || "no result";
  } finally { db.close(); }
}

/** `PRAGMA integrity_check` on a database file opened read-only (a backup copy): "ok" or the first problems. */
export function integrityCheck(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join("; ") || "no result";
  } finally { db.close(); }
}
