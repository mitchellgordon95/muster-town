/**
 * The Town Hall's hydrant (docs/legible-delegation.md §3, UI / UX A): the stream the humans process, pouring from a
 * Town Hall object beside the in-tray. Asks settle into the in-tray; notices drift to the feed (the Secretary, who files
 * them). The counts come from the Town Hall in-tray, fetched once on load and again when its count changes (WS
 * `building`); no new polling, no new endpoint. Bodies are free: the particles are a few dots on the existing frame.
 */
import type { Notice } from "@muster-town/schema";
import { api, type Intray } from "../api";
import { openAskCount } from "../panels/asks";

export interface HydrantCounts {
  /** asks waiting on a human (deferred ones wait on an event) */
  asks: number;
  /** notices filed since local midnight */
  noticesToday: number;
  /** the last ranking, as the newest money slate's time (the run files one when it ranks money asks); null = none seen */
  rankedAt: string | null;
}

/** The hydrant's three numbers from a Town Hall in-tray read. */
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
interface Particle extends Pt { kind: "ask" | "notice" }

/**
 * The dots this frame, in world px: one per open ask flying to the in-tray (easing out, so they settle) and one per
 * notice of today drifting to the feed (evenly), each on a low arc from the hydrant's spout, staggered so they don't
 * clump. Capped at MAX_PARTICLES; none under reduced motion, and none for a kind with no target.
 */
export function streamParticles(from: Pt, to: { ask: Pt | null; notice: Pt | null }, counts: Pick<HydrantCounts, "asks" | "noticesToday">, nowMs: number, reducedMotion: boolean): Particle[] {
  if (reducedMotion) return [];
  const notices = to.notice ? Math.min(counts.noticesToday, counts.asks && to.ask ? MAX_PARTICLES / 2 : MAX_PARTICLES) : 0;
  const asks = to.ask ? Math.min(counts.asks, MAX_PARTICLES - notices) : 0;
  const out: Particle[] = [];
  const fly = (kind: Particle["kind"], target: Pt, n: number, offset: number) => {
    for (let i = 0; i < n; i++) {
      const t = (nowMs / 1000 / PERIOD + i / n + offset) % 1;
      const e = kind === "ask" ? 1 - (1 - t) * (1 - t) : t;
      out.push({ kind, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e - Math.sin(Math.PI * e) * 6 });
    }
  };
  if (to.ask) fly("ask", to.ask, asks, 0);
  if (to.notice) fly("notice", to.notice, notices, 0.5);
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
 * The renderer's copy of the counts: `sync` fetches the Town Hall in-tray when the hall or its in-tray count changes
 * (once on load, then on the WS `building` bump the in-tray panel also refetches on).
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
