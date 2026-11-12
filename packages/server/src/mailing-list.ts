import { AppError, type World } from "@muster-town/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, requireUser } from "./context.ts";

/**
 * The blog's mailing list (Mitchell, mt_msnjkpgwdb decision 7): the form at the foot of every blog page (blog.ts) posts
 * here. Root app only. `POST /api/blog/subscribe {email, source?, website?}` is public: a repeat answers ok like the first
 * time, the honeypot `website` (hidden from people) drops bots silently, and each client IP may post 10 times an hour.
 * `GET /api/blog/subscribers[?format=csv]` is for admins. No confirmation email: the town has no mail sender.
 */
const PER_HOUR = 10;
const HOUR_MS = 3600_000;

export const SubscribeInput = z.object({
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

export interface Subscriber { email: string; createdAt: string; source: string }

export class MailingList {
  constructor(private readonly world: World, private readonly now: () => number = Date.now) {}

  /** Add an address (already normalized); a repeat is ignored. True when it is new. */
  add(email: string, source: string): boolean {
    const r = this.world.db.prepare("INSERT OR IGNORE INTO mailing_list (email, createdAt, source) VALUES (?, ?, ?)")
      .run(email, new Date(this.now()).toISOString(), SOURCE.test(source) ? source : "index");
    return r.changes > 0;
  }

  /** The subscribed addresses, oldest first. */
  list(): Subscriber[] {
    return this.world.db.prepare("SELECT email, createdAt, source FROM mailing_list WHERE unsubscribedAt IS NULL ORDER BY createdAt, email").all() as Subscriber[];
  }

  count(): number {
    return (this.world.db.prepare("SELECT COUNT(*) AS n FROM mailing_list WHERE unsubscribedAt IS NULL").get() as { n: number }).n;
  }
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

/** `clientIpHeader`: the header the client IP comes from (`fly-client-ip` behind Fly's proxy); else the socket address. */
export function mailingListRoutes(opts: { clientIpHeader?: string | null; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const limit = new RateLimit(PER_HOUR, now);
  const header = opts.clientIpHeader?.toLowerCase() ?? null;
  const clientIp = (req: FastifyRequest): string => {
    const h = header ? req.headers[header] : undefined;
    return (Array.isArray(h) ? h[0] : h)?.trim() || req.ip;
  };
  return async (app: FastifyInstance) => {
    const list = new MailingList(app.world, now);
    app.post("/api/blog/subscribe", async (req) => {
      if (!limit.hit(clientIp(req))) throw new AppError("rate_limited", "Too many signups from here: try again in an hour.");
      const input = parse(SubscribeInput, req.body);
      if (input.website) return { ok: true };
      const email = normalizeEmail(input.email);
      if (!email) throw new AppError("bad_request", "That doesn't look like an email address.");
      list.add(email, input.source ?? "index");
      return { ok: true };
    });
    app.get<{ Querystring: { format?: string } }>("/api/blog/subscribers", async (req, reply) => {
      const user = requireUser(req);
      app.world.permissions.requireAdmin({ kind: "user", id: user.id }, "Only an admin of this town can read the mailing list.");
      const subscribers = list.list();
      if (req.query.format === "csv") {
        const rows = ["email,createdAt,source", ...subscribers.map((s) => [s.email, s.createdAt, s.source].map(csvCell).join(","))];
        return reply.type("text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="muster-town-blog-subscribers.csv"').send(rows.join("\n") + "\n");
      }
      return { count: subscribers.length, subscribers };
    });
  };
}
