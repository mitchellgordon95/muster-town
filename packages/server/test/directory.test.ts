import { World } from "@muster-town/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { Directory, directoryEnabled, LIMITS, newToken } from "../src/directory/index.ts";
import { blockedAddress, type Fetcher, normalizeHost, resolveTxtProof, safeGet, type TxtResolver } from "../src/directory/net.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("directoryEnabled", () => {
  it("the flag decides; unset, on only for muster.town", () => {
    expect(directoryEnabled("on", undefined)).toBe(true);
    expect(directoryEnabled(" ON ", "https://example.org")).toBe(true);
    expect(directoryEnabled("off", "https://muster.town")).toBe(false);
    expect(directoryEnabled(undefined, "https://muster.town")).toBe(true);
    expect(directoryEnabled("", "https://muster.town/")).toBe(true);
    expect(directoryEnabled(undefined, "https://town.example.org")).toBe(false);
    expect(directoryEnabled(undefined, "https://www.muster.town")).toBe(false);
    expect(directoryEnabled(undefined, undefined)).toBe(false);
    expect(directoryEnabled(undefined, "not a url")).toBe(false);
  });
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

describe("safeGet (SSRF guard)", () => {
  const opts = { timeoutMs: 2000, maxBytes: 1024 };
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "fdaa::1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "100.64.1.1", "172.16.5.5", "192.168.1.1", "0.0.0.0", "224.0.0.1", "fe80::1", "fc00::1"])
    ("blockedAddress(%s)", (a) => expect(blockedAddress(a)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "66.241.124.1", "::ffff:8.8.8.8"])("allows %s", (a) => expect(blockedAddress(a)).toBe(false));

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "[fdaa::1]"])("refuses an IP literal %s", async (ip) => {
    await expect(safeGet(`https://${ip}/x`, opts)).rejects.toThrow(/refused/);
  });

  it("refuses a host whose lookup resolves to a private address (any of them)", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "fdaa::1"]) {
      const lookupAll = async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }];
      await expect(safeGet("https://rebind.example.org/", { ...opts, lookupAll })).rejects.toThrow(/resolves to/);
    }
  });

  it("refuses http and does not follow a 302", async () => {
    await expect(safeGet("http://example.org/", opts)).rejects.toThrow(/https only/);
    // a real TLS server on loopback, reached by letting the test (only) allow loopback: the 302 is refused, not followed
    const dirp = mkdtempSync(join(tmpdir(), "safeget-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=redirect.example.org",
      "-addext", "subjectAltName=DNS:redirect.example.org", "-keyout", join(dirp, "k.pem"), "-out", join(dirp, "c.pem")], { stdio: "ignore" });
    const cert = readFileSync(join(dirp, "c.pem"), "utf8"), key = readFileSync(join(dirp, "k.pem"), "utf8");
    let body = "ok";
    const srv = createHttpsServer({ cert, key }, (req, res) => {
      if (req.url === "/302") { res.writeHead(302, { location: "http://169.254.169.254/" }); return res.end(); }
      expect(req.headers["user-agent"]).toBe("muster.town-directory/1 (+https://muster.town)");
      expect(req.headers.cookie).toBeUndefined();
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const via = { ...opts, ca: cert, isBlocked: () => false, lookupAll: async () => [{ address: "127.0.0.1", family: 4 }] };
    try {
      await expect(safeGet(`https://redirect.example.org:${port}/302`, via)).rejects.toThrow(/redirected to http:\/\/169\.254\.169\.254\//);
      expect(await safeGet(`https://redirect.example.org:${port}/ok`, via)).toEqual({ status: 200, body: "ok" });
      body = "x".repeat(5000);
      await expect(safeGet(`https://redirect.example.org:${port}/big`, via)).rejects.toThrow(/over 1024 bytes/);
      // without the test's allowance the same loopback address is refused
      await expect(safeGet(`https://redirect.example.org:${port}/ok`, { ...via, isBlocked: undefined })).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    } finally {
      srv.close();
      rmSync(dirp, { recursive: true, force: true });
    }
  });
});

describe("resolveTxtProof", () => {
  const tok = "mtd_abc";
  const fake = (records: string[][] | { code: string }): TxtResolver => async (name) => {
    expect(name).toBe("_muster-town.town.example.org");
    if (!Array.isArray(records)) throw Object.assign(new Error(records.code), records);
    return records;
  };
  it("passes on muster-town-verify=<token> (chunks joined) or the bare token", async () => {
    expect(await resolveTxtProof("town.example.org", tok, fake([["v=spf1"], ["muster-town-ver", "ify=mtd_abc"]]))).toEqual({ result: "pass" });
    expect(await resolveTxtProof("town.example.org", tok, fake([["mtd_abc"]]))).toEqual({ result: "pass" });
  });
  it("no proof on a wrong value, ENOTFOUND or ENODATA; couldn't check on ETIMEOUT/ESERVFAIL", async () => {
    expect((await resolveTxtProof("town.example.org", tok, fake([["muster-town-verify=mtd_other"]]))).result).toBe("none");
    expect((await resolveTxtProof("town.example.org", tok, fake({ code: "ENOTFOUND" }))).result).toBe("none");
    expect((await resolveTxtProof("town.example.org", tok, fake({ code: "ENODATA" }))).result).toBe("none");
    expect((await resolveTxtProof("town.example.org", tok, fake({ code: "ETIMEOUT" }))).result).toBe("error");
    expect((await resolveTxtProof("town.example.org", tok, fake({ code: "ESERVFAIL" }))).result).toBe("error");
  });
});

describe("Directory checks (fake DNS, fake HTTPS, fake clock)", () => {
  let world: World;
  let t = Date.parse("2026-10-30T12:00:00Z");
  const H = 3600_000;
  /** what the fake internet serves: the TXT records and the HTTPS bodies per URL */
  let txt: string[][] | { code: string } = { code: "ENOTFOUND" };
  let web: Record<string, { status: number; body: string } | Error> = {};
  const resolveTxt: TxtResolver = async () => { if (!Array.isArray(txt)) throw Object.assign(new Error(txt.code), txt); return txt; };
  const fetch: Fetcher = async (url) => { const r = web[url]; if (!r) return { status: 404, body: "" }; if (r instanceof Error) throw r; return r; };
  const dir = () => new Directory({ world, now: () => t, resolveTxt, fetch, random: () => 0.5 });
  const row = (host = "town.example.org") => world.db.prepare("SELECT * FROM directory_towns WHERE host = ?").get(host) as Record<string, any> | undefined;
  const townUp = (host = "town.example.org") => {
    web[`https://${host}/api/health`] = { status: 200, body: JSON.stringify({ ok: true }) };
    web[`https://${host}/api/collectives`] = { status: 200, body: JSON.stringify({ collectives: [{ name: "Example\u0007 Town", goal: "g".repeat(400) }] }) };
  };
  beforeAll(() => { world = World.open(":memory:"); });
  afterEach(() => { world.db.exec("DELETE FROM directory_towns; DELETE FROM directory_blocked"); txt = { code: "ENOTFOUND" }; web = {}; t = Date.parse("2026-10-30T12:00:00Z"); });
  afterAll(() => world.close());

  it("well-known pass + town answering: verified, seen, name/goal cleaned and capped, listed", async () => {
    const d = dir();
    const tok = d.register("town.example.org", "1.2.3.4").registration.token;
    web["https://town.example.org/.well-known/muster-town"] = { status: 200, body: `${tok}\n` };
    townUp();
    const r = await d.check("town.example.org");
    expect(r).toMatchObject({ status: "verified", proof: "well-known", verifiedAt: new Date(t).toISOString(), lastSeenAt: new Date(t).toISOString(), lastError: null });
    expect(row()).toMatchObject({ name: "Example Town", proofMisses: 0, nextCheckAt: new Date(t + H).toISOString() });
    expect(row()!.goal).toHaveLength(300);
    expect(d.list().map((x) => x.host)).toEqual(["town.example.org"]);
  });

  it("well-known fails on a wrong body, a 404 or a fetch error", async () => {
    const d = dir();
    d.register("town.example.org", "1.2.3.4");
    townUp();
    for (const v of [{ status: 200, body: "mtd_wrong" }, { status: 404, body: "" }, new Error("redirected to https://evil/")]) {
      web["https://town.example.org/.well-known/muster-town"] = v;
      expect(await d.check("town.example.org")).toMatchObject({ status: "pending", verifiedAt: null });
    }
    expect(row()!.lastError).toMatch(/redirected to/);
  });

  it("TXT pass without the town answering: verifiedAt set, lastSeenAt not, not listed", async () => {
    const d = dir();
    const tok = d.register("town.example.org", "1.2.3.4").registration.token;
    txt = [[`muster-town-verify=${tok}`]];
    const r = await d.check("town.example.org");
    expect(r).toMatchObject({ status: "verified", proof: "txt", lastSeenAt: null });
    expect(r!.lastError).toMatch(/didn't answer/);
    expect(d.list()).toEqual([]);
  });

  it("two misses at least 1 h apart delist; one miss does not; re-adding the proof re-verifies with the same token", async () => {
    const d = dir();
    const tok = d.register("town.example.org", "1.2.3.4").registration.token;
    txt = [[tok]];
    townUp();
    await d.check("town.example.org");
    txt = { code: "ENODATA" };
    t += H;
    expect(await d.check("town.example.org")).toMatchObject({ status: "verified" });
    expect(row()!.proofMisses).toBe(1);
    t += 10 * 60_000; // a /verify 10 min later: too soon to count as the second miss
    expect(await d.check("town.example.org")).toMatchObject({ status: "verified" });
    expect(d.list()).toHaveLength(1);
    t += 50 * 60_000;
    expect(await d.check("town.example.org")).toMatchObject({ status: "pending", verifiedAt: null, proof: null });
    expect(d.list()).toEqual([]);
    txt = { code: "ETIMEOUT" }; // couldn't check: never a miss, stays pending
    t += H;
    expect(await d.check("town.example.org")).toMatchObject({ status: "pending" });
    txt = [[tok]];
    t += H;
    expect(await d.check("town.example.org")).toMatchObject({ status: "verified", proof: "txt" });
    expect(d.register("town.example.org", "1.2.3.4").registration.token).toBe(tok);
  });

  it("a DNS timeout on a verified row is not a miss", async () => {
    const d = dir();
    const tok = d.register("town.example.org", "1.2.3.4").registration.token;
    txt = [[tok]];
    townUp();
    await d.check("town.example.org");
    txt = { code: "ETIMEOUT" };
    for (let i = 0; i < 3; i++) { t += 2 * H; await d.check("town.example.org"); }
    expect(row()).toMatchObject({ proofMisses: 0, proof: "txt" });
  });

  it("pending schedule +1, +5, +15 min, +1 h, +6 h, then daily; deleted after 7 days by the checker", async () => {
    const d = dir();
    const created = t;
    d.register("town.example.org", "1.2.3.4");
    expect(row()!.nextCheckAt).toBe(new Date(created + 60_000).toISOString());
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      t = Date.parse(row()!.nextCheckAt);
      await d.tick();
      seen.push(Date.parse(row()!.nextCheckAt) - created);
    }
    const M = 60_000;
    expect(seen).toEqual([5 * M, 15 * M, H, 6 * H, 30 * H, 54 * H, 78 * H]);
    t = created + 7 * 24 * H;
    await d.tick();
    expect(row()).toBeUndefined();
  });

  it("the checker takes due rows only, keeps state in the table, and deletes rows unseen for 7 days", async () => {
    const d = dir();
    const tok = d.register("a.example.org", "1.2.3.4").registration.token;
    web["https://a.example.org/.well-known/muster-town"] = { status: 200, body: tok };
    townUp("a.example.org");
    t += 60_000;
    await d.tick();
    expect(row("a.example.org")!.verifiedAt).not.toBeNull();
    expect(d.view()).toMatchObject({ verified: 1, listed: 1, pending: 0, lastTickAt: new Date(t).toISOString() });
    // the town goes dark (proof still up): off the list after 24 h, deleted after 7 days unseen
    web["https://a.example.org/api/health"] = { status: 503, body: "" };
    const fresh = () => new Directory({ world, now: () => t, resolveTxt, fetch, random: () => 0.5 });
    t += 25 * H;
    await fresh().tick();
    expect(fresh().list()).toEqual([]);
    expect(row("a.example.org")!.verifiedAt).not.toBeNull();
    t += 6 * 24 * H;
    await fresh().tick();
    expect(row("a.example.org")).toBeUndefined();
  });

  it("verify: one check per host per 60 s, 30 per IP per hour, 404 unregistered", async () => {
    const d = dir();
    let fetches = 0;
    const counting = new Directory({ world, now: () => t, resolveTxt: async () => { fetches++; throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }, fetch });
    d.register("town.example.org", "1.2.3.4");
    await counting.verify("town.example.org", "1.1.1.1");
    await counting.verify("town.example.org", "1.1.1.1");
    expect(fetches).toBe(1);
    t += 61_000;
    await counting.verify("Town.Example.org", "1.1.1.1");
    expect(fetches).toBe(2);
    await expect(d.verify("nope.example.org", "1.1.1.1")).rejects.toThrow(/isn't registered/);
    for (let i = 0; i < LIMITS.verifyPerIpPerHour - 2; i++) { t += 61_000; await counting.verify("town.example.org", "1.1.1.1"); }
    t += 61_000;
    await expect(counting.verify("town.example.org", "1.1.1.1")).rejects.toThrow(/Too many verify/);
  });
});

describe("directory routes: verify, admin DELETE, health", () => {
  it("verify returns the check; DELETE needs an admin and blocks re-registration; health shows the counts", async () => {
    const world = World.open(":memory:");
    const seed = world.seedDefaults({ adminName: "Mitchell" });
    let tok = "";
    const directory = new Directory({ world, resolveTxt: async () => [[tok]], fetch: async (url) => url.endsWith("/api/health")
      ? { status: 200, body: '{"ok":true}' } : url.endsWith("/api/collectives") ? { status: 200, body: '{"collectives":[{"name":"T","goal":"G"}]}' } : { status: 404, body: "" } });
    const app = await buildApp({ world, webDist: false, directory });
    tok = (await app.inject({ method: "POST", url: "/api/directory/register", payload: { host: "town.example.org" } })).json().token;
    const v = await app.inject({ method: "POST", url: "/api/directory/verify", payload: { host: "town.example.org" } });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ host: "town.example.org", status: "verified", proof: "txt", lastError: null });
    expect((await app.inject({ method: "GET", url: "/api/directory" })).json().towns).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/directory/verify", payload: { host: "nope.example.org" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().directory).toEqual({ verified: 1, listed: 1, pending: 0, lastTickAt: null });
    expect((await app.inject({ method: "DELETE", url: "/api/directory/town.example.org", payload: { reason: "spam" } })).statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/api/directory/town.example.org", payload: { reason: "spam" }, headers: { authorization: `Bearer ${seed.adminToken}` } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ host: "town.example.org", removed: true });
    expect((await app.inject({ method: "GET", url: "/api/directory" })).json().towns).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/directory/register", payload: { host: "town.example.org" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().directory).toEqual({ verified: 0, listed: 0, pending: 0, lastTickAt: null });
    await app.close(); world.close();
  });

  it("health has no directory section where it's off", async () => {
    const world = World.open(":memory:");
    const app = await buildApp({ world, webDist: false });
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).not.toHaveProperty("directory");
    await app.close(); world.close();
  });
});
