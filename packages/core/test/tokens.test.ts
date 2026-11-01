import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { World, hashToken } from "../src/index.ts";
import { freshWorld, seededWorld } from "./helpers.ts";

// gr_6qlj35wnh3 step 3 (docs/secrets.md "Login tokens"): tokens are stored as sha256, nobody is logged out
const raw = (world: World) => world.db.prepare("SELECT token, kind, id, sessionId FROM tokens").all() as { token: string; kind: string; id: string; sessionId: string | null }[];

describe("login tokens at rest", () => {
  it("the table holds the hash, never the token; the token resolves", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const t = world.tokens.create("agent", mei.id);
    const rows = raw(world);
    expect(rows.some((r) => r.token === t)).toBe(false);
    expect(rows.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.token))).toBe(true);
    expect(rows.find((r) => r.token === hashToken(t))).toMatchObject({ kind: "agent", id: mei.id });
    expect(world.tokens.resolve(t)).toMatchObject({ kind: "agent", id: mei.id });
    // a stored hash shown as a token is not a login (a copy of town.db gives nothing usable)
    expect(world.tokens.resolve(hashToken(t))).toBeUndefined();
    world.tokens.revoke(hashToken(t));
    expect(world.tokens.resolve(t)).toBeDefined();
    world.tokens.revoke(t);
    expect(world.tokens.resolve(t)).toBeUndefined();
  });

  it("an old plaintext token still resolves: hashed when shown, and by the back-fill when the db is opened", () => {
    const { world, dbPath } = freshWorld();
    const seed = world.seedDefaults({ adminName: "Ada" });
    const ins = world.db.prepare("INSERT INTO tokens (token, kind, id, createdAt) VALUES (?, 'user', ?, '2026-10-01T00:00:00.000Z')");
    ins.run("at_old_browser_cookie", seed.admin.id);
    ins.run("at_old_desk", seed.admin.id);
    // an older server's row, before any back-fill: resolves, and is hashed in place
    expect(world.tokens.resolve("at_old_browser_cookie")).toMatchObject({ kind: "user", id: seed.admin.id });
    expect(raw(world).map((r) => r.token)).not.toContain("at_old_browser_cookie");
    expect(raw(world).map((r) => r.token)).toContain("at_old_desk");
    world.close();
    const again = World.open(dbPath); // openDb runs the back-fill
    try {
      expect(raw(again).every((r) => r.token.startsWith("sha256:"))).toBe(true);
      expect(again.tokens.resolve("at_old_desk")).toMatchObject({ kind: "user", id: seed.admin.id });
      expect(again.tokens.resolve("at_old_browser_cookie")).toMatchObject({ kind: "user", id: seed.admin.id });
    } finally { again.close(); }
  });

  it("a session's own token is revoked when the session ends; the agent's other tokens are not", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const old = world.tokens.getOrCreate("agent", mei.id);
    const s = world.ops.startSession(mei.id, { purpose: "work", model: "claude-opus-5-5" });
    const mine = world.tokens.createForSession(mei.id, s.id);
    expect(world.tokens.resolve(mine)).toMatchObject({ kind: "agent", id: mei.id, sessionId: s.id });
    world.ops.endSession(s.id, { status: "done" });
    expect(world.tokens.resolve(mine)).toBeUndefined();
    expect(world.tokens.resolve(old)).toMatchObject({ kind: "agent", id: mei.id });
  });

  it("the admin token file round-trips across restarts and is written when missing", () => {
    const { world, dir, dbPath } = freshWorld();
    const first = world.seedDefaults({ adminName: "Ada", dataDir: dir });
    const file = join(dir, "admin-token");
    expect(readFileSync(file, "utf8").trim()).toBe(first.adminToken);
    world.close();
    let w = World.open(dbPath);
    const second = w.seedDefaults({ adminName: "Ada", dataDir: dir });
    expect(second.adminToken).toBe(first.adminToken);
    expect(w.tokens.resolve(first.adminToken)).toMatchObject({ kind: "user", id: first.admin.id });
    w.close();
    // a restored copy: the file is the live one but its row is gone (or the file is gone): it still works / a new one is written
    w = World.open(dbPath);
    w.tokens.revokeAll("user", first.admin.id);
    expect(w.seedDefaults({ adminName: "Ada", dataDir: dir }).adminToken).toBe(first.adminToken);
    expect(w.tokens.resolve(first.adminToken)).toMatchObject({ id: first.admin.id });
    writeFileSync(file, "");
    const fresh = w.seedDefaults({ adminName: "Ada", dataDir: dir }).adminToken;
    expect(fresh).not.toBe(first.adminToken);
    expect(existsSync(file) && readFileSync(file, "utf8").trim()).toBe(fresh);
    expect(w.tokens.resolve(fresh)).toMatchObject({ id: first.admin.id });
    w.close();
  });
});
