import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { countFunnel, decideAccess, joinFunnel, requestAccess, sumFunnels, townRoleId, upsertGithubUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

// The join funnel (grant gr_fibsfwr4tz step 3): counted where each step happens, counts only, never who.
describe("join funnel", () => {
  it("counts a new GitHub sign-in, an ask and a decision with its wait; no user id is stored", () => {
    const { world, seed } = seededWorld();
    const before = joinFunnel(world).totals;
    const { user } = upsertGithubUser(world, { id: 4242, login: "stranger" });
    upsertGithubUser(world, { id: 4242, login: "stranger" }); // a second sign-in is not a new one
    countFunnel(world, "guestCardViews");
    const req = requestAccess(world, user.id);
    requestAccess(world, user.id); // still pending: the same request, not a second ask
    decideAccess(world, { kind: "user", id: seed.admin.id }, req.id, true);
    const f = joinFunnel(world);
    expect(f.totals).toEqual({ guestCardViews: before.guestCardViews + 1, signIns: before.signIns + 1, asked: before.asked + 1, letIn: before.letIn + 1, declined: before.declined });
    expect(f.decisions).toBe(1);
    expect(f.medianDecisionMs).toBeGreaterThanOrEqual(0);
    expect(f.daily.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
    const rows = JSON.stringify([world.db.prepare("SELECT * FROM join_funnel").all(), world.db.prepare("SELECT * FROM join_funnel_waits").all()]);
    expect(rows).not.toContain(user.id);
    expect(rows).not.toContain("stranger");
    expect(world.permissions.rolesOf({ kind: "user", id: user.id }).map((r) => r.id)).toContain(townRoleId("member"));
  });

  it("keeps 30 days: an older day drops out; the median is over the window's waits", () => {
    const { world } = seededWorld();
    const now = Date.parse("2026-11-01T12:00:00Z");
    countFunnel(world, "signIns", now - 40 * 86_400_000);
    countFunnel(world, "signIns", now - 2 * 86_400_000);
    for (const ms of [1_000, 9_000, 5_000]) world.db.prepare("INSERT INTO join_funnel_waits (day, waitMs) VALUES ('2026-10-31', ?)").run(ms);
    const f = joinFunnel(world, 30, now);
    expect(f).toMatchObject({ from: "2026-10-03", to: "2026-11-01", decisions: 3, medianDecisionMs: 5_000 });
    expect(f.totals.signIns).toBe(1);
    const both = sumFunnels([world, seededWorld().world], 30, now);
    expect(both.totals.signIns).toBe(1 + joinFunnel(seededWorld().world, 30, now).totals.signIns);
    expect(both.medianDecisionMs).toBe(5_000);
  });

  it("the migration back-fills sign-ins from events and asks/decisions from access requests", () => {
    const all = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const dir = mkdtempSync(join(tmpdir(), "funnel-"));
    const files = readdirSync(all).filter((f) => f.endsWith(".sql"));
    for (const f of files.filter((f) => !f.includes("join_funnel"))) copyFileSync(join(all, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    const ev = db.prepare("INSERT INTO events (ts, type, text) VALUES (?, 'system', ?)");
    ev.run("2026-10-29T23:05:00.000Z", "Ed Wadli signed in with GitHub (@edwadli)");
    ev.run("2026-10-29T23:06:00.000Z", "Mitchell linked GitHub account @mitchellgordon95");
    const ar = db.prepare("INSERT INTO access_requests (id, userId, status, createdAt, decidedAt) VALUES (?, ?, ?, ?, ?)");
    ar.run("ar_1", "us_1", "granted", "2026-10-30T10:00:00.000Z", "2026-10-30T12:00:00.000Z");
    ar.run("ar_2", "us_2", "pending", "2026-10-30T11:00:00.000Z", null);
    for (const f of files.filter((f) => f.includes("join_funnel"))) copyFileSync(join(all, f), join(dir, f));
    migrate(db, dir);
    expect(db.prepare("SELECT * FROM join_funnel ORDER BY day").all()).toEqual([
      { day: "2026-10-29", guestCardViews: 0, signIns: 1, asked: 0, letIn: 0, declined: 0 },
      { day: "2026-10-30", guestCardViews: 0, signIns: 0, asked: 2, letIn: 1, declined: 0 },
    ]);
    expect(db.prepare("SELECT * FROM join_funnel_waits").all()).toEqual([{ day: "2026-10-30", waitMs: 7_200_000 }]);
  });
});
