import type { DesksConfig, Session } from "@muster-town/schema";
import { DESK_LEGACY_SIZE, DESK_MACHINE_DEFAULTS, flyRate } from "./finance-fly.ts";

/**
 * The town-wide daily desk bill (gr_uhh6u39vv9 step 3; Mitchell, 1:1 mt_s6f8mvjw9h, notes dc_5y5wjybr5u): desk Machines
 * run on performance-1x (steal on shared-cpu-2x was 84–91 %), and once the UTC day's desk sessions cost `billCapUsd`
 * (default $10) at Fly list prices, new desk sessions start on shared-cpu-2x instead. A session is never refused.
 * Read by the runtime at session start, by GET /api/health `desks` and by the monitor's `desk-bill` metric.
 */
export interface DeskSize { cpuKind: "shared" | "performance"; cpus: number; memoryMb: number }

/** what desks ran on before step 3 (sessions without a recorded size), and the size past the cap */
export const DESK_FALLBACK_SIZE: DeskSize = { ...DESK_LEGACY_SIZE };

/** The desk size the config asks for (unset fields: FlyApi's defaults, performance-1x 2048 MB). */
const configuredDeskSize = (desks: Pick<DesksConfig, "cpuKind" | "cpus" | "memoryMb">): DeskSize => ({
  cpuKind: desks.cpuKind ?? DESK_MACHINE_DEFAULTS.cpuKind, cpus: desks.cpus ?? DESK_MACHINE_DEFAULTS.cpus, memoryMb: desks.memoryMb ?? DESK_MACHINE_DEFAULTS.memoryMb,
});

export type SizedSession = Pick<Session, "cpuKind" | "cpus" | "memoryMb">;
/** The size a desk session ran on: its recorded one, else shared-cpu-2x (every desk before migration 060). */
const sessionDeskSize = (s: SizedSession): DeskSize =>
  s.cpuKind && s.cpus && s.memoryMb ? { cpuKind: s.cpuKind, cpus: s.cpus, memoryMb: s.memoryMb } : DESK_FALLBACK_SIZE;

/** "performance-1x", "shared-cpu-2x" */
export const deskPreset = (z: DeskSize) => `${z.cpuKind === "shared" ? "shared-cpu" : "performance"}-${z.cpus}x`;
const deskUsdPerHour = (z: DeskSize) => flyRate(z.cpuKind, z.cpus, z.memoryMb)?.usdPerHour ?? 0;

export interface DeskBill {
  /** "YYYY-MM-DD", UTC */
  day: string;
  capUsd: number;
  /** Σ over today's desk sessions of their wall time inside the day × their size's $/h */
  todayUsd: number;
  /** todayUsd / capUsd in %, one decimal (0 when the cap is 0 and nothing ran) */
  pct: number;
  sessions: number;
  overCap: boolean;
}

const DAY_MS = 86_400_000;
const round = (x: number, places = 6) => { const f = 10 ** places; return Math.round(x * f) / f; };

export type BillSession = Pick<Session, "backend" | "startedAt" | "endedAt" | "wallMs"> & SizedSession;

/** The UTC day's desk bill. A session's wall time is its wallMs, else endedAt − startedAt (running: up to now), as /api/finance/fly. */
export function deskBillToday(sessions: BillSession[], capUsd: number, now = new Date()): DeskBill {
  const nowMs = now.getTime();
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  let usd = 0, n = 0;
  for (const s of sessions) {
    if (s.backend === "host") continue;
    const start = Date.parse(s.startedAt);
    if (!Number.isFinite(start)) continue;
    const end = s.wallMs != null && s.wallMs >= 0 ? start + s.wallMs : s.endedAt ? Date.parse(s.endedAt) : nowMs;
    const ms = Math.min(end, nowMs) - Math.max(start, dayStart);
    if (ms <= 0) continue;
    n++;
    usd += (ms / 3_600_000) * deskUsdPerHour(sessionDeskSize(s));
  }
  const todayUsd = round(usd);
  return {
    day: new Date(dayStart).toISOString().slice(0, 10), capUsd, todayUsd, sessions: n,
    pct: capUsd > 0 ? Math.round((todayUsd / capUsd) * 1000) / 10 : 0,
    overCap: todayUsd >= capUsd,
  };
}

/** The size a new desk session gets: the configured one, or shared-cpu-2x once today's bill has reached the cap. */
export function deskSizeFor(desks: Pick<DesksConfig, "cpuKind" | "cpus" | "memoryMb">, bill: DeskBill): { size: DeskSize; fallback: boolean } {
  const size = configuredDeskSize(desks);
  return bill.overCap && deskUsdPerHour(size) > deskUsdPerHour(DESK_FALLBACK_SIZE) ? { size: DESK_FALLBACK_SIZE, fallback: true } : { size, fallback: false };
}
