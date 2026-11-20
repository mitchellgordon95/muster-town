import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.ts";
import { countBlogRead, countFunnel, countMemberAct, countVisitor, countVisitorFrom, funnelSource, MAX_SOURCES_PER_DAY, decideAccess, HOME_STEPS, isAutomatedClient, joinFunnel, requestAccess, sumFunnels, townRoleId, upsertGithubUser } from "../src/index.ts";
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

  it("crawlers never count (gr_ptle4vvujl): Googlebot, bingbot and the other named bots; real browsers, a Cubot phone included, still do", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
      "DuckDuckBot-Https/1.1; (+https://duckduckgo.com/duckduckbot)",
      "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
      "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
    ]) expect(isAutomatedClient(ua), ua).toBe(true);
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0",
      "Mozilla/5.0 (Linux; Android 9; CUBOT X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    ]) expect(isAutomatedClient(ua), ua).toBe(false);
  });

  it("the homepage card steps (gr_ptle4vvujl) count a browser once per step per day, each its own column", () => {
    const { world } = seededWorld();
    const now = Date.parse("2026-11-17T12:00:00Z");
    const id = "home-card-visitor-0001";
    for (const step of [HOME_STEPS.page2, HOME_STEPS.page3, HOME_STEPS.page2, HOME_STEPS.open, HOME_STEPS.tile, HOME_STEPS.skip]) countVisitor(world, step, id, now);
    expect(joinFunnel(world, 30, now).totals).toMatchObject({ homePage2: 1, homePage3: 1, homeSkip: 1, homeOpen: 1, homeTile: 1, homeViews: 0 });
  });

  it("sources (gr_ox3fmliv9n): a ref tag, else the external referrer's host, else direct; never a path", () => {
    expect(funnelSource({ ref: "HN-launch", referrer: "https://news.ycombinator.com/item?id=1" })).toBe("ref:hn-launch");
    expect(funnelSource({ ref: "x".repeat(25), referrer: "https://news.ycombinator.com/item?id=1" })).toBe("news.ycombinator.com");
    expect(funnelSource({ ref: "bad tag!", referrer: "https://www.Reddit.com:443/r/x?y=1" })).toBe("reddit.com");
    expect(funnelSource({ referrer: "https://muster.town/blog/x", ownHost: "muster.town" })).toBe("direct");
    expect(funnelSource({ referrer: "https://www.muster.town/", ownHost: "muster.town:443" })).toBe("direct");
    expect(funnelSource({ referrer: "android-app://com.slack/" })).toBe("direct");
    expect(funnelSource({ referrer: "not a url" })).toBe("direct");
    expect(funnelSource({})).toBe("direct");
    expect(funnelSource({ ref: 42, referrer: ["x"] })).toBe("direct");
  });

  it("a visitor's source counts once with its first ping of the day; sources add up to homeViews; blog reads per slug; summed across collectives", () => {
    const { world } = seededWorld();
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(countVisitorFrom(world, "homeViews", "visitor-one-xyz", "news.ycombinator.com", now)).toBe(true);
    expect(countVisitorFrom(world, "homeViews", "visitor-one-xyz", "direct", now)).toBe(false); // same browser, same day
    expect(countVisitorFrom(world, "homeViews", "visitor-two-xyz", "news.ycombinator.com", now)).toBe(true);
    expect(countVisitorFrom(world, "guestVisitors", "visitor-one-xyz", "ref:test", now)).toBe(true);
    expect(countVisitorFrom(world, "homeViews", "short", "direct", now)).toBe(false); // a bad id never counts
    countBlogRead(world, "a-post", "news.ycombinator.com", now);
    countBlogRead(world, "a-post", "news.ycombinator.com", now);
    countBlogRead(world, "a-post", "direct", now);
    const f = joinFunnel(world, 30, now);
    expect(f.sources).toEqual([
      { day: "2026-11-20", step: "homeViews", source: "news.ycombinator.com", count: 2 },
      { day: "2026-11-20", step: "guestVisitors", source: "ref:test", count: 1 },
    ]);
    expect(f.sources.filter((r) => r.step === "homeViews").reduce((n, r) => n + r.count, 0)).toBe(f.totals.homeViews);
    expect(f.blogReads).toEqual([
      { day: "2026-11-20", slug: "a-post", source: "news.ycombinator.com", count: 2 },
      { day: "2026-11-20", slug: "a-post", source: "direct", count: 1 },
    ]);
    const other = seededWorld().world;
    countBlogRead(other, "a-post", "direct", now);
    const both = sumFunnels([world, other], 30, now);
    expect(both.blogReads).toContainEqual({ day: "2026-11-20", slug: "a-post", source: "direct", count: 2 });
    expect(both.sources).toEqual(f.sources);
    expect(joinFunnel(world, 30, now + 31 * 86_400_000).sources).toEqual([]); // out of the window
  });

  it("a day past MAX_SOURCES_PER_DAY distinct sources folds new ones into other", () => {
    const { world } = seededWorld();
    const now = Date.parse("2026-11-20T12:00:00Z");
    for (let i = 0; i < MAX_SOURCES_PER_DAY; i++) countBlogRead(world, "p", `s${i}.example`, now);
    countBlogRead(world, "p", "one-too-many.example", now);
    countBlogRead(world, "p", "s0.example", now);
    const rows = joinFunnel(world, 30, now).blogReads;
    expect(rows).toHaveLength(MAX_SOURCES_PER_DAY + 1);
    expect(rows).toContainEqual({ day: "2026-11-20", slug: "p", source: "other", count: 1 });
    expect(rows).toContainEqual({ day: "2026-11-20", slug: "p", source: "s0.example", count: 2 });
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
      { day: "2026-10-29", guestCardViews: 0, signIns: 1, asked: 0, letIn: 0, declined: 0, acted: 0, guestVisitors: 0, signInStarted: 0, homeViews: 0, doorFund: 0, doorCaptain: 0, doorAgent: 0, homePage2: 0, homePage3: 0, homeSkip: 0, homeOpen: 0, homeTile: 0 },
      { day: "2026-10-30", guestCardViews: 0, signIns: 0, asked: 2, letIn: 1, declined: 0, acted: 0, guestVisitors: 0, signInStarted: 0, homeViews: 0, doorFund: 0, doorCaptain: 0, doorAgent: 0, homePage2: 0, homePage3: 0, homeSkip: 0, homeOpen: 0, homeTile: 0 },
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
