import type { World } from "@muster-town/core";

/**
 * Public uptime (grant gr_hbz0twkfp9): UptimeRobot's free plan measures muster.town (one HTTP(s) monitor on /api/health,
 * every 5 min). This reads its legacy API `getMonitors` with the read-only key in the collective secret
 * UPTIMEROBOT_API_KEY: 30 one-day ratios plus a 30-day total, and the monitor's down logs as outages. The answer is kept
 * 5 minutes (the free plan allows 10 requests a minute; one every 5 minutes is far under). With no key, or when the API
 * fails, there is no number (pct null, source "unknown"); the restart gaps still show. They come from the server's own
 * events: the last event before each "Server started" boot marker (capacity.ts markBoot) to that marker.
 * UPTIMEROBOT_STATUS_URL is the public status page the block links. Never log either secret's value.
 */
const DAY_MS = 24 * 3600_000;
const MIN_MS = 60_000;
const UPTIME_DAYS = 30;
const CACHE_MS = 5 * MIN_MS;
/** a failed read is retried sooner than a good one is refreshed */
const FAIL_CACHE_MS = MIN_MS;
const FETCH_TIMEOUT_MS = 10_000;
const API_URL = "https://api.uptimerobot.com/v2/getMonitors";
const KEY_SECRET = "UPTIMEROBOT_API_KEY";
const STATUS_URL_SECRET = "UPTIMEROBOT_STATUS_URL";

interface UptimeDay { date: string; up: number; down: number; unknown: number; pct: number | null }
interface Outage { from: string; to: string; minutes: number }
interface RestartGap { from: string; to: string; seconds: number; kind: "redeploy" | "unclean" }
interface UptimeSummary {
  at: string;
  days: number;
  /** UptimeRobot's ratio over the window, two decimals as its status page shows; null when there is no reading */
  pct: number | null;
  /** how much of the window the monitor existed for, % */
  coverage: number;
  /** minutes derived from each day's ratio; a day before the monitor existed is all unknown */
  up: number; down: number; unknown: number;
  source: "uptimerobot" | "unknown";
  sources: string[];
  /** the public status page (UPTIMEROBOT_STATUS_URL), null when unset */
  statusUrl: string | null;
  /** when the server last read UptimeRobot successfully */
  lastProbeAt: string | null;
  /** why there is no number (no key, API error), null when there is one */
  error: string | null;
  byDay: UptimeDay[];
  outages: Outage[];
  restarts: RestartGap[];
}

interface RobotMonitor {
  url?: string;
  create_datetime?: number;
  custom_uptime_ranges?: string;
  logs?: { type: number; datetime: number; duration: number }[];
}
interface Reading { at: number; monitor: RobotMonitor | null; error: string | null }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();

export class Uptime {
  private cache: { until: number; reading: Reading } | null = null;
  private inflight: Promise<Reading> | null = null;
  constructor(private readonly world: World, private readonly o: { now?: () => number; fetch?: Fetch } = {}) {}
  private now(): number { return this.o.now?.() ?? Date.now(); }
  private secret(name: string): string | null {
    try { return this.world.secrets.value(name)?.trim() || null; } catch { return null; }
  }

