import type { FastifyInstance } from "fastify";
import { actorOf, parse } from "../context.ts";
import { ProbeBatch, type Uptime } from "../uptime.ts";

/**
 * Public uptime (grant gr_rcj8nkbkbt), root app only: `POST /api/uptime/probes {source?, probes: [{at, ok, ms?}]}` needs
 * `town.uptime` (the pinger's agent, role `prober`) → `{accepted, ignored}`; `GET /api/uptime` is public, no sign-in:
 * 30 days of up/down/unknown minutes per UTC day, the outages and the restart gaps (uptime.ts `UptimeSummary`).
 */
export function uptimeRoutes(uptime: Uptime) {
  return async (app: FastifyInstance) => {
    app.post("/api/uptime/probes", async (req) => {
      req.server.world.permissions.require(actorOf(req.server.world, req), "town.uptime");
      return uptime.ingest(parse(ProbeBatch, req.body));
    });
    app.get("/api/uptime", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return uptime.summary();
    });
  };
}
