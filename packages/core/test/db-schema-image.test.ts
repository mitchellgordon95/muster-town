import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db.ts";

const schema = (db: Database.Database) =>
  db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
const versions = (db: Database.Database) =>
  db.prepare("SELECT version FROM schema_version ORDER BY version").all();

describe("openDb starts a new database from the migrated schema image", () => {
  const migrated = new Database(":memory:");
  migrate(migrated);

  it("an in-memory database has exactly the schema and versions of running every migration", () => {
    const db = openDb(":memory:");
    expect(schema(db)).toEqual(schema(migrated));
    expect(versions(db)).toEqual(versions(migrated));
  });

  it("a new file has the same schema, is in WAL mode and reopens without changes; copies don't share rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "db-image-")), "town.db");
    const db = openDb(path);
    expect(schema(db)).toEqual(schema(migrated));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(999999);
    db.close();
    const again = openDb(path);
    expect(versions(again)).toContainEqual({ version: 999999 });
    expect(versions(openDb(":memory:"))).not.toContainEqual({ version: 999999 });
  });
});
