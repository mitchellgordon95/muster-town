import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { MapLayout } from "@muster-town/schema";
import { World, createSchedule } from "../src/index.ts";
import { createAsk, renderNeed, type NewAsk } from "../src/ask-verb.ts";
import { appendEntry } from "../src/jobs.ts";
import { unrenderedNeeds } from "../src/needs.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CARBON_DIR = join(REPO_ROOT, "buildings/carbon-cycle");
const TOWN_JSON = join(REPO_ROOT, "town.json");

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
const TEST_TOKEN = "sk-ant-oat01-test-subscription-token";
/** Give the seeded world's Bank its subscription credential without crediting it (first renewal far off), so the money model is untouched. */
function seedCredential(world: World, adminId: string): void {
  world.bank.addInput(adminId, { label: "Test subscription", source: "subscription", model: "claude-sonnet-5-5", tokens: 1, recurrence: "daily", weeklyCapTokens: 1, nextCreditAt: "2099-01-01T00:00:00.000Z", token: TEST_TOKEN });
}

/**
 * Free tokens for exploration (docs/how-work-gets-done.md §8: exploration is held only when no tokens are free): one
 * subscription credit of `tokens` on the test subscription input, expiring far off. Nothing else about the money moves.
 */
export function creditBank(world: World, tokens = 10_000_000): void {
  const inp = world.bank.subscriptionInput();
  if (!inp) throw new Error("creditBank: no test subscription input (seedCredential)");
  world.db.prepare("INSERT INTO bank_credits (id, inputId, output, tokens, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`bc_test_${Math.random().toString(36).slice(2)}`, inp.id, tokens, tokens, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
}

/**
 * A proposal pinned to ask exactly `askTokens`: the town prices an ask from its steps' sizes (docs/legible-delegation.md
 * §7.3), so a fixture about free tokens, the overdraft walk or a card's numbers sets the stored ask by hand.
 */
export function askAt<G extends { id: string }>(world: World, g: G, askTokens: number): G {
  world.grants.patch(g.id, { askTokens });
  return { ...g, askTokens };
}

/** `shape`: draw the map in that shape instead of a new town's ("fountain"), for tests about one shape's geometry. */
export function seededWorld(shape?: MapLayout) {
  const f = freshWorld();
  const seed = f.world.seedDefaults({ importDir: CARBON_DIR, townJsonPath: TOWN_JSON, dataDir: f.dir });
  if (shape) { f.world.town.set({ mapLayout: shape }); f.world.layout.rebuild(); }
  seedCredential(f.world, seed.admin.id);
  // test Banks hold thousands of tokens, not millions: no operating reserve unless a test sets one (free-tokens.test.ts)
  f.world.town.set({ operatingReserveTokens: 0 });
  const by = (name: string) => f.world.agents.first("name = ?", [name])!;
  return { ...f, seed, by, admin: f.world.ops.ensureAvatar(seed.admin.id) };
}

/**
 * A seeded world that works on this server's own repo (`repoMode` muster: a workspace, no host repo URL to tell it apart),
 * like muster.town's Workshop: deploy and PR waits, the Live line and managers' redeploy. A plain seeded world has no repo.
 */
export function musterWorld(shape?: MapLayout) {
  const s = seededWorld(shape);
  s.world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main" } });
  return s;
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
 * plain columns) so 037 runs again on next open. Its one-time size conversion runs again too. Migration 089 (an index
 * on bank_debits.tokens) is undone with it.
 */
export function undoAdjustedTokens(db: import("better-sqlite3").Database): void {
  // 037 drops bank_debits.tokens, which migration 089's index covers: drop the index and let 089 run again after 037
  db.exec("DROP INDEX IF EXISTS bank_debits_credit");
  db.prepare("DELETE FROM schema_version WHERE version = 89").run();
  const cols = (t: string) => (db.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ["usage", "bank_debits", "bank_credits"]) if (cols(t).includes("rawTokens")) db.exec(`ALTER TABLE ${t} DROP COLUMN rawTokens`);
  if (cols("allocations").includes("spentRawTokens")) db.exec("ALTER TABLE allocations DROP COLUMN spentRawTokens");
  db.prepare("DELETE FROM schema_version WHERE version = 37").run();
}

/**
 * Give a building a goal of its own under the root (the seed attaches every building to the root) and set its exploration
 * cap there (core free-tokens.ts `exploreCapAt`), as the system.
 */
export function fundBuilding(world: World, buildingId: string, funding: { exploreCapTokensPerDay?: number | null }): string {
  const b = world.buildings.require(buildingId, "building");
  let goalId = b.goalId ?? "gl_town";
  if (world.buildings.all().some((x) => x.id !== b.id && x.goalId === goalId) || goalId === "gl_town") {
    goalId = world.goalTree.create(null, { parentId: "gl_town", text: `${b.name}'s own goal` }).id;
    world.goalTree.attach(null, b.id, goalId);
  }
  if (Object.keys(funding).length) world.goalTree.update(null, goalId, funding);
  return goalId;
}

/** Set the exploration cap on the goal the building is attached to now (shared with any building attached there too). */
export function fundGoalOf(world: World, buildingId: string, funding: { exploreCapTokensPerDay?: number | null }): string {
  const goalId = world.goalTree.attachmentOf(buildingId);
  world.goalTree.update(null, goalId, funding);
  return goalId;
}

/**
 * Render every open need no card renders yet, as its manager would with `ask` (1:1 mt_t65exni4et decision 2): the
 * town writes needs, never cards, so a test that wants a proposal's, a gate's or a request's ask renders it here. Each
 * card meets its type's contract. Returns the asks made.
 */
export function renderNeeds(world: World, by = "ag_manager"): import("@muster-town/schema").Ask[] {
  return unrenderedNeeds(world).map((n) => {
    const g = n.targetKind === "grant" ? world.grants.get(n.targetId) : undefined;
    const d = n.targetKind === "request" ? world.docs.get(n.targetId) : undefined;
    const name = g ? `"${g.title || g.objective}"` : "";
    const card = n.need === "proposal"
      ? { title: `Fund ${name} at ${Math.round(g!.askTokens / 1000)}k`, body: `You have not decided on it before.\nIt asks for ${g!.askTokens} tokens. Nothing is spent yet.\nIt has ${g!.steps.length} steps, and none is done yet.`, recommendation: "Fund it." }
      : n.need === "gate"
        ? { title: g!.status === "checkpoint" ? `${name} is held at its ceiling: adjust or cut it` : `Adjust or cut ${name}`, body: `You funded this before.\nIt has spent ${world.grantDesk.spent(g!.id)} tokens.\nSome steps are done and some are left.`, recommendation: "Adjust it." }
        : n.need === "retainer"
          ? { title: `Approve the retainer ${n.targetId}`, body: `You have not decided on it before.\n${n.entry.body}\nNothing is spent yet.\nNo run has its steps done yet.`, recommendation: "Approve it." }
          : n.need === "goal"
            ? { title: `Accept the goal change ${n.targetId}`, body: `Change: ${n.entry.body}\nYou have not decided on it before.`, recommendation: "Accept it." }
          : n.need === "captain" || n.need === "access"
            ? { title: n.entry.note, body: `${n.entry.body}\nThey have waited since they asked.`, recommendation: "Accept it." }
            : { title: d?.title ?? n.entry.note, body: `${d?.body ?? ""}\nScope: what the request says.\nIf you decline: it stays manual.\nWorth leaving the queue: only a human can do it.`, recommendation: "Press Done." };
    return renderNeed(world, n, card, by).ask;
  });
}

/**
 * Seed an ask in a test the way the ask verb files one: an entry at level human on its building's thread (the Town
 * Hall's when it has none), then the card on it. The one test seam onto `createAsk` (docs/invariants/asks.md 18).
 */
export function seedAsk(world: World, n: Omit<NewAsk, "sourceEntryId"> & { sourceEntryId?: string }): { ask: import("@muster-town/schema").Ask; folded: boolean } {
  const by = n.by ?? "system";
  // a seed on a target that already has a live ask is the same need again (its entry: the door refuses a second card)
  const live = n.targetId && n.targetKind ? world.asks.first("targetKind = ? AND targetId = ? AND status IN ('open', 'deferred')", [n.targetKind, n.targetId], "ORDER BY createdAt, rowid")?.sourceEntryId ?? null : null;
  const entryId = n.sourceEntryId ?? live ?? (appendEntry(world, {
    jobId: `jb_${n.buildingId ?? "town-hall"}`, authorKind: by === "system" ? "code" : "manager", authorId: by,
    level: "human", note: n.title, body: n.body ?? "", moved: { kind: "ask", type: n.type, ...(n.targetId ? { targetId: n.targetId } : {}) },
  })?.id);
  if (!entryId) throw new Error(`seedAsk: no thread jb_${n.buildingId ?? "town-hall"}`);
  return createAsk(world, { ...n, sourceEntryId: entryId ?? null });
}

/**
 * The old daily ranking schedule as prod had it before grant gr_mcuj10tupi (the town no longer makes one): a Town Hall
 * retainer schedule taken by the Secretary, then kept in step by `ensureRankSchedule`. For the tests of a live one.
 */
export function legacyRankSchedule(world: World, at: Date = new Date()): import("@muster-town/schema").Schedule {
  const sec = world.secretary.agent()!;
  createSchedule(world, "town-hall", { kind: "agent", id: sec.id }, {
    title: "Daily ask ranking", description: "old prompt", repeat: { dailyAt: ["07:00"] }, tokensPerRun: 40_000, takerId: sec.id,
    gap: "The humans' open asks need a daily order and a money slate",
  }, null, at);
  return world.secretary.ensureRankSchedule(at)!;
}
