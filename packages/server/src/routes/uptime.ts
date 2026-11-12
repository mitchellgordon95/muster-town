import type { FastifyInstance } from "fastify";
import type { Uptime } from "../uptime.ts";

/**
 * Public uptime, root app only: `GET /api/uptime` is public, no sign-in: 30 days of up/down/unknown minutes per UTC day,
 * the outages and the restart gaps (uptime.ts `UptimeSummary`). No town agent posts probes any more (gr_hbz0twkfp9:
 * UptimeRobot measures it; until the server reads UptimeRobot, the minutes are all unknown and only restart gaps show).
 */
export function uptimeRoutes(uptime: Uptime) {
  return async (app: FastifyInstance) => {
    app.get("/api/uptime", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return uptime.summary();
    });
  };
}
