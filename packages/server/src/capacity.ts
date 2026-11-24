import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { World } from "@muster-town/core";
import type { TickStat } from "./context.ts";

/**
 * GET /api/health `capacity` (gr_n0p3ast5pp step 3, kr_mbuhs8agz7): live headroom against the ceilings and triggers in
 * docs/scaling.md "How to check headroom live". Computed in the HealthCache refresh (5 s on the live server), never on the
 * request path. Root app only: hosted collectives share the process and its figures.
 */
const WS_CEILING = 1200;
const SLOW_TICK_MS = 500;
const TICK_WINDOW = 100;
const DAY_MS = 24 * 3600_000;

interface Capacity {
  at: string;
  wsClients: { now: number; ceiling: number };
  /** p95 of the main world's last `samples` distinct runtime ticks (null before the first tick); hosted worlds' ticks are not included */
  tick: { p95Ms: number | null; slowMs: number; samples: number };
  /** town.db plus its -wal in MB (one decimal); the filesystem it lives on in GB (one decimal) */
  db: { mb: number; volumeGb: number | null };
  /** server starts in the last 24 h, counted from the boot markers main.ts writes (system events with payload.boot) */
  restarts24h: number;
  /** the same starts by cause (gr_zsglqgxpew); a marker from before causes were recorded counts as unknown */
  restartsByCause24h: Record<BootCause | "unknown", number>;
  /** this process's boot: when, why, and Fly's exit code and OOM flag for an unplanned one (null when not known) */
  lastBoot: { at: string; cause: BootCause | "unknown"; exitCode: number | null; oomKilled: boolean | null } | null;
}

/**
 * Why a server booted (gr_zsglqgxpew, kr_q82dyp154n), from the events since the previous boot marker: "redeploy" when the
 * town's redeploy said "Redeploy: restarting server", "stopped" when main.ts's signal handler wrote its stop marker (an image
 * deploy, a Machine restart, a human's stop), "unplanned" when neither did (a crash, an OOM kill, a host failure).
 */
type BootCause = "redeploy" | "stopped" | "unplanned";
const CAUSES: readonly BootCause[] = ["redeploy", "stopped", "unplanned"];

const STOP_MARKER = "Server stopping";
const REDEPLOY_RESTART = "Redeploy: restarting server";

/** p95 by nearest rank: the smallest value with at least 95 % of the samples at or below it. */
export function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

/** The last `size` distinct ticks (deduped on `at`). */
class TickRing {
  private ms: number[] = [];
  private lastAt: string | null = null;
  constructor(private readonly size = TICK_WINDOW) {}
  add(t: TickStat | null | undefined): void {
    if (!t || t.at === this.lastAt) return;
    this.lastAt = t.at;
    this.ms.push(t.ms);
    if (this.ms.length > this.size) this.ms.shift();
  }
  values(): number[] { return [...this.ms]; }
}

function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function dbFigures(dbPath: string): Capacity["db"] {
  const onDisk = dbPath && dbPath !== ":memory:";
  const bytes = onDisk ? fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) : 0;
  let volumeGb: number | null = null;
  try {
    const s = statfsSync(onDisk ? dirname(dbPath) : ".");
    volumeGb = Math.round((s.blocks * s.bsize) / 1e9 * 10) / 10;
  } catch { /* no statfs: leave null */ }
  return { mb: Math.round(bytes / 1e6 * 10) / 10, volumeGb };
}

/** The shutdown handler's marker, written before the app closes: the next boot reads it as "stopped". */
export function markStop(world: World, signal: string): void {
  world.events.append({ type: "system", text: STOP_MARKER, payload: { stop: true, signal } });
}

/** Classes this boot from the events after the previous boot marker (all of them when there is none). */
export function bootCause(world: World): BootCause {
  const prev = world.events.list({ types: ["system"], payloadKey: "boot", desc: true, limit: 1 })[0];
  const since = prev?.id ?? 0;
  if (world.events.list({ types: ["system"], since, textLike: `${REDEPLOY_RESTART}%`, payloadKey: "redeploy", limit: 1 }).length) return "redeploy";
  if (world.events.list({ types: ["system"], since, payloadKey: "stop", limit: 1 }).some((e) => e.text === STOP_MARKER)) return "stopped";
  return "unplanned";
}

interface FlyExit { exitCode: number | null; oomKilled: boolean | null }
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The newest `exit` event of this Machine before `before` (ms) and after `after` (ms), from the Fly Machines API
 * (GET /v1/apps/<app>/machines/<id>/events, read-only FLY_LOGS_TOKEN). Null when there is none; throws on a failed fetch.
 */
