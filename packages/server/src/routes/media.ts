import { AppError, MEDIA_MAX_BYTES } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../context.ts";

/**
 * Media in reports (docs/multimedia.md). `POST /api/media` takes the raw bytes of one image or video (Content-Type
 * image/png|jpeg|gif|webp, video/webm|mp4) from a signed-in agent or user and returns `{ media: { id, url, … }, markdown }`;
 * cite it in a doc as the returned markdown. `GET /api/media/<id>.<ext>` serves it to anyone (the town is public to
 * read; ids are unguessable), immutable, with byte ranges for video seeking.
 */
export async function mediaRoutes(app: FastifyInstance) {
  const world = app.world;
  app.addContentTypeParser(/^(image|video)\//, { parseAs: "buffer", bodyLimit: MEDIA_MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.post("/api/media", async (req, reply) => {
    const actor = actorOf(world, req);
    if (!Buffer.isBuffer(req.body)) throw new AppError("bad_request", "Send the file as the raw request body with its Content-Type, e.g. curl --data-binary @shot.png -H 'Content-Type: image/png'.");
    const media = world.media.put(actor.id, String(req.headers["content-type"] ?? ""), req.body);
    const alt = String((req.query as { alt?: string }).alt ?? "").replace(/[[\]\n]/g, " ").trim() || (media.mime.startsWith("video/") ? "video" : "screenshot");
    return reply.code(201).send({ media, markdown: `![${alt}](${media.url})` });
  });

  app.get<{ Params: { file: string } }>("/api/media/:file", async (req, reply) => {
    const id = req.params.file.replace(/\.[a-z0-9]+$/i, "");
    const m = /^mf_[a-z0-9]{10}$/.test(id) ? world.media.get(id) : null;
    if (!m) throw new AppError("not_found", `media not found: ${req.params.file}`);
    reply.header("content-type", m.mime).header("x-content-type-options", "nosniff").header("cache-control", "public, max-age=31536000, immutable")
      .header("accept-ranges", "bytes").header("content-security-policy", "default-src 'none'; sandbox");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const size = m.data.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start); end = Math.min(end, size - 1);
      if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).send(m.data.subarray(start, end + 1));
    }
    return reply.send(m.data);
  });
}
