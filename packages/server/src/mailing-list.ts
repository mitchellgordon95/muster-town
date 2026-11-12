import { AppError, type World } from "@muster-town/core";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, requireUser } from "./context.ts";
import type { Mail, MailSender } from "./mail.ts";

/**
 * The blog's mailing list (Mitchell, mt_msnjkpgwdb decision 7): the form at the foot of every blog page (blog.ts) posts
 * here. Root app only. `POST /api/blog/subscribe {email, source?, website?}` is public: a repeat answers ok like the first
 * time, the honeypot `website` (hidden from people) drops bots silently, and each client IP may post 10 times an hour.
 * `GET /api/blog/subscribers[?format=csv]` is for admins.
 *
 * Double opt-in once the town has a mail sender (mail.ts, `RESEND_API_KEY`; Mitchell 2026-11-12 on ak_cb6gz3ru9k): a new
 * address is stored unconfirmed and gets a confirmation email; `GET /api/blog/confirm?token=` confirms it. Every email
 * carries `GET /api/blog/unsubscribe?token=` (and a List-Unsubscribe header, whose one-click POST goes to the same URL).
 * Without a key nothing is sent and a signup is confirmed at once (single opt-in), as before the sender existed.
 */
const PER_HOUR = 10;
const HOUR_MS = 3600_000;

const SubscribeInput = z.object({
  email: z.string().max(400),
  source: z.string().max(100).optional(),
  /** the honeypot: a hidden field people leave empty */
  website: z.string().max(400).optional(),
});

/** One @, something on each side, a dot in the domain, no spaces, at most 254 characters; null when it isn't an address. */
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || /\s/.test(e)) return null;
  return /^[^@]+@[^@]+\.[^@.]+$/.test(e) ? e : null;
}

const SOURCE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,80}$/;
const newToken = () => randomBytes(24).toString("base64url");

interface Subscriber { email: string; createdAt: string; source: string; confirmed: boolean }
interface Row { email: string; confirmedAt: string | null; confirmToken: string | null; unsubscribeToken: string | null; unsubscribedAt: string | null }

class MailingList {
  constructor(private readonly world: World, private readonly now: () => number = Date.now) {}

  private iso(): string { return new Date(this.now()).toISOString(); }

  /**
   * Add an address (already normalized). `confirm` false (no mail sender): a new address is confirmed at once and a repeat
   * is ignored; returns null. `confirm` true: returns the tokens to email, or null when the address is already confirmed and
   * subscribed (nothing is sent: a stranger can't make us mail a subscriber again). An unconfirmed address gets its token
   * again; an unsubscribed one gets a new confirm token and stays unsubscribed until it confirms.
   */
  add(email: string, source: string, confirm: boolean): { confirmToken: string; unsubscribeToken: string } | null {
    const db = this.world.db;
    const row = db.prepare("SELECT email, confirmedAt, confirmToken, unsubscribeToken, unsubscribedAt FROM mailing_list WHERE email = ?").get(email) as Row | undefined;
    if (!row) {
      const confirmToken = confirm ? newToken() : null, unsubscribeToken = newToken();
      db.prepare("INSERT INTO mailing_list (email, createdAt, source, confirmedAt, confirmToken, unsubscribeToken) VALUES (?, ?, ?, ?, ?, ?)")
        .run(email, this.iso(), SOURCE.test(source) ? source : "index", confirm ? null : this.iso(), confirmToken, unsubscribeToken);
      return confirmToken ? { confirmToken, unsubscribeToken } : null;
    }
    if (!confirm) return null;
    if (row.confirmedAt && !row.unsubscribedAt) return null;
    const confirmToken = row.confirmToken ?? newToken(), unsubscribeToken = row.unsubscribeToken ?? newToken();
    db.prepare("UPDATE mailing_list SET confirmToken = ?, unsubscribeToken = ? WHERE email = ?").run(confirmToken, unsubscribeToken, email);
    return { confirmToken, unsubscribeToken };
  }

  /** The confirm link: confirms (and re-subscribes) the address; false when no row has this token. */
  confirm(token: string): boolean {
    return this.world.db.prepare("UPDATE mailing_list SET confirmedAt = ?, confirmToken = NULL, unsubscribedAt = NULL WHERE confirmToken = ?").run(this.iso(), token).changes > 0;
  }

  /** The unsubscribe link: false when no row has this token; a second click is true again. */
  unsubscribe(token: string): boolean {
    const db = this.world.db;
    if (!db.prepare("SELECT 1 FROM mailing_list WHERE unsubscribeToken = ?").get(token)) return false;
    db.prepare("UPDATE mailing_list SET unsubscribedAt = ?, confirmToken = NULL WHERE unsubscribeToken = ? AND unsubscribedAt IS NULL").run(this.iso(), token);
    return true;
  }

  /** The subscribed addresses (confirmed or still waiting to confirm), oldest first. */
  list(): Subscriber[] {
    return (this.world.db.prepare("SELECT email, createdAt, source, confirmedAt FROM mailing_list WHERE unsubscribedAt IS NULL ORDER BY createdAt, email").all() as Array<Omit<Subscriber, "confirmed"> & { confirmedAt: string | null }>)
      .map(({ confirmedAt, ...s }) => ({ ...s, confirmed: confirmedAt !== null }));
  }
}

