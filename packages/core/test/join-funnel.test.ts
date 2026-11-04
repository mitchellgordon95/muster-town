import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { countFunnel, countMemberAct, countVisitor, decideAccess, isAutomatedClient, joinFunnel, requestAccess, sumFunnels, townRoleId, upsertGithubUser } from "../src/index.ts";
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
    expect(f.totals).toEqual({ ...before, guestCardViews: before.guestCardViews + 1, signIns: before.signIns + 1, asked: before.asked + 1, letIn: before.letIn + 1 });
    expect(f.decisions).toBe(1);
    expect(f.medianDecisionMs).toBeGreaterThanOrEqual(0);
    expect(f.daily.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
    const rows = JSON.stringify([world.db.prepare("SELECT * FROM join_funnel").all(), world.db.prepare("SELECT * FROM join_funnel_waits").all()]);
    expect(rows).not.toContain(user.id);
    expect(rows).not.toContain("stranger");
    expect(world.permissions.rolesOf({ kind: "user", id: user.id }).map((r) => r.id)).toContain(townRoleId("member"));
  });

  it("a visitor counts once per step per UTC day (gr_zoo2cf2zpp): only the id's sha256 is kept, old rows drop, bad ids never count", () => {
    const { world } = seededWorld();
    const now = Date.parse("2026-11-04T12:00:00Z");
    const id = "b6b1b0d2-9d2e-4b42-9b1e-visitor-one";
    expect(countVisitor(world, "guestVisitors", id, now)).toBe(true);
    expect(countVisitor(world, "guestVisitors", id, now)).toBe(false);
    expect(countVisitor(world, "homeViews", id, now)).toBe(true);
    expect(countVisitor(world, "guestVisitors", id, now + 86_400_000)).toBe(true); // a new day
    expect(countVisitor(world, "guestVisitors", "short", now)).toBe(false);
    expect(countVisitor(world, "guestVisitors", "x".repeat(200), now)).toBe(false);
    const f = joinFunnel(world, 30, now + 86_400_000);
    expect(f.totals).toMatchObject({ guestVisitors: 2, homeViews: 1, guestCardViews: 0 });
    const rows = JSON.stringify(world.db.prepare("SELECT * FROM join_funnel_visitors").all());
    expect(rows).not.toContain(id);
    expect(rows).toContain("guestVisitors");
    // rows older than the window go as new ones come
    world.db.prepare("INSERT INTO join_funnel_visitors (day, step, idHash) VALUES ('2026-09-01', 'homeViews', 'old')").run();
    countVisitor(world, "homeViews", "another-visitor-id", now + 86_400_000);
    expect(world.db.prepare("SELECT count(*) AS n FROM join_funnel_visitors WHERE day = '2026-09-01'").get()).toEqual({ n: 0 });
    for (const ua of [undefined, "", "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0", "curl/8.5.0", "python-requests/2.32"]) expect(isAutomatedClient(ua)).toBe(true);
    expect(isAutomatedClient("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")).toBe(false);
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
      { day: "2026-10-29", guestCardViews: 0, signIns: 1, asked: 0, letIn: 0, declined: 0, acted: 0, guestVisitors: 0, signInStarted: 0, homeViews: 0 },
      { day: "2026-10-30", guestCardViews: 0, signIns: 0, asked: 2, letIn: 1, declined: 0, acted: 0, guestVisitors: 0, signInStarted: 0, homeViews: 0 },
    ]);
    expect(db.prepare("SELECT * FROM join_funnel_waits").all()).toEqual([{ day: "2026-10-30", waitMs: 7_200_000 }]);
  });

  it("acted: a let-in member's first Say or 1:1 line counts once; no request, a declined or a pending one never counts", async () => {
    const { world, seed, by, admin } = seededWorld();
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: by("Mei").id });
    const acted = () => joinFunnel(world).totals.acted;
    const join = (id: number, login: string, grant: boolean | null) => {
      const { user } = upsertGithubUser(world, { id, login });
      const req = requestAccess(world, user.id);
      // let in with "direct work under" the building's goal (gr_cuobjlny6r): no permission, no 1:1
      if (grant !== null) decideAccess(world, { kind: "user", id: seed.admin.id }, req.id, grant, grant ? world.goalTree.attachmentOf("carbon-cycle") : null);
      return { user, avatar: world.ops.ensureAvatar(user.id) };
    };
    const ana = join(5001, "ana", true);
    expect(acted()).toBe(0);
    await world.verbs.say(ana.avatar, { text: "hello" });
    expect(acted()).toBe(1);
    expect(world.db.prepare("SELECT actedAt FROM access_requests WHERE userId = ?").get(ana.user.id)).toMatchObject({ actedAt: expect.any(String) });
    await world.verbs.say(ana.avatar, { text: "hello again" });
    const m = world.ops.openOneOnOne(ana.avatar, "carbon-cycle");
    world.ops.meetingSay(ana.avatar, m.id, "What should I do first?");
    expect(acted()).toBe(1);
    // a member whose first act is a 1:1 line counts too
    const bo = join(5002, "bo", true);
    world.ops.meetingSay(bo.avatar, world.ops.openOneOnOne(bo.avatar, "carbon-cycle").id, "hi");
    expect(acted()).toBe(2);
    // declined, pending, and an admin who never asked: never counted
    const cy = join(5003, "cy", false), di = join(5004, "di", null);
    expect(countMemberAct(world, cy.user.id)).toBe(false);
    expect(countMemberAct(world, di.user.id)).toBe(false);
    await world.verbs.say(admin, { text: "admin talks" });
    expect(acted()).toBe(2);
    const rows = JSON.stringify(world.db.prepare("SELECT * FROM join_funnel").all());
    expect(rows).not.toContain(ana.user.id);
  });
});