  async summary(days = UPTIME_DAYS): Promise<UptimeSummary> {
    const now = this.now();
    const today0 = Math.floor(now / DAY_MS) * DAY_MS;
    const start = today0 - (days - 1) * DAY_MS;
    const r = await this.reading(start, today0, now);
    const m = r.monitor;
    const ratios = (m?.custom_uptime_ranges ?? "").split("-").map((s) => Number.parseFloat(s));
    const created = m?.create_datetime ? m.create_datetime * 1000 : start;
    const byDay: UptimeDay[] = [];
    for (let i = 0, d = start; d <= today0; i++, d += DAY_MS) {
      const minutes = Math.max(0, Math.min(1440, Math.floor((Math.min(now, d + DAY_MS) - d) / MIN_MS)));
      const measured = m ? Math.max(0, Math.floor((Math.min(now, d + DAY_MS) - Math.max(d, created)) / MIN_MS)) : 0;
      const ratio = ratios[i];
      if (!m || measured === 0 || !Number.isFinite(ratio)) {
        byDay.push({ date: iso(d).slice(0, 10), up: 0, down: 0, unknown: minutes, pct: null });
        continue;
      }
      const down = Math.round((measured * (100 - ratio)) / 100);
      byDay.push({ date: iso(d).slice(0, 10), up: measured - down, down, unknown: Math.max(0, minutes - measured), pct: round2(ratio) });
    }
    const total = ratios[days];
    const up = byDay.reduce((s, d) => s + d.up, 0), down = byDay.reduce((s, d) => s + d.down, 0), unknown = byDay.reduce((s, d) => s + d.unknown, 0);
    const has = !!m && up + down > 0;
    return {
      at: iso(now),
      days,
      pct: has ? round2(Number.isFinite(total) ? total : (100 * up) / (up + down)) : null,
      coverage: up + down + unknown ? round1((100 * (up + down)) / (up + down + unknown)) : 0,
      up, down, unknown,
      source: has ? "uptimerobot" : "unknown",
      sources: has ? ["uptimerobot"] : [],
      statusUrl: this.secret(STATUS_URL_SECRET),
      lastProbeAt: m ? iso(r.at) : null,
      error: r.error,
      byDay,
      outages: has ? outagesOf(m, start) : [],
      restarts: this.restarts(start),
    };
  }

  /** The cached UptimeRobot reading, or a fresh one (one request at a time). */
  private async reading(start: number, today0: number, now: number): Promise<Reading> {
    if (this.cache && now < this.cache.until) return this.cache.reading;
    this.inflight ??= this.read(start, today0, now).finally(() => { this.inflight = null; });
    const reading = await this.inflight;
    this.cache = { until: now + (reading.monitor ? CACHE_MS : FAIL_CACHE_MS), reading };
    return reading;
  }

  private async read(start: number, today0: number, now: number): Promise<Reading> {
    const key = this.secret(KEY_SECRET);
    if (!key) return { at: now, monitor: null, error: `no ${KEY_SECRET} secret` };
    const sec = (ms: number) => Math.floor(ms / 1000);
    const ranges: string[] = [];
    for (let d = start; d <= today0; d += DAY_MS) ranges.push(`${sec(d)}_${sec(Math.min(now, d + DAY_MS))}`);
    ranges.push(`${sec(start)}_${sec(now)}`);
    const body = new URLSearchParams({ api_key: key, format: "json", custom_uptime_ranges: ranges.join("-"), logs: "1", logs_limit: "50" });
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    try {
      const res = await f(API_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
        body: body.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { at: now, monitor: null, error: `UptimeRobot answered HTTP ${res.status}` };
      const j = (await res.json()) as { stat?: string; error?: { type?: string; message?: string }; monitors?: RobotMonitor[] };
      if (j.stat !== "ok") return { at: now, monitor: null, error: `UptimeRobot: ${j.error?.message ?? j.error?.type ?? "stat not ok"}` };
      const mons = j.monitors ?? [];
      const monitor = mons.find((x) => x.url?.includes("/api/health")) ?? mons[0] ?? null;
      return { at: now, monitor, error: monitor ? null : "UptimeRobot: no monitor on this account" };
    } catch (e) {
      return { at: now, monitor: null, error: `UptimeRobot unreachable: ${(e as Error).name}` };
    }
  }

  /** Each boot marker since `from`: the gap from the server's last event before it (its last sign of life) to the boot. */
  private restarts(from: number): RestartGap[] {
    const boots = this.world.db.prepare("SELECT id, ts FROM events WHERE type = 'system' AND ts >= ? AND json_extract(payload, '$.boot') IS NOT NULL ORDER BY id")
      .all(iso(from)) as { id: number; ts: string }[];
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

/** The monitor's down logs (type 1) since `from`, oldest first; a log's duration is in seconds. */
function outagesOf(m: RobotMonitor, from: number): Outage[] {
  return (m.logs ?? [])
    .filter((l) => l.type === 1 && (l.datetime + l.duration) * 1000 >= from)
    .map((l) => ({ from: iso(l.datetime * 1000), to: iso((l.datetime + l.duration) * 1000), minutes: Math.max(1, Math.round(l.duration / 60)) }))
    .sort((a, b) => a.from.localeCompare(b.from));
}
