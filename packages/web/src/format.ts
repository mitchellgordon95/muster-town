/** Number formatting shared by panels and the map overlay. */

/** The stoplight's label (board row, map banner tooltip): green Running, yellow Partly blocked, red Blocked. */
export function stoplightLabel(light: "green" | "yellow" | "red"): string {
  return light === "green" ? "Running" : light === "yellow" ? "Partly blocked" : "Blocked";
}

/**
 * When a scheduled assignment runs (its `waitFor {after}`), in the viewer's time and in UTC: "Thu 29 Oct, 16:00 your
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

/** The Bank's unit (step 3): every token figure is adjusted output tokens; this is its short label. */
export const ADJ = "adj. tokens";
/** What the unit means, for a hover title. */
export const ADJ_HINT = "Adjusted output tokens: output + input, cache reads and cache writes (5m, 1h) weighted by their list price over the output price. 1 adj. token ≈ 30 raw tokens on Opus, 24 on Fable.";

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

/** Token count → the "M tokens" input's text: 275_000_000 → "275", 500_000 → "0.5". */
export function toMillions(n: number): string {
  return String(Number((n / 1e6).toFixed(6)));
}

/** The "M tokens" input's text → a whole token count ("1.25" → 1_250_000); NaN when it isn't a number. */
export function fromMillions(s: string): number {
  const t = s.replace(/[,_\s]/g, "");
  return t === "" ? NaN : Math.round(Number(t) * 1e6);
}
