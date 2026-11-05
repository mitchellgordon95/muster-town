/**
 * The daily cache-miss check (gr_lwgus14rd2 step 2, kr_f49co6lg51, redefined by Mitchell in 1:1 mt_pr3347g2w2 on
 * 2026-11-05): what matters is a session whose context changes from turn to turn, busting the cached prefix and turning
 * what should be cache reads into cache writes (docs/prompt-caching.md). Per session, from its stored transcript (the SDK
 * JSONL, `Transcripts`), each API call of the main thread is one turn with `cache_read_input_tokens` and
 * `cache_creation_input_tokens`; turn 1 is a cold start and doesn't count. For turns 2+:
 * - a turn's re-write rate = cache_creation / (cache_read + cache_creation): the share of its prefix written fresh;
 * - a turn busts when that rate reaches `BUST_TURN_RATE`; a session busts when more than half of its turns 2+ bust
 *   (at least `MIN_TURNS` of them: shorter sessions carry no signal).
 * Once a session of the UTC day ends, the runtime asks per session purpose: of the day's ended sessions with a signal,
 * what share busts? Above `CACHE_MISS_SHARE` it raises one `system` event `alert: cache-miss` per purpose per UTC day
 * naming the worst sessions (the events log is the "already fired" memory); the HUD shows it for a day. The 1-hour
 * cache-write share of cost is a Spending column, not an alert. Read-only over sessions and transcripts: no Bank row.
 * Live baseline (Bank Transparency's 37 sessions of 11-04/05): turns 2+ re-write 1–14% of their prefix, at most 20%.
 */
import { brotliDecompressSync } from "node:zlib";
import type { Session } from "@muster-town/schema";
import { utcDay } from "./drift.ts";
import type { World } from "./world.ts";

/** a turn busts its prefix when it writes at least this share of it fresh (healthy turns write ≤ 0.2) */
export const BUST_TURN_RATE = 0.5;
/** a session needs this many turns after the first to carry a signal */
export const MIN_TURNS = 2;
/** the alert threshold: the share of a purpose's sessions (with a signal) that bust over the day (KR kr_f49co6lg51) */
export const CACHE_MISS_SHARE = 0.1;
/** how many session ids an alert names (the worst first); `busting` still counts them all */
const MAX_IDS = 10;
const TEXT_PREFIX = "Cache miss:";

/** One API call of a session's main thread: tokens read from the cache and written to it. */
export interface Turn { cacheRead: number; cacheWrite: number }

/**
 * The main-thread turns of an SDK JSONL transcript, in order: one per `message.id` (a call's content blocks repeat its
 * usage; sidechains and junk lines are skipped). Empty when there is none.
 */
