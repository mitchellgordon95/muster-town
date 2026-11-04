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
}

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

/** Marks a server start: one system event per boot, read back by `capacity.restarts24h`. */
export function markBoot(world: World): void {
  world.events.append({ type: "system", text: "Server started", payload: { boot: true } });
}

/**
 * Keeps the state between refreshes: the tick ring, and the boot times of the last day, read from the database once at
 * construction (this process's own boot marker is written before the app is built) so a refresh never queries SQLite.
 */
export class CapacityProbe {
  private ticks = new TickRing();
  private boots: number[];
  constructor(private readonly world: World, private readonly o: { ws: () => number; tick: () => TickStat | null | undefined; now?: () => number }) {
    const from = new Date(this.now() - DAY_MS).toISOString();
    this.boots = world.events.list({ types: ["system"], from, payloadKey: "boot", limit: 5000 }).map((e) => Date.parse(e.ts));
  }
  private now(): number { return this.o.now?.() ?? Date.now(); }
  /** a boot marker written after construction (tests) */
  noteBoot(at: number): void { this.boots.push(at); }

  compute(): Capacity {
    this.ticks.add(this.o.tick());
    const now = this.now();
    this.boots = this.boots.filter((t) => t > now - DAY_MS);
    const samples = this.ticks.values();
    return {
      at: new Date(now).toISOString(),
      wsClients: { now: this.o.ws(), ceiling: WS_CEILING },
      tick: { p95Ms: p95(samples), slowMs: SLOW_TICK_MS, samples: samples.length },
      db: dbFigures((this.world.db as { name?: string }).name ?? ""),
      restarts24h: this.boots.length,
    };
  }
}
