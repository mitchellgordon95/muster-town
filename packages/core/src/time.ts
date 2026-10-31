/**
 * Time in words: the one place an ISO time becomes text for an agent or a human (1:1 mt_3jtclcoxl2, Mitchell:
 * "we might need a subsystem for time usage").
 *
 * Agents have no clock: a session's brief carries the server's clock at its start (`clockLine`), and every time an
 * agent writes down must be one it read from the server (an event, a doc's updatedAt, /api/health, `date` on its
 * desk), never a guess. Humans can't read UTC stamps against their own clock, so text for a human says how long ago
 * (`fromNow`), and text for an agent says the server-read stamp with the duration beside it (`whenFor`). `guessedTimes`
 * is the lint: it finds hand-written approximate stamps ("~20:50Z", "about 21:25 UTC", "~now") in a page or report, and
 * `write`, `submit_report` and meeting `speak` warn on them.
 */

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** "2026-10-31 20:26 UTC": the server-read stamp, the only form agents and event texts write a clock time in. */
export function stamp(iso: string | number | Date): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "just now" | "5 min ago" | "in 5 min" | "3 h ago" | "in 2 d": a duration from `now`, the form a human reads. */
export function fromNow(iso: string | number | Date, now: number | Date = Date.now()): string {
  const ms = new Date(iso).getTime() - new Date(now).getTime();
  const abs = Math.abs(ms);
  if (abs < MIN) return "just now";
  const n = abs < H ? `${Math.floor(abs / MIN)} min` : abs < D ? `${Math.floor(abs / H)} h` : `${Math.floor(abs / D)} d`;
  return ms < 0 ? `${n} ago` : `in ${n}`;
}

/** "4.1 h", "2.3 d", "12 min": how long something has waited since `sinceIso` (the review deck's form; "" when null). */
export function waitedFor(sinceIso: string | null, now: Date): string {
  if (!sinceIso) return "";
  const ms = Math.max(0, now.getTime() - Date.parse(sinceIso));
  if (ms < H) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < 48 * H) return `${(ms / H).toFixed(1)} h`;
  return `${(ms / D).toFixed(1)} d`;
}

/**
 * A time as text for its reader: a human gets the duration from now ("25 min ago"); an agent gets the server-read
 * stamp with the duration beside it ("2026-10-31 20:26 UTC (25 min ago)"), so it can quote the stamp and still reason
 * about how long ago that was.
 */
export function whenFor(iso: string | number | Date, reader: "human" | "agent", now: number | Date = Date.now()): string {
  return reader === "human" ? fromNow(iso, now) : `${stamp(iso)} (${fromNow(iso, now)})`;
}

/** The line every session brief and 1:1 opens with: the server's clock, and the rule that follows from having none. */
export function clockLine(now: number | Date = Date.now()): string {
  return `Clock: it is ${stamp(now)} as this starts (the server's clock; you have none of your own, so time passes without you noticing). Write down only times you read from the server (an event's ts, a doc's updatedAt, /api/health, \`date\` on your desk), never a guessed "~HH:MM UTC"; for a human, say how long ago or how long from now ("20 min ago", "in about an hour"), not a UTC stamp.`;
}

// a clock time with an approximation mark: "~20:50Z", "≈ 21:25 UTC", "about 20:40Z", "around 9:05 UTC", "circa 20:00Z";
// also a bare "~now". A stamp without a mark ("2026-10-31 20:26 UTC", "20:26Z") may be read from the server, so it passes.
const GUESSED = /(?:~|≈|\b(?:about|around|circa|approx\.?|approximately|roughly)\s)\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z\b|UTC\b)|~\s*now\b/gi;

/** Hand-written approximate clock times in `text`, as written ("~20:50Z", "about 21:25 UTC", "~now"); [] when none. */
export function guessedTimes(text: string): string[] {
  return Array.from(text.matchAll(GUESSED), (m) => m[0].trim());
}

/** The warning `write`, `submit_report` and meeting `speak` attach when a body carries guessed times; null when it doesn't. */
export function guessedTimesWarning(text: string): string | null {
  const found = guessedTimes(text);
  if (!found.length) return null;
  const shown = found.slice(0, 4).map((s) => `"${s}"`).join(", ") + (found.length > 4 ? `, … (${found.length} in all)` : "");
  return `Guessed time${found.length === 1 ? "" : "s"} ${shown}: you have no clock, so a time you didn't read from the server (an event's ts, a doc's updatedAt, /api/health, \`date\` on your desk) is a guess, often off by an hour. Write the server-read stamp as "YYYY-MM-DD HH:MM UTC", or a duration ("20 min ago"), or leave the time out.`;
}