/** The confirmation email, with its unsubscribe link in the body and in the List-Unsubscribe header (RFC 8058 one-click). */
function confirmationMail(origin: string, email: string, t: { confirmToken: string; unsubscribeToken: string }): Mail {
  const confirmUrl = `${origin}/api/blog/confirm?token=${t.confirmToken}`, unsubscribeUrl = `${origin}/api/blog/unsubscribe?token=${t.unsubscribeToken}`;
  return {
    to: email,
    subject: "Confirm your signup to the Muster Town blog",
    text: `Someone, hopefully you, asked for new posts from the Muster Town blog (${origin}/blog) to be sent to ${email}.\n\nConfirm with this link:\n${confirmUrl}\n\nIf it wasn't you, ignore this email: you won't hear from us again.\n\nUnsubscribe: ${unsubscribeUrl}\n`,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function plainPage(title: string, text: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · Muster Town</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#0b5cad}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/blog">The Muster Town blog</a></p></body></html>
`;
}

/** In-memory sliding window per key: `hit` is false once the key has `limit` hits in the last hour. */
class RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: () => number) {}
  hit(key: string): boolean {
    const t = this.now(), recent = (this.hits.get(key) ?? []).filter((x) => t - x < HOUR_MS);
    if (this.hits.size > 10_000) this.hits.clear();
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * `clientIpHeader`: the header the client IP comes from (`fly-client-ip` behind Fly's proxy); else the socket address.
 * `origin`: this town's public URL, for the links in emails. `mail`: the sender (default: off).
 */
export function mailingListRoutes(opts: { clientIpHeader?: string | null; now?: () => number; origin?: string; mail?: MailSender } = {}) {
  const now = opts.now ?? Date.now;
  const origin = opts.origin ?? "https://muster.town";
  const mail = opts.mail ?? null;
  const limit = new RateLimit(PER_HOUR, now);
  const header = opts.clientIpHeader?.toLowerCase() ?? null;
  const clientIp = (req: FastifyRequest): string => {
    const h = header ? req.headers[header] : undefined;
    return (Array.isArray(h) ? h[0] : h)?.trim() || req.ip;
  };
  return async (app: FastifyInstance) => {
    const list = new MailingList(app.world, now);
    // a mail client's one-click unsubscribe POSTs "List-Unsubscribe=One-Click" as a form (RFC 8058); the token is in the URL
    app.addContentTypeParser(["application/x-www-form-urlencoded", "multipart/form-data"], { parseAs: "string" }, (_req, body, done) => done(null, body));
    app.post("/api/blog/subscribe", async (req) => {
      if (!limit.hit(clientIp(req))) throw new AppError("rate_limited", "Too many signups from here: try again in an hour.");
      const input = parse(SubscribeInput, req.body);
      const confirm = mail?.enabled === true;
      if (input.website) return confirm ? { ok: true, confirm: true } : { ok: true };
      const email = normalizeEmail(input.email);
      if (!email) throw new AppError("bad_request", "That doesn't look like an email address.");
      const tokens = list.add(email, input.source ?? "index", confirm);
      if (!confirm) return { ok: true };
      if (tokens) {
        try { await mail.send(confirmationMail(origin, email, tokens)); } catch (err) {
          req.log.warn({ err: (err as Error).message }, "[mailing-list] confirmation email not sent");
          throw new AppError("internal", "We couldn't send the confirmation email. Try again in a minute.");
        }
      }
      return { ok: true, confirm: true };
    });
    app.get<{ Querystring: { token?: string } }>("/api/blog/confirm", async (req, reply) => {
      const token = req.query.token ?? "";
      const ok = TOKEN.test(token) && list.confirm(token);
      return reply.code(ok ? 200 : 404).type("text/html; charset=utf-8").header("cache-control", "no-store").send(ok
        ? plainPage("You're in", "You'll get an email when there's a new post on the Muster Town blog. Every email has a link to unsubscribe.")
        : plainPage("That link didn't work", "It was already used or it isn't valid. If you confirmed before, you're already on the list."));
    });
    const unsubscribe = async (req: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
      const token = req.query.token ?? "";
      const ok = TOKEN.test(token) && list.unsubscribe(token);
      return reply.code(ok ? 200 : 404).type("text/html; charset=utf-8").header("cache-control", "no-store").send(ok
        ? plainPage("You're unsubscribed", "You won't get any more emails from the Muster Town blog.")
        : plainPage("That link didn't work", "It isn't a valid unsubscribe link."));
    };
    app.get("/api/blog/unsubscribe", unsubscribe);
    app.post("/api/blog/unsubscribe", unsubscribe);
    app.get<{ Querystring: { format?: string } }>("/api/blog/subscribers", async (req, reply) => {
      const user = requireUser(req);
      app.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of this town can read the mailing list.");
      const subscribers = list.list();
      if (req.query.format === "csv") {
        const rows = ["email,createdAt,source,confirmed", ...subscribers.map((s) => [s.email, s.createdAt, s.source, s.confirmed ? "yes" : "no"].map(csvCell).join(","))];
        return reply.type("text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="muster-town-blog-subscribers.csv"').send(rows.join("\n") + "\n");
      }
      return { count: subscribers.length, confirmed: subscribers.filter((s) => s.confirmed).length, subscribers };
    });
  };
}
