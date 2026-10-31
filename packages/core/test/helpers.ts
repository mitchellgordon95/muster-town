import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { World } from "../src/index.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CARBON_DIR = join(REPO_ROOT, "buildings/carbon-cycle");
export const TOWN_JSON = join(REPO_ROOT, "town.json");

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-town-core-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Fresh world on a temp DB file (closed after the test). */
export function freshWorld(): { world: World; dir: string; dbPath: string } {
  const dir = tempDir();
  const dbPath = join(dir, "town.db");
  const world = World.open(dbPath);
  cleanups.unshift(() => { try { world.close(); } catch { /* already closed */ } });
  return { world, dir, dbPath };
}

/** Seeded world with the Carbon Cycle Lab imported. */
/** The subscription token the test Bank holds (the Bank is the only place a credential lives; nothing comes from the env). */
export const TEST_TOKEN = "sk-ant-oat01-test-subscription-token";
/** Give the seeded world's Bank its subscription credential without crediting it (first renewal far off), so the money model is untouched. */
export function seedCredential(world: World, adminId: string): void {
  world.bank.addInput(adminId, { label: "Test subscription", source: "subscription", model: "claude-sonnet-5-5", tokens: 1, recurrence: "daily", weeklyCapTokens: 1, nextCreditAt: "2099-01-01T00:00:00.000Z", token: TEST_TOKEN });
}

export function seededWorld() {
  const f = freshWorld();
  const seed = f.world.seedDefaults({ importDir: CARBON_DIR, townJsonPath: TOWN_JSON, dataDir: f.dir });
  seedCredential(f.world, seed.admin.id);
  const by = (name: string) => f.world.agents.first("name = ?", [name])!;
  return { ...f, seed, by, admin: f.world.ops.ensureAvatar(seed.admin.id) };
}

/** Tick until the promise settles (bounded). */
export async function tickUntil<T>(world: World, p: Promise<T>, maxTicks = 2000): Promise<T> {
  let done = false;
  const wrapped = p.finally(() => { done = true; });
  for (let i = 0; i < maxTicks && !done; i++) {
    world.tick(100);
    await Promise.resolve();
  }
  return wrapped;
}

/**
 * Put a database back into its pre-034 shape (Bank grant step 1): drop the five token counters and turn the generated
 * raw totals back into plain columns holding the same numbers. `usage` (024) may already be gone.
 */
export function undoTokenCounters(db: import("better-sqlite3").Database): void {
  undoAdjustedTokens(db);
  const kinds = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const undo = (table: string, total: string, cols: string[]) => {
    if (!has(table)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${total}_old INTEGER NOT NULL DEFAULT 0; UPDATE ${table} SET ${total}_old = ${total}`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${total}`);
    for (const c of cols) db.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${total}_old TO ${total}`);
  };
  for (const t of ["sessions", "usage", "bank_debits", "bank_credits"]) undo(t, "tokens", kinds);
  undo("allocations", "spentTokens", kinds.map((k) => `spent${k[0].toUpperCase()}${k.slice(1)}`));
  db.prepare("DELETE FROM schema_version WHERE version = 34").run();
}

/**
 * Undo migration 037's columns (the raw totals it made generated; the stored adjusted `tokens` / `spentTokens` stay as
 * plain columns) so 037 runs again on next open. Its one-time size conversion runs again too.
 */
export function undoAdjustedTokens(db: import("better-sqlite3").Database): void {
  const cols = (t: string) => (db.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ["usage", "bank_debits", "bank_credits"]) if (cols(t).includes("rawTokens")) db.exec(`ALTER TABLE ${t} DROP COLUMN rawTokens`);
  if (cols("allocations").includes("spentRawTokens")) db.exec("ALTER TABLE allocations DROP COLUMN spentRawTokens");
  db.prepare("DELETE FROM schema_version WHERE version = 37").run();
}

/**
 * Set a building's pool / exploration budget, which live on goals (core goals.ts `fundingOf`): the building gets a goal of
 * its own under the root (the seed attaches every building to the root) and the fields go on it, as the system.
 */
export function fundBuilding(world: World, buildingId: string, funding: { poolId?: string | null; explorationTokensPerDay?: number | null }): string {
  const b = world.buildings.require(buildingId, "building");
  let goalId = b.goalId ?? "gl_town";
  if (world.buildings.all().some((x) => x.id !== b.id && x.goalId === goalId) || goalId === "gl_town") {
    goalId = world.goalTree.create(null, { parentId: "gl_town", text: `${b.name}'s own goal` }).id;
    world.goalTree.attach(null, b.id, goalId);
  }
  if (Object.keys(funding).length) world.goalTree.update(null, goalId, funding);
  return goalId;
}

/** Set the exploration budget / pool on the goal the building is attached to now (shared with any building attached there too). */
export function fundGoalOf(world: World, buildingId: string, funding: { poolId?: string | null; explorationTokensPerDay?: number | null }): string {
  const goalId = world.goalTree.attachmentOf(buildingId);
  world.goalTree.update(null, goalId, funding);
  return goalId;
}