export function turnUsage(jsonl: string): Turn[] {
  const seen = new Set<string>();
  const turns: Turn[] = [];
  let anon = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let r: { type?: string; isSidechain?: boolean; message?: { id?: unknown; usage?: Record<string, unknown> } };
    try { r = JSON.parse(line); } catch { continue; }
    const u = r.type === "assistant" && !r.isSidechain ? r.message?.usage : undefined;
    if (!u) continue;
    const id = typeof r.message?.id === "string" && r.message.id ? r.message.id : `#${anon++}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    turns.push({ cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) });
  }
  return turns;
}

/** What a session's turns 2+ did to its prefix. */
interface SessionBust {
  /** turns after the first that read or wrote the cache */
  turns: number;
  /** of those, the turns that re-wrote at least `BUST_TURN_RATE` of their prefix */
  bustTurns: number;
  /** the tokens those busting turns wrote fresh */
  rewritten: number;
  /** more than half of at least `MIN_TURNS` turns bust */
  busts: boolean;
}

/** Pure: a session's turns → whether it busts its prefix (turn 1 is a cold start and never counts). */
export function sessionBust(turns: Turn[]): SessionBust {
  let n = 0, bustTurns = 0, rewritten = 0;
  for (const t of turns.slice(1)) {
    const total = t.cacheRead + t.cacheWrite;
    if (total <= 0) continue;
    n++;
    if (t.cacheWrite / total >= BUST_TURN_RATE) { bustTurns++; rewritten += t.cacheWrite; }
  }
  return { turns: n, bustTurns, rewritten, busts: n >= MIN_TURNS && bustTurns * 2 > n };
}

type CheckSession = Pick<Session, "id" | "purpose">;

interface CacheMissAlert {
  day: string;
  purpose: Session["purpose"];
  /** busting sessions / sessions with a signal, 0–1 (4 decimals) */
  share: number;
  /** the purpose's ended sessions with a signal (a transcript with at least `MIN_TURNS` turns after the first) */
  sessions: number;
  busting: number;
  /** ended sessions with no transcript or too few turns */
  noSignal: number;
  /** the busting sessions, worst first (the biggest share of busting turns, then the most tokens re-written; at most 10) */
  sessionIds: string[];
  worst: ({ sessionId: string } & Omit<SessionBust, "busts">)[];
}

/**
 * Pure: the day's ended sessions → at most one alert per purpose. `turnsOf` gives a session's turns (undefined/null = no
 * transcript). `skip` = purposes already alerted today (their transcripts aren't read).
 */
export function cacheMissCheck(sessions: CheckSession[], turnsOf: (id: string) => Turn[] | null | undefined, day: string, skip: ReadonlySet<string> = new Set()): CacheMissAlert[] {
  const groups = new Map<Session["purpose"], { signal: number; noSignal: number; busting: ({ sessionId: string } & SessionBust)[] }>();
  for (const s of sessions) {
    if (skip.has(s.purpose)) continue;
    const g = groups.get(s.purpose) ?? { signal: 0, noSignal: 0, busting: [] };
    const b = sessionBust(turnsOf(s.id) ?? []);
    if (b.turns < MIN_TURNS) g.noSignal++;
    else { g.signal++; if (b.busts) g.busting.push({ sessionId: s.id, ...b }); }
    groups.set(s.purpose, g);
  }
  const out: CacheMissAlert[] = [];
  for (const [purpose, g] of groups) {
    const share = g.signal > 0 ? g.busting.length / g.signal : 0;
    if (share <= CACHE_MISS_SHARE) continue;
    const worst = g.busting.sort((a, b) => b.bustTurns / b.turns - a.bustTurns / a.turns || b.rewritten - a.rewritten).slice(0, MAX_IDS)
      .map(({ busts: _, ...w }) => w);
    out.push({ day, purpose, share: Math.round(share * 1e4) / 1e4, sessions: g.signal, busting: g.busting.length, noSignal: g.noSignal, sessionIds: worst.map((w) => w.sessionId), worst });
  }
  return out;
}

/** The one line a human reads in the HUD and the event log. */
function cacheMissText(a: CacheMissAlert): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const worst = a.worst.map((w) => `${w.sessionId} (${w.bustTurns} of ${w.turns} turns)`).join(", ");
  return `${TEXT_PREFIX} ${a.busting} of ${a.sessions} ${a.purpose} session${a.sessions === 1 ? "" : "s"} (${pct(a.share)}, alert above ${pct(CACHE_MISS_SHARE)}) re-wrote their prompt prefix on most turns (a turn writing ≥ ${pct(BUST_TURN_RATE)} of its context fresh); worst: ${worst}`;
}

/** Purposes already alerted on `day` (the events log is the memory: no table, no marker). */
function cacheMissAlerted(world: World, day: string): Set<string> {
  const evs = world.events.list({ types: ["system"], from: `${day}T00:00:00.000Z`, textLike: `${TEXT_PREFIX}%`, limit: 100 });
  return new Set(evs.filter((e) => e.payload.alert === "cache-miss" && e.payload.day === day).map((e) => String(e.payload.purpose)));
}

/** A stored transcript's turns (decompressed whole: brotli of a few MB at most), or null without one. */
export function storedTurns(world: World, sessionId: string): Turn[] | null {
  const raw = world.transcripts.read(sessionId);
  if (!raw) return null;
  try { return turnUsage(brotliDecompressSync(raw).toString("utf8")); } catch { return null; }
}

/**
 * Check the UTC day of `now` and append one `alert: cache-miss` event per purpose that crossed and wasn't alerted yet
 * today. `turnsOf` defaults to reading the stored transcript (the runtime passes a memoized one). → the new alerts.
 */
export function checkCacheMiss(world: World, now: Date, turnsOf: (id: string) => Turn[] | null | undefined = (id) => storedTurns(world, id)): CacheMissAlert[] {
  const day = utcDay(now);
  const skip = cacheMissAlerted(world, day);
  const sessions = world.sessions.where("status != 'running' AND endedAt >= ?", [`${day}T00:00:00.000Z`]);
  const alerts = cacheMissCheck(sessions, turnsOf, day, skip);
  for (const a of alerts) world.events.append({ type: "system", text: cacheMissText(a), payload: { alert: "cache-miss", ...a } });
  return alerts;
}
