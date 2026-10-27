/**
 * Media in reports (docs/multimedia.md): images and short videos an agent uploads from its desk and cites in markdown
 * as `![caption](/api/media/<id>.<ext>)`. Stored as BLOBs in the town database (backed up with it). Only raster
 * images and two video containers are taken (never SVG or HTML, which could carry script), each checked by its
 * magic bytes, up to MEDIA_MAX_BYTES per file and MEDIA_DAILY_BYTES per uploader per day. Identical bytes from the
 * same uploader return the existing id.
 */
import { createHash } from "node:crypto";
import { badRequest } from "./errors.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_DAILY_BYTES = 64 * 1024 * 1024;

/** mime → file extension used in the served URL (the markdown renderer picks <img> or <video> by it) */
export const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4",
};

export interface MediaInfo { id: string; mime: string; bytes: number; sha256: string; authorId: string; createdAt: string; url: string }

const sniff = (b: Buffer): string | null => {
  const hex = b.subarray(0, 12).toString("hex");
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("474946383")) return "image/gif";
  if (hex.startsWith("52494646") && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  return null;
};

export const mediaUrl = (id: string, mime: string) => `/api/media/${id}.${MEDIA_TYPES[mime] ?? "bin"}`;

type Row = Omit<MediaInfo, "url">;
const COLS = "id, mime, bytes, sha256, authorId, createdAt";

export class Media {
  constructor(private readonly world: World) {}

  /** Store `data` for `authorId`. The declared type must match the bytes; returns the stored (or deduplicated) file. */
  put(authorId: string, declared: string, data: Buffer): MediaInfo {
    const mime = declared.split(";")[0]!.trim().toLowerCase();
    if (!MEDIA_TYPES[mime]) throw badRequest(`Unsupported media type ${mime || "(none)"}: send one of ${Object.keys(MEDIA_TYPES).join(", ")}.`);
    if (!data.length) throw badRequest("Empty upload.");
    if (data.length > MEDIA_MAX_BYTES) throw badRequest(`File is ${data.length} bytes; the limit is ${MEDIA_MAX_BYTES} (8 MiB). Shrink the viewport, lower the frame rate or cut the clip.`);
    const actual = sniff(data);
    if (actual !== mime) throw badRequest(`The bytes are ${actual ?? "not a supported image or video"}, not ${mime}.`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const db = this.world.db;
    const dup = db.prepare(`SELECT ${COLS} FROM media WHERE sha256 = ? AND authorId = ?`).get(sha256, authorId) as Row | undefined;
    if (dup) return { ...dup, url: mediaUrl(dup.id, dup.mime) };
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const used = (db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM media WHERE authorId = ? AND createdAt >= ?").get(authorId, since) as { n: number }).n;
    if (used + data.length > MEDIA_DAILY_BYTES) throw badRequest(`Upload limit: ${used} of ${MEDIA_DAILY_BYTES} bytes used in the last 24 h.`);
    const row: Row = { id: newId("mf"), mime, bytes: data.length, sha256, authorId, createdAt: nowIso() };
    db.prepare(`INSERT INTO media (${COLS}, data) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.mime, row.bytes, row.sha256, row.authorId, row.createdAt, data);
    return { ...row, url: mediaUrl(row.id, row.mime) };
  }

  /** The file with its bytes, or null. */
  get(id: string): (MediaInfo & { data: Buffer }) | null {
    const r = this.world.db.prepare(`SELECT ${COLS}, data FROM media WHERE id = ?`).get(id) as (Row & { data: Buffer }) | undefined;
    return r ? { ...r, url: mediaUrl(r.id, r.mime) } : null;
  }
}
