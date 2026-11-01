/** Number formatting shared by panels and the map overlay. */

/** The stoplight's label (board row, map banner tooltip): green Running, yellow Partly blocked, red Blocked. */
export function stoplightLabel(light: "green" | "yellow" | "grey"): string {
  return light === "green" ? "Running" : light === "yellow" ? "Held at a checkpoint" : "No funded grant";
}

/**
 * When a schedule runs next (or parked work resumes), in the viewer's time and in UTC: "Thu 29 Oct, 16:00 your
 * time · 20:00 UTC"; just the UTC part when the viewer is on UTC. `now` decides whether the day is shown ("today").
 */
export function runsAtLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const hm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const utc = `${hm(d.getUTCHours(), d.getUTCMinutes())} UTC`;
  const sameUtcDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const utcDay = sameUtcDay ? "" : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}, `;
  if (d.getTimezoneOffset() === 0) return `${utcDay}${utc}`;
  const sameDay = d.toDateString() === now.toDateString();
  const day = sameDay ? "" : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, `;
  return `${day}${hm(d.getHours(), d.getMinutes())} your time · ${utcDay}${utc}`;
}

/** A schedule's repeat: "every 6 h", "daily 08:00, 20:00 UTC", "once" (as core's describeRepeat). */
export function repeatLabel(s: { everyMinutes: number | null; dailyAt: string[] | null; maxRuns?: number | null }): string {
  const times = s.maxRuns ? `, ${s.maxRuns} time${s.maxRuns === 1 ? "" : "s"}` : "";
  if (s.everyMinutes) return (s.everyMinutes % 60 ? `every ${s.everyMinutes} min` : `every ${s.everyMinutes / 60} h`) + times;
  if (s.dailyAt?.length) return `daily ${s.dailyAt.join(", ")} UTC${times}`;
  return "once";
}

/** The schedule board's hover title: what the board is and what a click does. */
export function scheduleTipTitle(building: string, n: number, open: string): string {
  return n ? `${building} schedule: ${n} timed job${n === 1 ? "" : "s"} (whoever is around takes each run; ${open} for the list)`
    : `${building} schedule: nothing scheduled (${open} to open the Schedule tab)`;
}
/** One schedule on the board's hover: title, next run (your time · UTC), repeat, paused. */
export function scheduleTipRow(x: { title: string; nextRunAt: string | null; everyMinutes: number | null; dailyAt: string[] | null; maxRuns?: number | null; paused?: boolean }): string {
  return `${x.title}: ${x.paused ? "paused, " : ""}next ${x.nextRunAt ? runsAtLabel(x.nextRunAt) : "—"}, ${repeatLabel(x)}`;
}

/** The Bank's unit (step 3): every token figure is adjusted output tokens; this is its short label. */
export const ADJ = "adj. tokens";
/** What the unit means, for a hover title. */
export const ADJ_HINT = "Adjusted output tokens: output + input, cache reads and cache writes (5m, 1h) weighted by their list price, counted in Opus 5.5 output tokens ($20 per million): a Fable 5.1 output token counts 2.5, a Haiku 5.5 one 0.025. 1 adj. token ≈ 30 raw tokens on Opus.";

const COUNT_LABELS = [["input", "input"], ["output", "output"], ["cacheRead", "cache read"], ["cacheWrite5m", "cache write 5m"], ["cacheWrite1h", "cache write 1h"]] as const;

/** A hover title for an adjusted figure: the unit, then the five counters behind it and their raw total (when known). */
export function breakdownTitle(counts?: Partial<Record<(typeof COUNT_LABELS)[number][0], number>> | null): string {
  if (!counts) return ADJ_HINT;
  const parts = COUNT_LABELS.map(([k, label]) => `${label} ${(counts[k] ?? 0).toLocaleString("en-US")}`);
  const raw = COUNT_LABELS.reduce((s, [k]) => s + (counts[k] ?? 0), 0);
  return `${ADJ_HINT}\n${parts.join(" · ")} · raw ${raw.toLocaleString("en-US")}`;
}

/** 1234 → "1k", 2_500_000 → "2.5M", 4_000_000 → "4M", 50_000_000 → "50M". */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** ms → "45s", "4.5m", "31m", "1.2h" (one decimal under 10 of a unit). */
export function fmtMs(ms: number): string {
  const one = (v: number, u: string) => `${v < 10 ? Number(v.toFixed(1)) : Math.round(v)}${u}`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return one(ms / 60_000, "m");
  return one(ms / 3_600_000, "h");
}

/**
 * A session's performance line (gr_uhh6u39vv9): "perf-1x · wall 31m · cpu 4.5m · steal 3%", steal as a share of cpu + steal
 * (one decimal under 10%). The desk size and cpu/steal are left out when not recorded (a host session, an older desk); null = nothing measured.
 */
export function fmtPerf(p: { wallMs?: number | null; cpuMs?: number | null; stealMs?: number | null; cpuKind?: "shared" | "performance" | null; cpus?: number | null }): string | null {
  if (p.wallMs == null) return null;
  const parts = [`wall ${fmtMs(p.wallMs)}`];
  if (p.cpuKind && p.cpus) parts.unshift(`${p.cpuKind === "shared" ? "shared" : "perf"}-${p.cpus}x`);
  if (p.cpuMs != null) parts.push(`cpu ${fmtMs(p.cpuMs)}`);
  if (p.cpuMs != null && p.stealMs != null) {
    const pct = p.cpuMs + p.stealMs > 0 ? (100 * p.stealMs) / (p.cpuMs + p.stealMs) : 0;
    parts.push(`steal ${pct < 10 ? Number(pct.toFixed(1)) : Math.round(pct)}%`);
  }
  return parts.join(" · ");
}

/** Token count → the "M tokens" input's text: 275_000_000 → "275", 500_000 → "0.5". */
export function toMillions(n: number): string {
  return String(Number((n / 1e6).toFixed(6)));
}

/** The "M tokens" input's text → a whole token count ("1.25" → 1_250_000); NaN when it isn't a number. */
export function fromMillions(s: string): number {
  const t = s.replace(/[,_\s]/g, "");
  return t === "" ? NaN : Math.round(Number(t) * 1e6);
}

/** Tokens already claimed town-wide (GET /api/bank `free`): open reservations + open proposals' asks + funded grants' remaining. */
export function claimedTokens(f: { reservedTokens: number; openAsksTokens: number; fundedRemainingTokens: number }): number {
  return f.reservedTokens + f.openAsksTokens + f.fundedRemainingTokens;
}
