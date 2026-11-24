/**
 * Browser errors (grant gr_cyqzweu6ed step 1): the page posts a panel crash or an uncaught error here (navigator.sendBeacon,
 * at most 10 a page load; web clientErrors.ts) and core client-errors.ts keeps it by kind with the live commit. Guests may
 * post (a crash happens to anyone); at most PER_HOUR posts per client IP an hour, the IP never stored. GET lists the last
 * 24 hours by kind, public, with `newSinceDeploy`: kinds first seen since the running server started.
 */
import { AppError, clientErrorOf, clientErrors, recordClientError, type World } from "@muster-town/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { RateLimit } from "./rate-limit.ts";

const PER_HOUR = 30;

/** `clientIpHeader`: the header the client IP comes from (`fly-client-ip` behind Fly's proxy); else the socket address. */
export function clientErrorRoutes(opts: { world: World; prefix: string; clientIpHeader?: string | null; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const limit = new RateLimit(PER_HOUR, now);
  const header = opts.clientIpHeader?.toLowerCase() ?? null;
  const clientIp = (req: FastifyRequest): string => {
    const h = header ? req.headers[header] : undefined;
    return (Array.isArray(h) ? h[0] : h)?.trim() || req.ip;
  };
  return async (app: FastifyInstance) => {
    app.post(`${opts.prefix}/api/client-errors`, async (req) => {
      if (!limit.hit(clientIp(req))) throw new AppError("rate_limited", "Too many error reports from here: try again in an hour.");
      // sendBeacon posts a string, which arrives as text/plain
      let body: unknown = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
      const report = clientErrorOf(body);
      if (!report) throw new AppError("bad_request", "Send { source: panel | error | rejection, message, stack?, panel?, route? }.");
      const r = recordClientError(opts.world, report, { commit: opts.world.host.commit ?? null, now: now() });
      return { recorded: r.recorded, new: r.isNew };
    });
    app.get(`${opts.prefix}/api/client-errors`, async () => clientErrors(opts.world, { now: now(), deployedAt: opts.world.host.startedAt ?? null }));
  };
}
