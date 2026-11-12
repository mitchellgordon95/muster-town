/** The blog's mailing list (mt_msnjkpgwdb decision 7): subscribe, dedupe, honeypot, rate limit, admin-only export. */
import { describe, expect, it } from "vitest";
import { resendSender, type Mail } from "../src/mail.ts";
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
      expect(csv.body.split("\n")[0]).toBe("email,createdAt,source,confirmed");
      expect(csv.body).toContain("ada@example.com,");
      expect(csv.body).toMatch(/bob@example\.org,[^,]+,index,yes/);
      expect(r.body.confirmed).toBe(2);
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

  it("sends nothing without RESEND_API_KEY: the sender is off and never calls fetch", async () => {
    let calls = 0;
    const off = resendSender({ apiKey: "  ", fetch: (async () => { calls++; return new Response("{}"); }) as typeof fetch });
    expect(off.enabled).toBe(false);
    await off.send({ to: "a@example.com", subject: "s", text: "t" });
    expect(calls).toBe(0);
    const t = await seededApp({ mail: off });
    try {
      expect((await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "ada@example.com" } })).body).toEqual({ ok: true });
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body.subscribers[0].confirmed).toBe(true);
      expect(calls).toBe(0);
    } finally { await t.close(); }
  });

  it("calls Resend's API with the key, the from address and the headers; a refusal throws", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fake = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(status === 200 ? '{"id":"x"}' : '{"message":"bad"}', { status }); }) as unknown as typeof fetch;
    const s = resendSender({ apiKey: "re_test", from: "Muster Town <blog@mail.muster.town>", fetch: fake });
    expect(s.enabled).toBe(true);
    await s.send({ to: "ada@example.com", subject: "Hi", text: "Body", headers: { "List-Unsubscribe": "<https://x/u>" } });
    expect(seen[0].url).toBe("https://api.resend.com/emails");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ from: "Muster Town <blog@mail.muster.town>", to: ["ada@example.com"], subject: "Hi", text: "Body", headers: { "List-Unsubscribe": "<https://x/u>" } });
    status = 422;
    await expect(s.send({ to: "ada@example.com", subject: "Hi", text: "Body" })).rejects.toThrow(/HTTP 422/);
  });

  it("with a sender: double opt-in, a confirm link, a one-click unsubscribe link (GET and RFC 8058 POST)", async () => {
    const sent: Mail[] = [];
    let fail = false;
    const mail = { enabled: true, async send(m: Mail) { if (fail) throw new Error("down"); sent.push(m); } };
    const t = await seededApp({ mail });
    try {
      expect((await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "Ada@Example.com", source: "hello-from-muster-town" } })).body).toEqual({ ok: true, confirm: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@example.com");
      const confirmUrl = /https:\/\/muster\.town(\/api\/blog\/confirm\?token=\S+)/.exec(sent[0].text)![1];
      const unsubUrl = /https:\/\/muster\.town(\/api\/blog\/unsubscribe\?token=\S+)/.exec(sent[0].text)![1];
      expect(sent[0].headers).toEqual({ "List-Unsubscribe": `<https://muster.town${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

      let list = (await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body;
      expect([list.count, list.confirmed, list.subscribers[0].confirmed]).toEqual([1, 0, false]);
      // a repeat while unconfirmed sends the same link again
      await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "ada@example.com" } });
      expect(sent).toHaveLength(2);
      expect(sent[1].text).toContain(confirmUrl);

      const c = await t.app.inject({ url: confirmUrl });
      expect(c.statusCode).toBe(200);
      expect(c.body).toContain("You're in");
      expect((await t.app.inject({ url: confirmUrl })).statusCode).toBe(404);
      expect((await t.app.inject({ url: "/api/blog/confirm?token=nope" })).statusCode).toBe(404);
      list = (await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body;
      expect([list.count, list.confirmed]).toEqual([1, 1]);
      // confirmed: a stranger re-posting the address sends nothing
      await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "ada@example.com" } });
      expect(sent).toHaveLength(2);

      const u = await t.app.inject({ url: unsubUrl });
      expect(u.statusCode).toBe(200);
      expect(u.body).toContain("unsubscribed");
      expect((await t.app.inject({ url: unsubUrl })).statusCode).toBe(200);
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body.count).toBe(0);

      // signing up again needs a new confirmation; the mail client's one-click POST unsubscribes too
      await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "ada@example.com" } });
      expect(sent).toHaveLength(3);
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body.count).toBe(0);
      await t.app.inject({ url: /\/api\/blog\/confirm\?token=\S+/.exec(sent[2].text)![0] });
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body.count).toBe(1);
      const post = await t.app.inject({ method: "POST", url: unsubUrl, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
      expect(post.statusCode).toBe(200);
      expect((await json(t.app, "GET", "/api/blog/subscribers", { headers: t.auth })).body.count).toBe(0);

      // Resend down: the signup says so (the row stays; a retry sends the link)
      fail = true;
      const r = await json(t.app, "POST", "/api/blog/subscribe", { body: { email: "bob@example.org" } });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/confirmation email/);
    } finally { await t.close(); }
  });
});
