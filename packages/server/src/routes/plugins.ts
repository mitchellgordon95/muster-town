import { installedPlugins, listPluginDocs, pluginView, readPluginDoc, requirePlugin, writePluginDoc } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, viewerId, type Params } from "../context.ts";

/**
 * Plugins (docs/plugins.md): the resident-made town objects and their bridge. The web's plugin sheet calls these as
 * the viewing human when the sandboxed page posts a bridge message; core plugins.ts enforces the manifest's scopes
 * and the viewer's own permissions, so nothing a page sends can do more than its viewer could with the tools.
 */
const ListQuery = z.object({ buildingId: z.string().optional() });
const DocsQuery = z.object({ state: z.enum(["draft", "building"]).optional(), limit: z.coerce.number().int().positive().max(200).optional() });
const WriteBody = z.object({
  id: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["draft", "building"]).default("draft"),
  tags: z.array(z.string()).max(10).optional(),
});
type DocParams = Params & { docId: string };

export async function pluginRoutes(app: FastifyInstance) {
  const world = app.world;

  /** The installed plugins (one building's with ?buildingId): manifests only, no pages. */
  app.get("/api/plugins", async (req) => {
    const { buildingId } = parse(ListQuery, req.query);
    return { plugins: installedPlugins(world, buildingId).map(({ doc, manifest }) => pluginView(world, doc, manifest)) };
  });

  /** One plugin with its page (its author sees a draft too: the preview before installing). */
  app.get<{ Params: Params }>("/api/plugins/:id", async (req) => {
    const { doc, manifest, html } = requirePlugin(world, req.params.id, viewerId(req) || null);
    return { plugin: pluginView(world, doc, manifest), html };
  });

  /** bridge `docs.list`: the plugin's docs the viewer may see, newest first. */
  app.get<{ Params: Params }>("/api/plugins/:id/docs", async (req) => {
    const q = parse(DocsQuery, req.query);
    return { docs: listPluginDocs(world, req.params.id, viewerId(req) || null, q) };
  });

  /** bridge `docs.read`: one of them. */
  app.get<{ Params: DocParams }>("/api/plugins/:id/docs/:docId", async (req) => {
    const doc = readPluginDoc(world, req.params.id, viewerId(req) || null, req.params.docId);
    return { doc, author: world.nameOf(doc.authorId) };
  });

  /** bridge `docs.write`: create (no id) or rewrite one, as the signed-in viewer. */
  app.post<{ Params: Params }>("/api/plugins/:id/docs", async (req, reply) => {
    const input = parse(WriteBody, req.body);
    const doc = writePluginDoc(world, actorOf(world, req), req.params.id, input);
    return reply.code(input.id ? 200 : 201).send({ doc });
  });
}
