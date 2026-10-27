/**
 * A small thumbnail on a doc row when the body carries media (docs/multimedia.md): the first image, or a ▶ badge when
 * the first is a video, plus "+n" for the rest, so a human can spot the reports with demos at a glance.
 */
const MEDIA_MD_RE = /!\[([^\]\n]*)\]\(((?:https?:\/\/[^\s)]+)?\/api\/media\/mf_[a-z0-9]{10}\.(png|jpg|gif|webp|webm|mp4))\)/g;

export interface BodyMedia { url: string; alt: string; video: boolean }

/** The town-hosted media a doc body cites, in order. */
export function mediaOf(body: string): BodyMedia[] {
  return [...body.matchAll(MEDIA_MD_RE)].map((m) => ({ alt: m[1]!, url: m[2]!, video: m[3] === "webm" || m[3] === "mp4" }));
}

export function MediaThumb({ body }: { body: string }) {
  const all = mediaOf(body);
  if (!all.length) return null;
  const image = all.find((m) => !m.video);
  const videos = all.filter((m) => m.video).length;
  const title = `${all.length} attachment${all.length === 1 ? "" : "s"}: ${all.map((m) => m.alt || (m.video ? "video" : "image")).join(", ")}`;
  return (
    <span className="media-thumb" title={title}>
      {image ? <img src={image.url} alt="" loading="lazy" /> : <span className="media-thumb-video">▶</span>}
      {image && videos ? <span className="media-thumb-badge">▶</span> : null}
      {all.length > 1 ? <span className="media-thumb-more">+{all.length - 1}</span> : null}
    </span>
  );
}