async function flyExit(o: { app: string; machine: string; token: string; before: number; after: number; fetch?: FetchLike; timeoutMs?: number }): Promise<FlyExit | null> {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await f(`https://api.machines.dev/v1/apps/${encodeURIComponent(o.app)}/machines/${encodeURIComponent(o.machine)}/events`, {
    headers: { Authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
  });
  if (!res.ok) throw new Error(`Fly Machines API answered ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("Fly Machines API: events is not a list");
  let best: { ts: number; e: Record<string, unknown> } | null = null;
  for (const e of body as Record<string, unknown>[]) {
    const ts = Number(e?.timestamp);
    if (e?.type !== "exit" || !Number.isFinite(ts) || ts >= o.before || ts <= o.after) continue;
    if (!best || ts > best.ts) best = { ts, e };
  }
  if (!best) return null;
  const req = (best.e.request ?? {}) as Record<string, unknown>;
  const ev = (req.exit_event ?? req) as Record<string, unknown>;
  return {
    exitCode: typeof ev.exit_code === "number" ? ev.exit_code : null,
    oomKilled: typeof ev.oom_killed === "boolean" ? ev.oom_killed : null,
  };
}

const FLY_TOKEN_SECRET = "FLY_LOGS_TOKEN";

/**
 * Marks a server start: one system event per boot, read back by `capacity.restarts24h` and `capacity.lastBoot`. Its payload
 * says why it booted; for an unplanned boot on Fly (FLY_MACHINE_ID set, the FLY_LOGS_TOKEN secret stored) it adds the
 * Machine's exit code and OOM flag. A failed Fly read only logs: the marker is written either way.
 */
export async function markBoot(world: World, o: { env?: NodeJS.ProcessEnv; fetch?: FetchLike; now?: () => number; log?: (m: string) => void } = {}): Promise<void> {
  const env = o.env ?? process.env;
  const cause = bootCause(world);
  let exit: FlyExit | null = null;
  const machine = env.FLY_MACHINE_ID, app = env.FLY_APP_NAME;
  if (cause === "unplanned" && machine && app) {
    let token: string | null = null;
    try { token = world.secrets.value(FLY_TOKEN_SECRET) ?? null; } catch { token = null; }
    if (token) {
      const prev = world.events.list({ types: ["system"], payloadKey: "boot", desc: true, limit: 1 })[0];
      try {
        exit = await flyExit({ app, machine, token, before: o.now?.() ?? Date.now(), after: prev ? Date.parse(prev.ts) : 0, fetch: o.fetch });
      } catch (e) {
        (o.log ?? console.warn)(`[server] boot cause: Fly Machine events not read (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  world.events.append({ type: "system", text: "Server started", payload: { boot: true, cause, exitCode: exit?.exitCode ?? null, oomKilled: exit?.oomKilled ?? null } });
}

function causeOf(p: Record<string, unknown>): BootCause | "unknown" {
  return CAUSES.includes(p.cause as BootCause) ? (p.cause as BootCause) : "unknown";
}

/** health `capacity.lastBoot`: a boot's time, cause, and Fly's exit code and OOM flag (null when not known) */
export type LastBoot = NonNullable<Capacity["lastBoot"]>;

/** The newest boot marker (this process's own once main.ts has run markBoot): health `capacity.lastBoot`, monitor key `crash`. */
export function readLastBoot(world: World): LastBoot | null {
  const newest = world.events.list({ types: ["system"], payloadKey: "boot", desc: true, limit: 1 })[0];
  return newest ? {
    at: newest.ts, cause: causeOf(newest.payload),
    exitCode: typeof newest.payload.exitCode === "number" ? newest.payload.exitCode : null,
    oomKilled: typeof newest.payload.oomKilled === "boolean" ? newest.payload.oomKilled : null,
  } : null;
}

/**
 * Keeps the state between refreshes: the tick ring, and the boot times of the last day, read from the database once at
 * construction (this process's own boot marker is written before the app is built) so a refresh never queries SQLite.
 */
export class CapacityProbe {
  private ticks = new TickRing();
  private boots: { at: number; cause: BootCause | "unknown" }[];
  private last: Capacity["lastBoot"];
  constructor(private readonly world: World, private readonly o: { ws: () => number; tick: () => TickStat | null | undefined; now?: () => number }) {
    const from = new Date(this.now() - DAY_MS).toISOString();
    const markers = world.events.list({ types: ["system"], from, payloadKey: "boot", limit: 5000 });
    this.boots = markers.map((e) => ({ at: Date.parse(e.ts), cause: causeOf(e.payload) }));
    this.last = readLastBoot(world);
  }
  private now(): number { return this.o.now?.() ?? Date.now(); }
  /** a boot marker written after construction (tests) */
  noteBoot(at: number, cause: BootCause | "unknown" = "unknown"): void { this.boots.push({ at, cause }); }

  compute(): Capacity {
    this.ticks.add(this.o.tick());
    const now = this.now();
    this.boots = this.boots.filter((b) => b.at > now - DAY_MS);
    const byCause: Capacity["restartsByCause24h"] = { redeploy: 0, stopped: 0, unplanned: 0, unknown: 0 };
    for (const b of this.boots) byCause[b.cause]++;
    const samples = this.ticks.values();
    return {
      at: new Date(now).toISOString(),
      wsClients: { now: this.o.ws(), ceiling: WS_CEILING },
      tick: { p95Ms: p95(samples), slowMs: SLOW_TICK_MS, samples: samples.length },
      db: dbFigures((this.world.db as { name?: string }).name ?? ""),
      restarts24h: this.boots.length,
      restartsByCause24h: byCause,
      lastBoot: this.last,
    };
  }
}
