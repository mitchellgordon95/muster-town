import type { World } from "@muster-town/core";

/**
 * Public uptime (grant gr_rcj8nkbkbt, then gr_hbz0twkfp9). Table uptime_probes (migration 108) holds one row per probed
 * minute per source; nothing writes it any more (the probe API is gone: UptimeRobot measures muster.town, and the next
 * step reads it here). A minute with no probe is `unknown`, never up. Restart gaps come from the server's own events:
 * the last event before each "Server started" boot marker (capacity.ts markBoot) to that marker.
 */
const DAY_MS = 24 * 3600_000;
const MIN_MS = 60_000;
const UPTIME_DAYS = 30;
/** a run of failed minutes this long or longer is an outage */
const OUTAGE_MIN_MINUTES = 2;
/** unknown minutes inside a run of failed ones that still join it (a late or skipped timer tick) */
const OUTAGE_JOIN_GAP = 1;

interface UptimeDay { date: string; up: number; down: number; unknown: number; pct: number | null }
interface Outage { from: string; to: string; minutes: number }
interface RestartGap { from: string; to: string; seconds: number; kind: "redeploy" | "unclean" }
interface UptimeSummary {
  at: string;
  days: number;
  /** up / (up + down) over the window, one decimal; null before any probe */
  pct: number | null;
  /** (up + down) / every minute of the window so far: how much of it the probes saw */
  coverage: number;
  up: number; down: number; unknown: number;
  sources: string[];
  lastProbeAt: string | null;
  byDay: UptimeDay[];
  outages: Outage[];
  restarts: RestartGap[];
}

const minuteKey = (ms: number) => new Date(Math.floor(ms / MIN_MS) * MIN_MS).toISOString().slice(0, 16);
const keyMs = (key: string) => Date.parse(`${key}:00.000Z`);
const round1 = (x: number) => Math.round(x * 10) / 10;

export class Uptime {
  constructor(private readonly world: World, private readonly o: { now?: () => number } = {}) {}
  private now(): number { return this.o.now?.() ?? Date.now(); }

  summary(days = UPTIME_DAYS): UptimeSummary {
    const now = this.now();
    const today0 = Math.floor(now / DAY_MS) * DAY_MS;
    const start = today0 - (days - 1) * DAY_MS;
    const nowMinute = keyMs(minuteKey(now));
    const rows = this.world.db.prepare("SELECT minute, source, ok FROM uptime_probes WHERE minute >= ? ORDER BY minute")
      .all(minuteKey(start)) as { minute: string; source: string; ok: number }[];
    // one state per minute: down if any source saw it fail, up only when every probe of that minute said ok
    const state = new Map<string, boolean>();
    const sources = new Set<string>();
    for (const r of rows) {
      sources.add(r.source);
      state.set(r.minute, (state.get(r.minute) ?? true) && r.ok === 1);
    }
    const counts = new Map<number, { up: number; down: number }>();
    for (const [k, ok] of state) {
      const t = keyMs(k);
      if (t > nowMinute) continue;
      const day = Math.floor(t / DAY_MS) * DAY_MS;
      const c = counts.get(day) ?? { up: 0, down: 0 };
      if (ok) c.up++; else c.down++;
      counts.set(day, c);
    }
    const byDay: UptimeDay[] = [];
    for (let d = start; d <= today0; d += DAY_MS) {
      const minutes = Math.max(0, Math.min(1440, Math.floor((nowMinute - d) / MIN_MS) + 1));
      const { up, down } = counts.get(d) ?? { up: 0, down: 0 };
      byDay.push({ date: new Date(d).toISOString().slice(0, 10), up, down, unknown: Math.max(0, minutes - up - down), pct: up + down ? round1((100 * up) / (up + down)) : null });
    }
    const up = byDay.reduce((s, d) => s + d.up, 0), down = byDay.reduce((s, d) => s + d.down, 0), unknown = byDay.reduce((s, d) => s + d.unknown, 0);
    return {
      at: new Date(now).toISOString(),
      days,
      pct: up + down ? round1((100 * up) / (up + down)) : null,
      coverage: up + down + unknown ? round1((100 * (up + down)) / (up + down + unknown)) : 0,
      up, down, unknown,
      sources: [...sources].sort(),
      lastProbeAt: rows.length ? `${rows[rows.length - 1].minute}:00.000Z` : null,
      byDay,
      outages: outagesOf(state),
      restarts: this.restarts(start),
    };
  }

  /** Each boot marker since `from`: the gap from the server's last event before it (its last sign of life) to the boot. */
  private restarts(from: number): RestartGap[] {
    const boots = this.world.db.prepare("SELECT id, ts FROM events WHERE type = 'system' AND ts >= ? AND json_extract(payload, '$.boot') IS NOT NULL ORDER BY id")
      .all(new Date(from).toISOString()) as { id: number; ts: string }[];
    const before = this.world.db.prepare("SELECT ts, payload FROM events WHERE id < ? ORDER BY id DESC LIMIT 20");
    const out: RestartGap[] = [];
    for (const b of boots) {
      const prev = before.all(b.id) as { ts: string; payload: string }[];
      if (!prev.length) continue;
      const last = Date.parse(prev[0].ts), boot = Date.parse(b.ts);
      const redeploy = prev.some((e) => {
        if (Date.parse(e.ts) < last - 10 * MIN_MS) return false;
        const p = JSON.parse(e.payload || "{}") as { redeploy?: boolean; run?: { state?: string } };
        return !!p.redeploy && p.run?.state === "restarting";
      });
      out.push({ from: prev[0].ts, to: b.ts, seconds: Math.max(0, Math.round((boot - last) / 1000)), kind: redeploy ? "redeploy" : "unclean" });
    }
    return out;
  }
}

/** Runs of failed minutes (≥ OUTAGE_MIN_MINUTES), joined across at most OUTAGE_JOIN_GAP unknown minutes; `to` is the end of the last failed minute. */
export function outagesOf(state: Map<string, boolean>): Outage[] {
  const down = [...state].filter(([, ok]) => !ok).map(([k]) => keyMs(k)).sort((a, b) => a - b);
  const out: Outage[] = [];
  let first = -1, last = -1, count = 0;
  const flush = () => {
    if (count >= OUTAGE_MIN_MINUTES) out.push({ from: new Date(first).toISOString(), to: new Date(last + MIN_MS).toISOString(), minutes: Math.round((last + MIN_MS - first) / MIN_MS) });
  };
  for (const t of down) {
    // an up minute between two failed ones always splits them
    const gap = (t - last) / MIN_MS - 1;
    const upBetween = count > 0 && gap > 0 && [...Array(gap).keys()].some((i) => state.get(minuteKey(last + (i + 1) * MIN_MS)) === true);
    if (count > 0 && gap <= OUTAGE_JOIN_GAP && !upBetween) { last = t; count++; continue; }
    flush();
    first = last = t; count = 1;
  }
  flush();
  return out;
}
