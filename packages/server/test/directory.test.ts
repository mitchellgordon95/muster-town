import { World } from "@muster-town/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { Directory, LIMITS, newToken } from "../src/directory/index.ts";
import { normalizeHost } from "../src/directory/net.ts";

describe("normalizeHost", () => {
  it.each([
    ["town.example.org", "town.example.org"],
    ["  Town.Example.ORG. ", "town.example.org"],
    ["a-b.co.uk", "a-b.co.uk"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["my-app.fly.dev", "my-app.fly.dev"],
  ])("accepts %s", (input, host) => expect(normalizeHost(input)).toEqual({ host }));

  it.each([
    "", "example", "127.0.0.1", "::1", "[::1]", "8.8.8.8", "town.example.org:8443", "https://town.example.org", "town.example.org/x",
    "user@town.example.org", "localhost", "a.localhost", "box.local", "db.internal", "nas.lan", "x.home.arpa", "abc.onion",
    "x.invalid", "x.test", "x.example", "muster.town", "garden.muster.town", "-bad.example.org", "bad-.example.org",
    "a..b.org", "host.123", "a_b.example.org", "x".repeat(64) + ".org",
  ])("rejects %j", (input) => expect(normalizeHost(input)).toHaveProperty("error"));
});

describe("Directory", () => {
  let world: World;
  let t = Date.parse("2026-10-29T12:00:00Z");
  const dir = () => new Directory({ world, now: () => t });
  beforeAll(() => { world = World.open(":memory:"); });
  afterEach(() => { world.db.exec("DELETE FROM directory_towns; DELETE FROM directory_blocked"); });
  afterAll(() => world.close());

  it("tokens are mtd_ + 26 base32 chars", () => {
    const a = newToken(), b = newToken();
    expect(a).toMatch(/^mtd_[a-z2-7]{26}$/);
    expect(a).not.toBe(b);
  });

  it("register is idempotent: 201 then 200 with the same token, from any asker", () => {
    const d = dir();
    const first = d.register("Town.Example.org", "1.2.3.4");
    expect(first.created).toBe(true);
    expect(first.registration).toMatchObject({ host: "town.example.org", status: "pending" });
    const tok = first.registration.token;
    expect(first.registration.instructions.txt).toEqual({ name: "_muster-town.town.example.org", value: `muster-town-verify=${tok}` });
    expect(first.registration.instructions.wellKnown.env).toBe(`MUSTER_TOWN_DIRECTORY_TOKEN=${tok}`);
    const again = d.register("town.example.org", "5.6.7.8");
    expect(again.created).toBe(false);
    expect(again.registration.token).toBe(tok);
  });

  it("refuses blocked and invalid hosts", () => {
    world.db.prepare("INSERT INTO directory_blocked (host, reason, at) VALUES ('spam.example.org', 'spam', '2026-10-29T00:00:00Z')").run();
    expect(() => dir().register("spam.example.org", "1.2.3.4")).toThrow(/can't be listed/);
    expect(() => dir().register("localhost", "1.2.3.4")).toThrow(/reserved/);
  });

  it("caps pending rows per IP and register calls per IP per day", () => {
    const d = dir();
    for (let i = 0; i < LIMITS.pendingPerIp; i++) d.register(`t${i}.example.org`, "9.9.9.9");
    expect(() => d.register("one-more.example.org", "9.9.9.9")).toThrow(/pending registrations/);
    d.register("other.example.org", "8.8.8.8");
    const d2 = dir();
    for (let i = 0; i < LIMITS.registerPerIpPerDay; i++) d2.register("same.example.org", "7.7.7.7");
    expect(() => d2.register("same.example.org", "7.7.7.7")).toThrow(/Too many/);
  });

  it("lists verified towns seen within 24 h only, memoized 60 s", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const add = (host: string, verifiedAt: string | null, lastSeenAt: string | null) => world.db.prepare(`INSERT INTO directory_towns
      (host, token, createdAt, nextCheckAt, verifiedAt, lastSeenAt, name, goal) VALUES (?, 'mtd_x', ?, ?, ?, ?, 'N', 'G')`).run(host, iso(t), iso(t), verifiedAt, lastSeenAt);
    add("fresh.example.org", iso(t - 48 * 3600_000), iso(t - 3600_000));
    add("stale.example.org", iso(t - 48 * 3600_000), iso(t - 25 * 3600_000));
    add("pending.example.org", null, iso(t - 60_000));
    const d = dir();
    expect(d.list()).toEqual([{ host: "fresh.example.org", url: "https://fresh.example.org/", name: "N", goal: "G", verifiedAt: iso(t - 48 * 3600_000), lastSeenAt: iso(t - 3600_000) }]);
    world.db.prepare("INSERT INTO directory_blocked (host, reason, at) VALUES ('fresh.example.org', 'x', ?)").run(iso(t));
    expect(d.list()).toHaveLength(1);
    t += 61_000;
    expect(d.list()).toEqual([]);
  });
});

describe("directory routes", () => {
  const prev = process.env.MUSTER_TOWN_DIRECTORY_TOKEN;
  afterEach(() => { if (prev === undefined) delete process.env.MUSTER_TOWN_DIRECTORY_TOKEN; else process.env.MUSTER_TOWN_DIRECTORY_TOKEN = prev; });

  it("register and list where the directory is on; client IP from the configured header", async () => {
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: false, directory: new Directory({ world, clientIpHeader: "fly-client-ip" }) });
    const reg = (host: string) => app.inject({ method: "POST", url: "/api/directory/register", payload: { host }, headers: { "fly-client-ip": "203.0.113.9" } });
    const a = await reg("example.org");
    expect(a.statusCode).toBe(201);
    expect(a.json().token).toMatch(/^mtd_[a-z2-7]{26}$/);
    const b = await reg("example.org");
    expect(b.statusCode).toBe(200);
    expect(b.json().token).toBe(a.json().token);
    expect((await reg("localhost")).statusCode).toBe(400);
    expect((world.db.prepare("SELECT createdIp FROM directory_towns").get() as { createdIp: string }).createdIp).toBe("203.0.113.9");
    const list = await app.inject({ method: "GET", url: "/api/directory" });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("public, max-age=60");
    expect(list.json()).toEqual({ towns: [] });
    await app.close(); world.close();
  });

  it("absent when off; /.well-known/muster-town serves the env token on every root app", async () => {
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: false });
    expect((await app.inject({ method: "GET", url: "/api/directory" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/directory/register", payload: { host: "example.org" } })).statusCode).toBe(404);
    delete process.env.MUSTER_TOWN_DIRECTORY_TOKEN;
    expect((await app.inject({ method: "GET", url: "/.well-known/muster-town" })).statusCode).toBe(404);
    process.env.MUSTER_TOWN_DIRECTORY_TOKEN = "mtd_abc";
    const r = await app.inject({ method: "GET", url: "/.well-known/muster-town" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.body).toBe("mtd_abc");
    await app.close(); world.close();
  });
});
