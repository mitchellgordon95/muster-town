import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Open (creating if needed) the SQLite file, enable WAL, apply pending migrations. */
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
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
