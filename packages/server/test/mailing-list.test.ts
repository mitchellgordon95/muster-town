/** The blog's mailing list (mt_msnjkpgwdb decision 7): subscribe, dedupe, honeypot, rate limit, admin-only export. */
import { describe, expect, it } from "vitest";
import { normalizeEmail } from "../src/mailing-list.ts";
import { json, seededApp } from "./helpers.ts";


describe("mailing list", () => {
  it("normalizes addresses and refuses what isn't one", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["", "ada", "ada@", "@example.com", "a@b@c.com", "ada @example.com", "ada@example", `${"a".repeat(250)}@x.io`]) expect(normalizeEmail(bad)).toBeNull();
  });

  it("subscribes, lowercases and dedupes; a bad address is 400; the honeypot drops silently; admins read it, as JSON or CSV", async () => {
    const t = await seededApp();
    try {
      const a = await json(t.app, "POST", "/api/blog/subscribe", { body: { email: " Ada@Example.com", source: "hello-from-muster-town" } });
      expect(a).toEqual({ status: 200, body: { ok: true } });
      expect((await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "ada@example.com", source: "index" } })).body).toEqual({ ok: true });
      const bad = await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "not an address" } });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("bad_request");
      expect((await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "bot@spam.example", website: "http://spam" } })).body).toEqual({ ok: true });
      await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "bob@example.org" } });

      const r = await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth });
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(2);
      expect(r.body.subscribers.map((s: { email: string; source: string }) => [s.email, s.source])).toEqual([["ada@example.com", "hello-from-muster-town"], ["bob@example.org", "index"]]);

      const csv = await t.app.inject({ url: "/api/blog/subscribers?format=csv", headers: t.auth });
      expect(csv.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.body.split("\n")[0]).toBe("email,createdAt,source");
      expect(csv.body).toContain("ada@example.com,");
    } finally { await t.close(); }
  });

  it("refuses the list to guests and to non-admin users", async () => {
    const t = await seededApp();
    try {
      expect((await json(t.app, "GET", "/api/blog/subscribers")).status).toBe(401);
      const { token } = t.world.ops.createUser("Stranger");
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    } finally { await t.close(); }
  });

  it("rate-limits each client to 10 signups an hour", async () => {
    const t = await seededApp();
    try {
      for (let i = 0; i < 10; i++) expect((await json(t.app, "POST", "/api/blog/subscribe", { body: { email: `u${i}@example.com` } })).status).toBe(200);
      const r = await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "u10@example.com" } });
      expect(r.status).toBe(429);
      expect(r.body.code).toBe("rate_limited");
    } finally { await t.close(); }
  });
});
