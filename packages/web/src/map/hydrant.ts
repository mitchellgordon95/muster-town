/**
 * The Town Hall's hydrant (docs/legible-delegation.md §3, UI / UX A): the stream the humans process, pouring from a
 * Town Hall object; clicking it opens the decision queue (DecisionQueue.tsx). Asks pour as water-blue dots and settle at the
 * Secretary beside it. The counts come from the Town Hall's waiting items (GET
 * /api/buildings/<hall>/intray), fetched once on load and again when their count changes (WS `building`); no new
 * polling, no new endpoint. Bodies are free: the particles are a few dots on the existing frame.
 */
import type { Notice } from "@muster-town/schema";
import { api, type Intray } from "../api";
import { openAskCount } from "../panels/asks";

interface HydrantCounts {
  /** asks waiting on a human (deferred ones wait on an event) */
  asks: number;
  /** notices filed since local midnight */
  noticesToday: number;
  /** the last ranking, as the newest money slate's time (the run files one when it ranks money asks); null = none seen */
  rankedAt: string | null;
}

/** The hydrant's numbers from the Town Hall's waiting-items read. */
export function hydrantCounts(t: Pick<Intray, "asks" | "notices"> | null | undefined, now = new Date()): HydrantCounts {
  const notices: Notice[] = t?.notices ?? [];
  const today = now.toDateString();
  const slate = notices.filter((n) => n.kind === "slate").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    asks: openAskCount(t?.asks ?? []),
    noticesToday: notices.filter((n) => new Date(n.createdAt).toDateString() === today).length,
    rankedAt: slate?.createdAt ?? null,
  };
}

/** At most this many dots on screen. */
export const MAX_PARTICLES = 12;
/** seconds for one dot to travel from the hydrant to where it lands */
const PERIOD = 2.6;

interface Pt { x: number; y: number }

/**
 * The water this frame, in world px: one dot per open ask flying from the hydrant's spout to the Secretary on a low arc,
 * easing out so it settles, staggered so the dots don't clump. Capped at MAX_PARTICLES; none under reduced motion or
 * without a target. (Notices used to drift to the feed as a second stream; it read as a straight jet beside the arc, so
 * there is one stream now: Mitchell, 1:1 mt_db6itzy2br.)
 */
export function streamParticles(from: Pt, to: Pt | null, counts: Pick<HydrantCounts, "asks">, nowMs: number, reducedMotion: boolean): Pt[] {
  if (reducedMotion || !to) return [];
  const n = Math.min(counts.asks, MAX_PARTICLES);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (nowMs / 1000 / PERIOD + i / n) % 1;
    const e = 1 - (1 - t) * (1 - t);
    out.push({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e - Math.sin(Math.PI * e) * 6 });
  }
  return out;
}

let motionQuery: MediaQueryList | null | undefined;
/** Whether the viewer asked for less motion (no particles then); the media query is made once and read live. */
export function prefersReducedMotion(): boolean {
  if (motionQuery === undefined) {
    try { motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null; } catch { motionQuery = null; }
  }
  return !!motionQuery?.matches;
}

/**
 * The renderer's copy of the counts: `sync` fetches the Town Hall's waiting items when the hall or their count changes
 * (once on load, then on the WS `building` bump the decision queue also refetches on).
 */
export class HydrantStream {
  counts: HydrantCounts = { asks: 0, noticesToday: 0, rankedAt: null };
  private key: string | null = null;
  sync(hallId: string | null | undefined, intray: number | undefined): void {
    if (!hallId) return;
    const key = `${hallId}:${intray ?? 0}`;
    if (key === this.key) return;
    this.key = key;
    api().intray(hallId).then((t) => { if (this.key === key) this.counts = hydrantCounts(t); }).catch(() => { /* the stream stays as it was */ });
  }
}
