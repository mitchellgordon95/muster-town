import type { FastifyInstance } from "fastify";
import type { Uptime } from "../uptime.ts";

/**
 * Public uptime, root app only: `GET /api/uptime` is public, no sign-in: UptimeRobot's 30 daily ratios and 30-day %,
 * its down logs as outages, the status page link and the server's own restart gaps (uptime.ts `UptimeSummary`,
 * gr_hbz0twkfp9). No town agent measures uptime. With no key or an API error: pct null, source "unknown", still 200.
 */
export function uptimeRoutes(uptime: Uptime) {
  return async (app: FastifyInstance) => {
    app.get("/api/uptime", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return await uptime.summary();
    });
  };
}
