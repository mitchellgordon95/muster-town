import { DirectoryList } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse } from "../context.ts";
import type { Directory } from "../directory/index.ts";

const RegisterInput = z.object({ host: z.string().max(300) });

/**
 * The self-hosted towns directory (design dc_d6chojzl2a), root app only and only where MUSTER_TOWN_DIRECTORY=on:
 * `POST /api/directory/register {host}` (no account, no approval) → 201 new / 200 existing with the token and how to
 * prove it; `GET /api/directory` → `{towns: DirectoryTown[]}`, public and cached.
 */
export function directoryRoutes(directory: Directory) {
  const clientIp = (req: FastifyRequest): string => {
    const h = directory.clientIpHeader ? req.headers[directory.clientIpHeader] : undefined;
    return (Array.isArray(h) ? h[0] : h)?.trim() || req.ip;
  };
  return async (app: FastifyInstance) => {
    app.post("/api/directory/register", async (req, reply) => {
      const { host } = parse(RegisterInput, req.body);
      const r = directory.register(host, clientIp(req));
      return reply.code(r.created ? 201 : 200).send(r.registration);
    });
    app.get("/api/directory", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return DirectoryList.parse({ towns: directory.list() });
    });
  };
}
