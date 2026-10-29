/**
 * In-process monitor (grant gr_rntk0echpi, design dc_f2hpf9u1ya): every 60 s it samples what the server already knows
 * (RSS, event-loop lag p99, data-volume free space, session slots, backup age, the 5xx share, WebSocket errors, failed
 * Claude sessions and the steal share of finished desk sessions), raises and clears alerts with
 * hysteresis, and sends each one down one path: a town event (type `alert`) plus a Prod board FYI (a town-wide one
 * on the Town Hall board when no building is named Prod, e.g. a self-hosted town), and for red ones an
 * SMS (Twilio REST) and an email (Gmail SMTP) when all seven ALERT_* secrets are set, at most 10 outbound messages an hour.
 * State lives in memory plus one `meta` row (key `monitor`), so a restart keeps the open alerts and notices a gap.
 * `GET /api/health` shows `monitor` read-only; never a secret, phone number or address.
 */
import { createDoc, TOWN_HALL_ID, updateDoc, type World } from "@muster-town/core";
import { statfsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { BackupView } from "./backup/index.ts";

export type Level = "yellow" | "red";
export type SendResult = "sent" | "skipped" | "error";

/** One sample of a metric: its value, and whether the yellow / red condition holds right now (before any "for N min"). */
export interface Reading {
  value: number; yellow: boolean; red: boolean;
  /** how many clean observations a reading under yellow counts toward CLEAR_AFTER (default 1; desk-steal: its sessions) */
  clean?: number;
}

/**
 * A metric: a key, a reader (null = no data this sample: nothing changes), and how long each condition must hold
 * before it alerts. A step 2 counter (5xx, ws errors, session failures) plugs in as one more of these.
 */
export interface Metric {
  key: string;
  /** shown in events and FYIs, e.g. "RSS 1700 MB" */
  describe(value: number): string;
  read(now: number): Reading | null;
  yellowForMs: number;
  redForMs: number;
}

export interface AlertView { key: string; level: Level; since: string; value: number }
export interface MonitorView { lastSampleAt: string | null; outbound: boolean; alerts: AlertView[] }

interface OpenAlert extends AlertView { docId: string | null; notifiedAt: number; okCount: number }
interface Persisted { lastSampleAt: string | null; alerts: OpenAlert[]; sent: number[] }

export interface Senders {
  sms(text: string): Promise<void>;
  email(subject: string, text: string): Promise<void>;
}

export const SAMPLE_MS = 60_000;
/** an alert clears after this many consecutive samples under yellow */
export const CLEAR_AFTER = 5;
/** a key that stays red re-alerts at most this often */
export const REALERT_MS = 60 * 60_000;
/** outbound messages (each SMS and each email counts one) per rolling hour, all keys together */
export const OUTBOUND_CAP = 10;
const HOUR_MS = 60 * 60_000;
/** a gap between samples longer than this writes a "monitor gap" event when sampling resumes */
export const GAP_MS = 5 * 60_000;
const MIN = 60_000;
const MB = 1024 * 1024;

export const ALERT_ENV = ["ALERT_TWILIO_SID", "ALERT_TWILIO_AUTH", "ALERT_TWILIO_FROM", "ALERT_SMS_TO", "ALERT_EMAIL_TO", "ALERT_SMTP_USER", "ALERT_SMTP_PASS"] as const;

/** What the default metrics read; tests pass fakes. */
export interface Probes {
  rssBytes(): number;
  /** p99 event-loop delay since the last call (ms) */
  lagP99Ms(): number | null;
  /** free fraction of the data volume (0..1) */
  diskFree(): number | null;
  slots(): { running: number; max: number } | null;
  /** pending assignments not held by a waitFor */
  queueWaiting(): number;
  backup(): BackupView | null;
  /** HTTP responses and how many were 5xx, over the last 5 min (Counters) */
  http(now: number): { total: number; errors: number };
  /** WebSocket errors and abnormal closes over the last 5 min (Counters) */
  wsErrors(now: number): number;
  /** Claude sessions that ended in `error` in the last 15 min, and sessions that ended / of them failed in the last 30 min */
  sessions(now: number): { failed15: number; ended30: number; failed30: number };
  /** finished desk sessions (backend not `host`, wallMs >= 5 min, cpu + steal measured) that ended after `sinceMs`, oldest first */
  deskSessions(sinceMs: number): DeskSession[];
}

/** A finished desk session's steal share: stealMs / (cpuMs + stealMs), 0..1 (desk perf step 1, migration 056). */
export interface DeskSession { id: string; endedAt: number; share: number }
/** desk sessions shorter than this are ignored by `desk-steal` */
export const DESK_MIN_WALL_MS = 5 * MIN;
/** desk-steal thresholds (kr_4pf0n8q9jl step 2): red on one session at RED, or two within an hour at RED2; yellow at YELLOW */
export const DESK_STEAL = { red: 0.5, red2: 0.35, yellow: 0.25 } as const;

/** Bucket width of `Counters`; the windows below are whole buckets. */
const BUCKET_MS = 60_000;
export const COUNT_WINDOW_MS = 5 * MIN;

/**
 * Event counters the HTTP and WebSocket layers bump (app.ts onResponse, ws.ts error / abnormal close): per-minute buckets,
 * the last 5 min kept, so a burst of traffic costs no memory.
 */
export class Counters {
  private buckets = new Map<number, { total: number; errors: number; ws: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** one HTTP response with this status code */
  response(status: number) { const b = this.bucket(); b.total++; if (status >= 500) b.errors++; }
  /** one WebSocket `error`, or a close with a code other than normal / going away / no status */
  wsError() { this.bucket().ws++; }

  http(now: number) { let total = 0, errors = 0; for (const b of this.window(now)) { total += b.total; errors += b.errors; } return { total, errors }; }
  wsErrors(now: number) { let n = 0; for (const b of this.window(now)) n += b.ws; return n; }

  private bucket() {
    const k = Math.floor(this.now() / BUCKET_MS);
    let b = this.buckets.get(k);
    if (!b) {
      b = { total: 0, errors: 0, ws: 0 };
      this.buckets.set(k, b);
      for (const old of this.buckets.keys()) if (old <= k - COUNT_WINDOW_MS / BUCKET_MS) this.buckets.delete(old);
    }
    return b;
  }

  private *window(now: number) {
    const k = Math.floor(now / BUCKET_MS);
    for (const [key, b] of this.buckets) if (key > k - COUNT_WINDOW_MS / BUCKET_MS && key <= k) yield b;
  }
}

/** WebSocket close codes that are not errors: normal, going away (tab closed), no status sent */
export const WS_NORMAL_CLOSE = new Set([1000, 1001, 1005]);

/** The thresholds of dc_f2hpf9u1ya, over `probes`. */
export function defaultMetrics(p: Probes): Metric[] {
  return [
    { key: "rss", describe: (v) => `RSS ${v} MB`, yellowForMs: 5 * MIN, redForMs: 3 * MIN,
      read: () => { const v = Math.round(p.rssBytes() / MB); return { value: v, yellow: v > 1.2 * 1024, red: v > 1.6 * 1024 }; } },
    { key: "lag", describe: (v) => `event-loop lag p99 ${v} ms`, yellowForMs: 5 * MIN, redForMs: 3 * MIN,
      read: () => { const v = p.lagP99Ms(); return v == null ? null : { value: v, yellow: v > 200, red: v > 1000 }; } },
    { key: "disk", describe: (v) => `data volume ${v}% free`, yellowForMs: 0, redForMs: 0,
      read: () => { const f = p.diskFree(); if (f == null) return null; const v = Math.round(f * 1000) / 10; return { value: v, yellow: v < 25, red: v < 10 }; } },
    { key: "slots", describe: (v) => `session slots ${v}% in use`, yellowForMs: 15 * MIN, redForMs: 15 * MIN,
      read: () => {
        const s = p.slots();
        if (!s || s.max <= 0) return null;
        const v = Math.round((s.running / s.max) * 100);
        return { value: v, yellow: v >= 80, red: s.running >= s.max && p.queueWaiting() > 0 };
      } },
    { key: "backup", describe: (v) => `last off-site backup ${v} h ago`, yellowForMs: 0, redForMs: 0,
      read: (now) => {
        const b = p.backup();
        if (!b) return null;
        const ageH = b.lastAt ? Math.round(((now - Date.parse(b.lastAt)) / HOUR_MS) * 10) / 10 : -1;
        return { value: ageH, yellow: b.error != null || ageH > 26, red: ageH > 26 };
      } },
    // the windows are in the counters / the query, so these alert on the sample that crosses
    { key: "5xx", describe: (v) => `${v}% of HTTP responses were 5xx over 5 min`, yellowForMs: 0, redForMs: 0,
      read: (now) => {
        const h = p.http(now);
        if (h.total < 50) return { value: 0, yellow: false, red: false };
        const v = Math.round((h.errors / h.total) * 1000) / 10;
        return { value: v, yellow: v > 2, red: v > 10 };
      } },
    { key: "ws", describe: (v) => `${v} WebSocket errors in 5 min`, yellowForMs: 0, redForMs: 0,
      read: (now) => { const v = p.wsErrors(now); return { value: v, yellow: v > 20, red: v > 100 }; } },
    { key: "sessions", describe: (v) => `${v} Claude sessions failed in 15 min`, yellowForMs: 0, redForMs: 0,
      read: (now) => {
        const s = p.sessions(now);
        return { value: s.failed15, yellow: s.failed15 >= 3, red: s.ended30 >= 4 && s.failed30 * 2 >= s.ended30 };
      } },
    deskStealMetric(p),
  ];
}

/**
 * `desk-steal`: on each sample, the desk sessions that ended since the last one (null when none: nothing changes, so an
 * open alert waits for the next session). Red when one has a steal share >= 50 %, or one >= 35 % with another >= 35 %
 * in the hour before it; yellow at 25 % (in town only). The value is the worst new share in %. Each clean session
 * counts one toward CLEAR_AFTER, so the alert clears after 5 clean sessions. cpu and steal are the whole desk
 * Machine's (2 vCPUs summed), not just the agent's process.
 */
export function deskStealMetric(p: Pick<Probes, "deskSessions">): Metric {
  let cursor: number | null = null;
  return {
    key: "desk-steal", describe: (v) => `desk session steal ${v}% of cpu + steal`, yellowForMs: 0, redForMs: 0,
    read: (now) => {
      const since = cursor ?? now - SAMPLE_MS;
      const recent = p.deskSessions(Math.min(since, now - HOUR_MS));
      const fresh = recent.filter((s) => s.endedAt > since);
      cursor = Math.max(since, ...recent.map((s) => s.endedAt));
      if (fresh.length === 0) return null;
      const worst = Math.max(...fresh.map((s) => s.share));
      const pair = fresh.some((s) => s.share >= DESK_STEAL.red2 && recent.some((o) => o !== s && o.share >= DESK_STEAL.red2 && Math.abs(o.endedAt - s.endedAt) <= HOUR_MS));
      const yellow = worst >= DESK_STEAL.yellow;
      return { value: Math.round(worst * 100), yellow, red: worst >= DESK_STEAL.red || pair, clean: yellow ? 0 : fresh.length };
    },
  };
}

/** The real probes: process memory, an event-loop histogram reset each sample, statfs on the data dir, the runtime's slots. */
export function processProbes(world: World, dataDir: string, backup: () => BackupView | null, counters: Counters): Probes & { close(): void } {
  const h: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return {
    rssBytes: () => process.memoryUsage().rss,
    // percentile() is in ns and includes the 20 ms resolution (load.ts does the same)
    lagP99Ms: () => { const v = h.count > 0 ? Math.max(0, Math.round(h.percentile(99) / 1e6) - 20) : null; h.reset(); return v; },
    diskFree: () => { try { const s = statfsSync(dataDir); return s.blocks > 0 ? s.bavail / s.blocks : null; } catch { return null; } },
    slots: () => world.host.slots?.() ?? null,
    queueWaiting: () => (world.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status = 'pending' AND waitFor IS NULL").get() as { n: number }).n,
    backup,
    http: (now) => counters.http(now),
    wsErrors: (now) => counters.wsErrors(now),
    sessions: (now) => {
      const since = (ms: number) => new Date(now - ms).toISOString();
      const r = world.db.prepare(`SELECT
          COALESCE(SUM(status = 'error' AND endedAt >= ?), 0) AS failed15,
          COUNT(*) AS ended30, COALESCE(SUM(status = 'error'), 0) AS failed30
        FROM sessions WHERE endedAt IS NOT NULL AND endedAt >= ?`).get(since(15 * MIN), since(30 * MIN)) as { failed15: number; ended30: number; failed30: number };
      return r;
    },
    deskSessions: (sinceMs) => (world.db.prepare(`SELECT id, endedAt, cpuMs, stealMs FROM sessions
        WHERE endedAt IS NOT NULL AND endedAt > ? AND backend != 'host' AND wallMs >= ? AND cpuMs IS NOT NULL AND stealMs IS NOT NULL AND cpuMs + stealMs > 0
        ORDER BY endedAt`).all(new Date(sinceMs).toISOString(), DESK_MIN_WALL_MS) as { id: string; endedAt: string; cpuMs: number; stealMs: number }[])
      .map((r) => ({ id: r.id, endedAt: Date.parse(r.endedAt), share: r.stealMs / (r.cpuMs + r.stealMs) })),
    close: () => h.disable(),
  };
}

export interface MonitorOptions {
  world: World;
  metrics: Metric[];
  /** the seven ALERT_* values (process.env); any missing = in-town only */
  env?: Record<string, string | undefined>;
  /** default: Twilio REST + Gmail SMTP from env */
  senders?: Senders;
  now?: () => number;
  log?: Pick<Console, "log" | "warn">;
  /** what app.ts / ws.ts bump (default: a fresh one on this monitor's clock) */
  counters?: Counters;
  /** the board FYIs go to (default: the building named "Prod", else the Town Hall; null = events only) */
  buildingId?: string | null;
}

export class Monitor {
  readonly outbound: boolean;
  /** the HTTP / WebSocket error counters the 5xx and ws metrics read (when built over the same Counters) */
  readonly counters: Counters;
  private readonly senders: Senders | null;
  private readonly now: () => number;
  private readonly log: Pick<Console, "log" | "warn">;
  private readonly world: World;
  private alerts = new Map<string, OpenAlert>();
  /** per key: when the yellow / red condition started holding (null = not holding) */
  private holding = new Map<string, { yellow: number | null; red: number | null }>();
  private sent: number[] = [];
  private lastSampleAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: MonitorOptions) {
    this.world = opts.world;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console;
    this.counters = opts.counters ?? new Counters(this.now);
    const env = opts.env ?? process.env;
    const missing = ALERT_ENV.filter((k) => !env[k]?.trim());
    this.outbound = missing.length === 0;
    this.senders = !this.outbound ? null : opts.senders ?? envSenders(env);
    if (!this.outbound) this.log.log("monitor: outbound disabled");
    const p = this.load();
    this.lastSampleAt = p.lastSampleAt ? Date.parse(p.lastSampleAt) : null;
    for (const a of p.alerts) this.alerts.set(a.key, a);
    this.sent = p.sent;
  }

  start(intervalMs = SAMPLE_MS) {
    this.timer = setInterval(() => { this.sample().catch((e) => this.log.warn(`[monitor] sample failed: ${e instanceof Error ? e.message : String(e)}`)); }, intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** the metric keys this monitor samples */
  keys(): string[] { return this.opts.metrics.map((m) => m.key); }

  view(): MonitorView {
    return {
      lastSampleAt: this.lastSampleAt ? new Date(this.lastSampleAt).toISOString() : null,
      outbound: this.outbound,
      alerts: [...this.alerts.values()].map(({ key, level, since, value }) => ({ key, level, since, value })),
    };
  }

  /** One pass over every metric. Exposed for tests (fake clock); the timer calls it every 60 s. */
  async sample(): Promise<void> {
    const now = this.now();
    if (this.lastSampleAt != null && now - this.lastSampleAt > GAP_MS) {
      const min = Math.round((now - this.lastSampleAt) / MIN);
      this.event(`Monitor gap: no samples for ${min} min (server down or restarting)`, { phase: "gap", gapMin: min, from: new Date(this.lastSampleAt).toISOString() });
    }
    this.lastSampleAt = now;
    const jobs: Promise<unknown>[] = [];
    for (const m of this.opts.metrics) {
      let r: Reading | null;
      try { r = m.read(now); } catch (e) { this.log.warn(`[monitor] ${m.key}: ${e instanceof Error ? e.message : String(e)}`); continue; }
      if (!r) continue;
      const h = this.holding.get(m.key) ?? { yellow: null, red: null };
      h.yellow = r.yellow || r.red ? h.yellow ?? now : null;
      h.red = r.red ? h.red ?? now : null;
      this.holding.set(m.key, h);
      const level: Level | null = h.red != null && now - h.red >= m.redForMs ? "red" : h.yellow != null && now - h.yellow >= m.yellowForMs ? "yellow" : null;
      const open = this.alerts.get(m.key);
      if (!open) {
        if (level) jobs.push(this.raise(m, level, r.value, now));
        continue;
      }
      open.value = r.value;
      if (r.yellow || r.red) open.okCount = 0;
      else if ((open.okCount += r.clean ?? 1) >= CLEAR_AFTER) { jobs.push(this.clear(m, open, now)); continue; }
      if (level === "red" && open.level === "yellow") jobs.push(this.raise(m, "red", r.value, now, open));
      else if (level === "red" && now - open.notifiedAt >= REALERT_MS) jobs.push(this.raise(m, "red", r.value, now, open, true));
    }
    this.save();
    await Promise.all(jobs);
    this.save();
  }

  /**
   * POST /api/admin/monitor/test: one red alert (key `test`) down the whole path (event, FYI, SMS, email); it counts
   * toward the cap and is not kept open.
   */
  async test(by: string, metric?: string): Promise<{ eventId: number; fyiDocId: string | null; sms: SendResult; email: SendResult }> {
    const now = this.now();
    const key = metric ?? "test";
    const what = metric ? ` for ${metric}` : "";
    const text = `Test alert (red)${what} from the muster.town monitor, requested by ${by}. Nothing is wrong.`;
    const fyiDocId = this.fyi(`[RED] Monitor test alert${what}`, `${text}\n\n${new Date(now).toISOString()}`);
    const eventId = this.event(text, { key, level: "red", phase: "test", docId: fyiDocId });
    const out = await this.send(`muster.town RED test: ${text}`, `[muster.town] RED: test alert${what}`, text);
    this.save();
    return { eventId, fyiDocId, ...out };
  }

  private async raise(m: Metric, level: Level, value: number, now: number, open?: OpenAlert, again = false) {
    const what = m.describe(value);
    const verb = again ? "still" : open ? "escalated to" : "raised";
    const text = `Alert ${verb} ${level.toUpperCase()}: ${what} (${m.key})`;
    const alert: OpenAlert = open ?? { key: m.key, level, since: new Date(now).toISOString(), value, docId: null, notifiedAt: now, okCount: 0 };
    alert.level = level;
    alert.value = value;
    alert.notifiedAt = now;
    this.alerts.set(m.key, alert);
    const body = `**${level.toUpperCase()}** ${what}\n\n- key: ${m.key}\n- since: ${alert.since}\n- ${verb} at ${new Date(now).toISOString()}\n\nThe monitor clears this after ${CLEAR_AFTER} samples in a row under yellow and updates this FYI.`;
    if (alert.docId) this.updateFyi(alert.docId, `[${level.toUpperCase()}] ${what}`, body);
    else alert.docId = this.fyi(`[${level.toUpperCase()}] ${what}`, body);
    this.event(text, { key: m.key, level, phase: again ? "realert" : "raise", value, docId: alert.docId });
    if (level === "red") await this.send(`muster.town RED: ${what}`, `[muster.town] RED: ${what}`, `${text}\n\nSince ${alert.since}.\nhttps://muster.town/api/health`);
  }

  private async clear(m: Metric, a: OpenAlert, now: number) {
    this.alerts.delete(m.key);
    const what = m.describe(a.value);
    const text = `Alert cleared (was ${a.level.toUpperCase()}): ${what} (${m.key})`;
    if (a.docId) this.updateFyi(a.docId, `[CLEARED] ${a.level.toUpperCase()} ${m.key}: ${what}`, `**Cleared** at ${new Date(now).toISOString()} after ${CLEAR_AFTER} samples under yellow (now ${what}).\n\n- key: ${m.key}\n- was ${a.level.toUpperCase()} since ${a.since}`);
    this.event(text, { key: m.key, level: a.level, phase: "clear", value: a.value, docId: a.docId });
    if (a.level === "red") await this.send(`muster.town cleared: ${what}`, `[muster.town] cleared: ${m.key}`, text);
  }

  /** SMS then email, each one message toward the hourly cap. */
  private async send(sms: string, subject: string, body: string): Promise<{ sms: SendResult; email: SendResult }> {
    if (!this.senders) return { sms: "skipped", email: "skipped" };
    const one = async (k: "sms" | "email", f: () => Promise<void>): Promise<SendResult> => {
      const now = this.now();
      this.sent = this.sent.filter((t) => now - t < HOUR_MS);
      if (this.sent.length >= OUTBOUND_CAP) { this.log.warn(`[monitor] ${k} skipped: ${OUTBOUND_CAP}/h cap reached`); return "skipped"; }
      this.sent.push(now);
      try { await f(); return "sent"; } catch (e) { this.log.warn(`[monitor] ${k} failed: ${e instanceof Error ? e.message : String(e)}`); return "error"; }
    };
    const s = this.senders;
    return { sms: await one("sms", () => s.sms(sms.slice(0, 300))), email: await one("email", () => s.email(subject, body)) };
  }

  private event(text: string, payload: Record<string, unknown>): number {
    return this.world.events.append({ type: "alert", buildingId: this.buildingId(), text, payload }).id;
  }

  private buildingId(): string | null {
    if (this.opts.buildingId !== undefined) return this.opts.buildingId;
    const all = this.world.buildings.all();
    return (all.find((b) => b.name.trim().toLowerCase() === "prod") ?? all.find((b) => b.id === TOWN_HALL_ID || b.kind === "town-hall"))?.id ?? null;
  }

  private fyi(title: string, body: string): string | null {
    const buildingId = this.buildingId();
    if (!buildingId) return null;
    try {
      return createDoc(this.world, { type: "fyi", state: "building", title, body, authorId: "system", authorKind: "user", buildingId, tags: ["alert", "monitor"] }, `Monitor: ${title}`).id;
    } catch (e) { this.log.warn(`[monitor] FYI not written: ${e instanceof Error ? e.message : String(e)}`); return null; }
  }

  private updateFyi(id: string, title: string, body: string) {
    try { if (this.world.docs.get(id)) updateDoc(this.world, id, { title, body }); } catch (e) { this.log.warn(`[monitor] FYI not updated: ${e instanceof Error ? e.message : String(e)}`); }
  }

  private load(): Persisted {
    const r = this.world.db.prepare("SELECT value FROM meta WHERE key = 'monitor'").get() as { value: string } | undefined;
    try { const p = r ? JSON.parse(r.value) as Partial<Persisted> : {}; return { lastSampleAt: p.lastSampleAt ?? null, alerts: p.alerts ?? [], sent: p.sent ?? [] }; }
    catch { return { lastSampleAt: null, alerts: [], sent: [] }; }
  }

  private save() {
    const p: Persisted = { lastSampleAt: this.view().lastSampleAt, alerts: [...this.alerts.values()], sent: this.sent };
    this.world.db.prepare("INSERT INTO meta (key, value) VALUES ('monitor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
  }
}

/** Twilio REST and Gmail SMTP from the ALERT_* env. */
export function envSenders(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Senders {
  const v = (k: (typeof ALERT_ENV)[number]) => env[k]!.trim();
  return {
    async sms(text) {
      const sid = v("ALERT_TWILIO_SID");
      const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${v("ALERT_TWILIO_AUTH")}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: v("ALERT_TWILIO_FROM"), To: v("ALERT_SMS_TO"), Body: text }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}`);
    },
    email: (subject, text) => smtpSend({ host: "smtp.gmail.com", port: 587, user: v("ALERT_SMTP_USER"), pass: v("ALERT_SMTP_PASS"), to: v("ALERT_EMAIL_TO"), subject, text }),
  };
}

/** A minimal SMTP client: plain connect, STARTTLS, AUTH PLAIN, one message. Throws with the server's reply code on failure (never the password). */
export async function smtpSend(o: { host: string; port: number; user: string; pass: string; to: string; subject: string; text: string; timeoutMs?: number }): Promise<void> {
  let sock: Socket | TLSSocket = createConnection({ host: o.host, port: o.port });
  sock.setTimeout(o.timeoutMs ?? 20_000, () => sock.destroy(new Error("SMTP timeout")));
  let buf = "";
  let waiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  let failed: Error | null = null;
  const attach = (s: Socket | TLSSocket) => {
    s.on("data", (d: Buffer) => { buf += d.toString("utf8"); pump(); });
    s.on("error", (e: Error) => { failed = e; waiter?.reject(e); waiter = null; });
  };
  // a reply is complete at a line "NNN text" (multi-line replies use "NNN-text")
  const pump = () => {
    if (!waiter) return;
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join("\n");
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiter; waiter = null; w.resolve(reply);
        return;
      }
    }
  };
  const read = () => new Promise<string>((resolve, reject) => { if (failed) return reject(failed); waiter = { resolve, reject }; pump(); });
  const expect = async (code: string, step: string) => { const r = await read(); if (!r.startsWith(code)) throw new Error(`SMTP ${step}: ${r.slice(0, 3)}`); };
  const cmd = async (line: string, code: string, step: string) => { sock.write(line + "\r\n"); await expect(code, step); };
  attach(sock);
  try {
    await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    await expect("220", "greeting");
    await cmd("EHLO muster.town", "250", "EHLO");
    await cmd("STARTTLS", "220", "STARTTLS");
    sock.removeAllListeners("data");
    sock = await new Promise<TLSSocket>((resolve, reject) => {
      const t = tlsConnect({ socket: sock as Socket, servername: o.host }, () => resolve(t));
      t.once("error", reject);
    });
    sock.setTimeout(o.timeoutMs ?? 20_000, () => sock.destroy(new Error("SMTP timeout")));
    attach(sock);
    await cmd("EHLO muster.town", "250", "EHLO (TLS)");
    await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`).toString("base64")}`, "235", "AUTH");
    await cmd(`MAIL FROM:<${o.user}>`, "250", "MAIL FROM");
    await cmd(`RCPT TO:<${o.to}>`, "250", "RCPT TO");
    await cmd("DATA", "354", "DATA");
    const msg = [`From: muster.town monitor <${o.user}>`, `To: <${o.to}>`, `Subject: ${o.subject.replace(/[\r\n]+/g, " ")}`, `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", ...o.text.split(/\r?\n/).map((l) => (l.startsWith(".") ? "." + l : l))].join("\r\n");
    await cmd(`${msg}\r\n.`, "250", "message");
    sock.write("QUIT\r\n");
  } finally {
    sock.end();
    sock.destroy();
  }
}
