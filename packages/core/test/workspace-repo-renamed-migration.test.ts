/**
 * The repo rename agent-town → muster-town (dc_1lsk4v7psx): the stored `Town.workspace.repoUrl` still named the old repo
 * while the runtime reads `host.repoUrl` from the checkout's origin, so repoMode was "own" and nobody held town.redeploy.
 * Migration 118 rewrites the old name; after it the same repo is "muster" again. Another collective's repo is untouched.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/db.ts";
import { repoKey } from "../src/index.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const RENAME = "118_workspace_repo_renamed.sql";

function renamed(repoUrl: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "mig-repo-"));
  for (const f of readdirSync(MIGRATIONS)) if (f.endsWith(".sql") && f < RENAME) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const db = new Database(":memory:");
  migrate(db, dir);
  const ws = repoUrl === undefined ? { path: "." } : { path: "/Users/m/agent-town", base: "main", repoUrl };
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('town', ?)").run(JSON.stringify({ name: "Muster Town", workspace: ws }));
  copyFileSync(join(MIGRATIONS, RENAME), join(dir, RENAME));
  migrate(db, dir);
  return JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'town'").get() as { value: string }).value);
}

const HOST = "https://github.com/mitchellgordon95/muster-town";

describe("118_workspace_repo_renamed migration", () => {
  it("rewrites the old repo name in either URL form, so the renamed repo matches the host's origin", () => {
    const scp = renamed("git@github.com:mitchellgordon95/agent-town.git");
    expect(scp.workspace).toEqual({ path: "/Users/m/agent-town", base: "main", repoUrl: "git@github.com:mitchellgordon95/muster-town.git" });
    expect(scp.name).toBe("Muster Town");
    expect(repoKey(scp.workspace.repoUrl)).toBe(repoKey(HOST));
    expect(renamed("https://github.com/mitchellgordon95/agent-town").workspace.repoUrl).toBe(HOST);
  });

  it("leaves another collective's repo, and a workspace with no repoUrl, alone", () => {
    expect(renamed("https://github.com/someone/agent-town.git").workspace.repoUrl).toBe("https://github.com/someone/agent-town.git");
    expect(renamed(undefined).workspace).toEqual({ path: "." });
  });
});
