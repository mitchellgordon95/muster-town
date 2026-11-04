/**
 * Pictures a human puts in a meeting line (pasted, dropped or attached: `![…](/api/media/mf_….png)` in the text, or a
 * presented screenshot) go to the agent answering it as image blocks in the same message (1:1 mt_z1b38bwg98): a
 * conversation session has no desk and no way to fetch /api/media itself. Raster images only (videos stay links), at
 * most IMAGE_MAX_BYTES each (the API's 5 MB per image, counted on the base64) and IMAGES_PER_MESSAGE per message.
 */
import type { World } from "@muster-town/core";
import type { Meeting } from "@muster-town/schema";

type Line = Pick<Meeting["transcript"][number], "text" | "attachment">;
import type { ImageBlock } from "./sdk.ts";

export const IMAGES_PER_MESSAGE = 4;
/** raw bytes whose base64 stays under the API's 5 MB per image */
export const IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MEDIA_IN_TEXT = /\/api\/media\/(mf_[a-z0-9]{10})\.[a-z0-9]+/g;

/** The media ids a line carries, in order, once each: its markdown, then what it presented. */
export function mediaIdsOf(u: Line): string[] {
  const ids = [...u.text.matchAll(MEDIA_IN_TEXT)].map((m) => m[1]!);
  if (u.attachment?.kind === "media") ids.push(u.attachment.ref);
  return [...new Set(ids)];
}

/**
 * Image blocks for these lines (the last IMAGES_PER_MESSAGE of them), and a note for the text naming any picture the
 * agent can't see (too large, or a video), so it says so instead of guessing.
 */
export function meetingImages(world: World, lines: Line[]): { images: ImageBlock[]; note: string } {
  const images: ImageBlock[] = [];
  const unseen: string[] = [];
  const ids = [...new Set(lines.flatMap(mediaIdsOf))];
  for (const id of ids.slice(-IMAGES_PER_MESSAGE)) {
    const f = world.media.get(id);
    if (!f) continue;
    if (!IMAGE_MIME.has(f.mime)) { unseen.push(`${id} (a video)`); continue; }
    if (f.bytes > IMAGE_MAX_BYTES) { unseen.push(`${id} (${(f.bytes / 1048576).toFixed(1)} MiB, over the 3.7 MiB you can be shown)`); continue; }
    images.push({ type: "image", source: { type: "base64", media_type: f.mime as ImageBlock["source"]["media_type"], data: f.data.toString("base64") } });
  }
  const dropped = ids.length - Math.min(ids.length, IMAGES_PER_MESSAGE);
  const notes = [
    images.length ? `The ${images.length === 1 ? "picture" : `${images.length} pictures`} in ${lines.length === 1 ? "this line" : "these lines"} ${images.length === 1 ? "is" : "are"} attached to this message: look at ${images.length === 1 ? "it" : "them"} before you answer.` : "",
    unseen.length ? `You can't see ${unseen.join(", ")}: say so if it matters.` : "",
    dropped > 0 ? `${dropped} earlier picture${dropped === 1 ? "" : "s"} not attached (only the last ${IMAGES_PER_MESSAGE}).` : "",
  ].filter(Boolean);
  return { images, note: notes.join(" ") };
}
