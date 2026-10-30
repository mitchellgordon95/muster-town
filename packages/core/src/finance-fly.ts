import type { Agent, Assignment, Building, DesksConfig, Session } from "@muster-town/schema";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/fly: what the town's hosting costs on Fly.io, next to the token spend (Mitchell's ask, 1:1
 * mt_s6f8mvjw9h via Cleo). Nothing here is read from Fly's bill: it is an estimate from what the town itself records,
 * priced at Fly's published list prices (`FLY_PRICES`), so a human can compare it with the real invoice.
 *
 * Two parts, per UTC day:
 * - desks: every desk session (backend ≠ host) runs on its own Fly Machine for as long as it lasts, so a day's desk cost
 *   is the wall time of the sessions that overlapped it × the desk Machine size's $/h. A session's wall time is its
 *   recorded `wallMs` (gr_uhh6u39vv9 step 1), else endedAt − startedAt (a running one counts up to `now`). Sessions
 *   are split across the days they span. Each session is charged to its assignment's building, else its agent's (as
 *   /api/finance/spend does), so a day also breaks down by building.
 * - town: the always-on town Machine (fly.town.toml `[[vm]]`, `TOWN_MACHINE`) at its $/h × the hours of the day
 *   elapsed. Counted only when the server itself runs on a Fly Machine (`FLY_APP_NAME` set); desks are priced only
 *   when `desks.backend` is `fly`.
 *
 * Identities (`sumCheck`): per day `desk + town = total`; over the window `Σ days desk ms = Σ buildings desk ms`.
 * Not counted: volume storage ($0.15/GB-month per desk volume and the town's), stopped Machines' rootfs, bandwidth.
 */
export interface FlyRate {
  /** Fly preset, e.g. "shared-cpu-2x" or "performance-1x" */
  preset: string;
  memoryMb: number;
  /** list price for 30 days always-on (iad), the per-GB extra RAM added when memoryMb exceeds the preset's */
  usdPerMonth: number;
  usdPerHour: number;
}

export interface FlyDayBuilding { id: string | null; name: string; deskMs: number; deskUsd: number; sessions: number }
export interface FlyDay {
  /** "YYYY-MM-DD" (UTC) */
  day: string;
  deskMs: number;
  deskUsd: number;
  /** the town Machine's share: its $/h × the hours of the day elapsed (a full day except today) */
  townUsd: number;
  totalUsd: number;
  /** desk sessions that overlapped the day */
  sessions: number;
  buildings: FlyDayBuilding[];
}
export interface FlyBuilding { id: string | null; name: string; deskMs: number; deskUsd: number; sessions: number }

export interface FinanceFly {
  /** the window: the last `days` UTC days up to today, newest first in `days[]` */
  windowDays: number;
  from: string;
  to: string;
  rates: {
    desk: FlyRate | null;
    town: FlyRate | null;
    /** $/GB-month for RAM beyond a preset's */
    extraRamUsdPerGbMonth: number;
    region: string;
    source: string;
    /** when the list prices were read */
    pricedAt: string;
  };
  /** what is and isn't priced, in words */
  desksBackend: DesksConfig["backend"];
  townOnFly: boolean;
  /** the town-wide daily desk bill cap in USD (Prod's desk-perf step 3, health `desks.billCapUsd`); null = none set */
  capUsdPerDay: number | null;
  today: { day: string; deskUsd: number; townUsd: number; totalUsd: number; capUsdPerDay: number | null; underCap: boolean | null };
  days: FlyDay[];
  /** per building over the window, by cost */
  buildings: FlyBuilding[];
  totals: { deskMs: number; deskHours: number; deskUsd: number; townUsd: number; totalUsd: number; sessions: number; unmeasuredSessions: number };
  notCounted: string[];
  assumptions: string[];
  sumCheck: { ok: boolean; diff: number; identity: string; daysOk: boolean; buildingsOk: boolean };
  at: string;
}

export interface FlyInputs {
  /** cpuKind / cpus / memoryMb: the size the session ran on (migration 060); absent = DESK_LEGACY_SIZE */
  sessions: (Pick<Session, "agentId" | "assignmentId" | "backend" | "startedAt" | "endedAt" | "wallMs"> & Partial<Pick<Session, "cpuKind" | "cpus" | "memoryMb">>)[];
  assignments: Pick<Assignment, "id" | "buildingId">[];
  agents: Pick<Agent, "id" | "buildingId">[];
  buildings: Pick<Building, "id" | "name">[];
  desks: Pick<DesksConfig, "backend" | "cpuKind" | "cpus" | "memoryMb">;
  /** the server runs on a Fly Machine (FLY_APP_NAME set): the town Machine is billed */
  townOnFly: boolean;
  capUsdPerDay?: number | null;
  /** how many UTC days back from today (1..90) */
  windowDays?: number;
}

const DAY_MS = 86_400_000;
const HOURS_PER_MONTH = 30 * 24;

/** Fly's list prices, Ashburn (iad), 30 days always-on, read from docs.fly.io/about/pricing on 2026-10-29. */
export const FLY_PRICES = {
  region: "iad",
  source: "https://docs.fly.io/about/pricing",
  pricedAt: "2026-10-29",
  extraRamUsdPerGbMonth: 6,
  presets: {
    "shared-cpu-1x": { memoryMb: 256, usdPerMonth: 2.19 },
    "shared-cpu-2x": { memoryMb: 2048, usdPerMonth: 13.39 },
    "performance-1x": { memoryMb: 2048, usdPerMonth: 33 },
    "performance-2x": { memoryMb: 4096, usdPerMonth: 66 },
  } as Record<string, { memoryMb: number; usdPerMonth: number }>,
} as const;

/** The town Machine as fly.town.toml `[[vm]]` sizes it (a core test pins this to the file). */
export const TOWN_MACHINE = { cpuKind: "shared", cpus: 2, memoryMb: 2048 } as const;
/** The desk Machine defaults of runtime/desk/fly.ts (FlyApi), used when desks config leaves a field unset (performance-1x since gr_uhh6u39vv9 step 3). */
export const DESK_MACHINE_DEFAULTS = { cpuKind: "performance", cpus: 1, memoryMb: 2048 } as const;
/** What a desk session without a recorded size (before migration 060) ran on. */
export const DESK_LEGACY_SIZE = { cpuKind: "shared", cpus: 2, memoryMb: 2048 } as const;

export const FLY_IDENTITY = "per day desk + town = total; Σ days desk time = Σ buildings desk time";
export const FLY_NOT_COUNTED = [
  "Volume storage: $0.15 per GB-month for each desk volume and the town's data volume, billed whether or not the Machine runs",
  "Stopped Machines' root file systems ($0.15 per GB-month) and outbound bandwidth",
  "Anything Fly bills that the town does not record; compare with the real invoice",
];

const round = (x: number, places = 6) => { const f = 10 ** places; return Math.round(x * f) / f; };
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** A Machine size's list price: the preset, plus $6/GB-month for RAM past the preset's; null for a size Fly has no preset for. */
export function flyRate(cpuKind: "shared" | "performance", cpus: number, memoryMb: number): FlyRate | null {
  const preset = `${cpuKind === "shared" ? "shared-cpu" : "performance"}-${cpus}x`;
  const p = FLY_PRICES.presets[preset];
  if (!p) return null;
  const extraGb = Math.max(0, memoryMb - p.memoryMb) / 1024;
  const usdPerMonth = round(p.usdPerMonth + extraGb * FLY_PRICES.extraRamUsdPerGbMonth, 2);
  return { preset, memoryMb, usdPerMonth, usdPerHour: round(usdPerMonth / HOURS_PER_MONTH) };
}

/** The pure aggregation behind GET /api/finance/fly. */
export function financeFly(inp: FlyInputs, now = new Date()): FinanceFly {
  const nowMs = now.getTime();
  const windowDays = Math.min(90, Math.max(1, Math.floor(inp.windowDays ?? 30)));
  const todayStart = startOfDay(nowMs);
  const fromMs = todayStart - (windowDays - 1) * DAY_MS;
  const desks = inp.desks;
  const deskRate = desks.backend === "fly"
    ? flyRate(desks.cpuKind ?? DESK_MACHINE_DEFAULTS.cpuKind, desks.cpus ?? DESK_MACHINE_DEFAULTS.cpus, desks.memoryMb ?? DESK_MACHINE_DEFAULTS.memoryMb)
    : null;
  const townRate = inp.townOnFly ? flyRate(TOWN_MACHINE.cpuKind, TOWN_MACHINE.cpus, TOWN_MACHINE.memoryMb) : null;
  // each session at the size it ran on (recorded since migration 060; older ones ran on DESK_LEGACY_SIZE)
  const legacyRate = flyRate(DESK_LEGACY_SIZE.cpuKind, DESK_LEGACY_SIZE.cpus, DESK_LEGACY_SIZE.memoryMb);
  const sessionUsdPerMs = (s: FlyInputs["sessions"][number]) => desks.backend !== "fly" ? 0
    : ((s.cpuKind && s.cpus && s.memoryMb ? flyRate(s.cpuKind, s.cpus, s.memoryMb) : legacyRate)?.usdPerHour ?? 0) / 3_600_000;
  const townUsdPerMs = (townRate?.usdPerHour ?? 0) / 3_600_000;

  const assignments = new Map(inp.assignments.map((a) => [a.id, a.buildingId]));
  const agents = new Map(inp.agents.map((a) => [a.id, a.buildingId]));
  const names = new Map(inp.buildings.map((b) => [b.id, b.name]));
  const nameOf = (id: string | null) => (id ? names.get(id) ?? id : "No building (town-wide sessions)");

  interface DayAcc { deskMs: number; deskUsd: number; sessions: Set<number>; buildings: Map<string, { id: string | null; deskMs: number; deskUsd: number; sessions: number }> }
  const days = new Map<string, DayAcc>();
  for (let d = 0; d < windowDays; d++) days.set(dayOf(fromMs + d * DAY_MS), { deskMs: 0, deskUsd: 0, sessions: new Set(), buildings: new Map() });
  const perBuilding = new Map<string, { id: string | null; deskMs: number; deskUsd: number; sessions: number }>();
  let sessions = 0, unmeasured = 0;

  inp.sessions.forEach((s, i) => {
    if (s.backend === "host") return;
    const start = new Date(s.startedAt).getTime();
    if (!Number.isFinite(start)) return;
    const measured = s.wallMs != null && s.wallMs >= 0;
    const endRecorded = s.endedAt ? new Date(s.endedAt).getTime() : null;
    // a measured session's wall clock is its own; else the row's timestamps (a running session counts up to now)
    const end = measured ? start + s.wallMs! : endRecorded ?? nowMs;
    if (end <= fromMs || start >= nowMs) return;
    if (!measured) unmeasured++;
    const buildingId = (s.assignmentId ? assignments.get(s.assignmentId) : undefined) ?? agents.get(s.agentId) ?? null;
    const key = buildingId ?? "";
    sessions++;
    const usdPerMs = sessionUsdPerMs(s);
    const b = perBuilding.get(key) ?? { id: buildingId, deskMs: 0, deskUsd: 0, sessions: 0 };
    perBuilding.set(key, b);
    b.sessions++;
    for (let t = Math.max(start, fromMs); t < Math.min(end, nowMs); t = startOfDay(t) + DAY_MS) {
      const dayEnd = startOfDay(t) + DAY_MS;
      const ms = Math.min(end, nowMs, dayEnd) - t;
      if (ms <= 0) break;
      const day = days.get(dayOf(t))!;
      day.deskMs += ms;
      day.deskUsd += ms * usdPerMs;
      day.sessions.add(i);
      const db = day.buildings.get(key) ?? { id: buildingId, deskMs: 0, deskUsd: 0, sessions: 0 };
      day.buildings.set(key, db);
      db.deskMs += ms;
      db.deskUsd += ms * usdPerMs;
      db.sessions++;
      b.deskMs += ms;
      b.deskUsd += ms * usdPerMs;
    }
  });

  const dayRows: FlyDay[] = [...days.entries()].map(([day, d]) => {
    const dayStart = new Date(day + "T00:00:00.000Z").getTime();
    const elapsedMs = Math.max(0, Math.min(DAY_MS, nowMs - dayStart));
    const deskUsd = round(d.deskUsd), townUsd = round(elapsedMs * townUsdPerMs);
    return {
      day, deskMs: d.deskMs, deskUsd, townUsd, totalUsd: round(deskUsd + townUsd), sessions: d.sessions.size,
      buildings: [...d.buildings.values()].map((b) => ({ id: b.id, name: nameOf(b.id), deskMs: b.deskMs, deskUsd: round(b.deskUsd), sessions: b.sessions }))
        .sort((x, y) => y.deskMs - x.deskMs || x.name.localeCompare(y.name)),
    };
  }).sort((x, y) => y.day.localeCompare(x.day));

  const buildings: FlyBuilding[] = [...perBuilding.values()].map((b) => ({ id: b.id, name: nameOf(b.id), deskMs: b.deskMs, deskUsd: round(b.deskUsd), sessions: b.sessions }))
    .sort((x, y) => y.deskMs - x.deskMs || x.name.localeCompare(y.name));
  const deskMs = dayRows.reduce((s, d) => s + d.deskMs, 0);
  const deskUsd = round(dayRows.reduce((s, d) => s + d.deskUsd, 0));
  const townUsd = round(dayRows.reduce((s, d) => s + d.townUsd, 0));
  const totalUsd = round(dayRows.reduce((s, d) => s + d.totalUsd, 0));
  const daysDiff = Math.max(...dayRows.map((d) => Math.abs(round(d.deskUsd + d.townUsd) - d.totalUsd)), 0);
  const buildingsDiff = deskMs - buildings.reduce((s, b) => s + b.deskMs, 0);
  const daysOk = daysDiff === 0, buildingsOk = buildingsDiff === 0;

  const today = dayRows[0]!;
  const cap = inp.capUsdPerDay ?? null;
  const assumptions = [
    deskRate
      ? `Each desk session is priced at the Machine size it ran on (sessions cpuKind / cpus / memoryMb); sessions from before that was recorded ran on ${legacyRate?.preset} ${DESK_LEGACY_SIZE.memoryMb} MB ($${legacyRate?.usdPerHour.toFixed(4)}/h). New desks: ${deskRate.preset}, ${deskRate.memoryMb} MB, $${deskRate.usdPerHour.toFixed(4)}/h`
      : `Desks are not on Fly (desks.backend ${desks.backend}), so desk time is shown but costs $0 here`,
    townRate
      ? `The town Machine (${townRate.preset}, ${townRate.memoryMb} MB, $${townRate.usdPerHour.toFixed(4)}/h) is counted for every hour of every day in the window; a restart or image deploy keeps it billed`
      : "The server is not on a Fly Machine, so no town Machine cost is counted",
    "A session's wall time is its recorded wallMs, else its row's endedAt − startedAt (a running session counts up to now); nothing before the window counts",
    `List prices for ${FLY_PRICES.region}, read ${FLY_PRICES.pricedAt}; Fly bills per second while a Machine runs`,
  ];
  return {
    windowDays, from: dayOf(fromMs), to: today.day,
    rates: { desk: deskRate, town: townRate, extraRamUsdPerGbMonth: FLY_PRICES.extraRamUsdPerGbMonth, region: FLY_PRICES.region, source: FLY_PRICES.source, pricedAt: FLY_PRICES.pricedAt },
    desksBackend: desks.backend, townOnFly: inp.townOnFly, capUsdPerDay: cap,
    today: { day: today.day, deskUsd: today.deskUsd, townUsd: today.townUsd, totalUsd: today.totalUsd, capUsdPerDay: cap, underCap: cap == null ? null : today.deskUsd <= cap },
    days: dayRows, buildings,
    totals: { deskMs, deskHours: round(deskMs / 3_600_000, 2), deskUsd, townUsd, totalUsd, sessions, unmeasuredSessions: unmeasured },
    notCounted: [...FLY_NOT_COUNTED], assumptions,
    sumCheck: { ok: daysOk && buildingsOk, diff: daysOk ? buildingsDiff : daysDiff, identity: FLY_IDENTITY, daysOk, buildingsOk },
    at: now.toISOString(),
  };
}

/** financeFly over the world's sessions (Bank.fly). */
export function townFly(repos: Repos, desks: FlyInputs["desks"], townOnFly: boolean, o: { capUsdPerDay?: number | null; windowDays?: number } = {}, now = new Date()): FinanceFly {
  return financeFly({
    sessions: repos.sessions.all(),
    assignments: repos.assignments.all(),
    agents: repos.agents.all(),
    buildings: repos.buildings.all(),
    desks, townOnFly, ...o,
  }, now);
}
