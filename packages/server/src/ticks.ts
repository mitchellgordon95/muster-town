/**
 * Hosted collectives' ticks (post-mortem 2026-10-31 item 8): every hosted World's runtime used to run its own 5 s timer
 * in this one process, all firing together. Their runtimes now start with no timer (`intervalMs: 0`) and this rotation
 * ticks them round-robin from one timer: with N worlds it fires every interval / N, one world per fire, so each world
 * still ticks every interval and no two tick at once. Past `cap` worlds it fires every interval / cap: each world then
 * ticks every interval × N / cap (less often) and the host never runs more than `cap` hosted ticks per interval. Over
 * the cap is logged once (again only after it has gone back under).
 */

/** Hosted worlds ticked at full rate before they slow down (env MUSTER_TOWN_HOSTED_TICK_CAP). */
export const HOSTED_TICK_CAP = 10;
/** A hosted runtime's tick period at or under the cap, as the Workshop's (runtime default 5000). */
const HOSTED_TICK_MS = 5000;

/** The cap from its setting: a positive integer, else the default. */
export function hostedTickCap(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : HOSTED_TICK_CAP;
}

interface TickRotationOptions {
  intervalMs?: number;
  cap?: number;
  log?: (line: string) => void;
  /** tests inject a fake timer */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class TickRotation {
  readonly intervalMs: number;
  readonly cap: number;
  private worlds = new Map<string, () => Promise<unknown> | unknown>();
  private order: string[] = [];
  private next = 0;
  private timer: unknown = null;
  private warnedOver = false;
  private running = new Set<string>();
  private log: (line: string) => void;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;

  constructor(o: TickRotationOptions = {}) {
    this.intervalMs = o.intervalMs ?? HOSTED_TICK_MS;
    this.cap = o.cap ?? HOSTED_TICK_CAP;
    this.log = o.log ?? ((l) => console.warn(l));
    this.setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get count(): number { return this.order.length; }

  /** Time between two fires (one world each): interval / min(worlds, cap). */
  slotMs(): number { return Math.max(1, Math.floor(this.intervalMs / Math.max(1, Math.min(this.order.length, this.cap)))); }

  /** How often each world ticks now (ms). */
  periodMs(): number { return this.slotMs() * Math.max(1, this.order.length); }

  /** Add a hosted world's tick (replaces one under the same slug). */
  add(slug: string, tick: () => Promise<unknown> | unknown): void {
    if (!this.worlds.has(slug)) this.order.push(slug);
    this.worlds.set(slug, tick);
    this.checkCap();
    this.stop(); this.arm(); // the slot shrank: the next fire comes interval / N after this
  }

  /** Drop a world (its runtime closed). */
  remove(slug: string): void {
    if (!this.worlds.delete(slug)) return;
    const i = this.order.indexOf(slug);
    this.order.splice(i, 1);
    if (i < this.next) this.next--;
    this.checkCap();
    this.stop();
    if (this.order.length) this.arm();
  }

  stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** One fire: tick the next world in the rotation (skipped while its previous tick is still running). */
  fire(): void {
    if (!this.order.length) return;
    if (this.next >= this.order.length) this.next = 0;
    const slug = this.order[this.next]!;
    this.next = (this.next + 1) % this.order.length;
    if (this.running.has(slug)) return;
    const tick = this.worlds.get(slug)!;
    this.running.add(slug);
    Promise.resolve().then(tick)
      .catch((e) => this.log(`[hosted] /${slug}/ tick failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.running.delete(slug));
  }

  private arm(): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.fire();
      if (this.order.length) this.arm();
    }, this.slotMs());
  }

  private checkCap(): void {
    const over = this.order.length > this.cap;
    if (over && !this.warnedOver) {
      this.log(`[hosted] ${this.order.length} hosted collectives, over the tick cap of ${this.cap}: each ticks every ${Math.round(this.periodMs() / 100) / 10} s instead of every ${this.intervalMs / 1000} s (MUSTER_TOWN_HOSTED_TICK_CAP)`);
    }
    this.warnedOver = over;
  }
}
