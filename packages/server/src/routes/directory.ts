import { DirectoryList } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@muster-town/core";
import { actorOf, parse } from "../context.ts";
import type { Directory } from "../directory/index.ts";

const RegisterInput = z.object({ host: z.string().max(300) });
const RemoveInput = z.object({ reason: z.string().max(500).optional() }).optional();

/**
 * The self-hosted towns directory (design dc_d6chojzl2a), root app only and only where MUSTER_TOWN_DIRECTORY=on:
 * `POST /api/directory/register {host}` (no account, no approval) → 201 new / 200 existing with the token and how to
 * prove it; `POST /api/directory/verify {host}` → one check now `{host, status, proof, verifiedAt, lastSeenAt, lastError}`;
 * `GET /api/directory` → `{towns: DirectoryTown[]}`, public and cached; `DELETE /api/directory/:host {reason}` (admin) removes and blocks.
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
    app.post("/api/directory/verify", async (req) => {
      const { host } = parse(RegisterInput, req.body);
      return directory.verify(host, clientIp(req));
    });
    app.delete<{ Params: { host: string } }>("/api/directory/:host", async (req) => {
      const actor = actorOf(req.server.world, req);
      if (!req.server.world.permissions.isAdmin(actor)) throw new AppError("forbidden", "Only a town admin can remove a town from the directory.");
      const input = parse(RemoveInput, req.body ?? undefined);
      return directory.remove(req.params.host, input?.reason ?? "");
    });
    app.get("/api/directory", async (_req, reply) => {
      reply.header("cache-control", "public, max-age=60");
      return DirectoryList.parse({ towns: directory.list() });
    });
  };
}
