/**
 * The daily cache-miss check (gr_lwgus14rd2 step 2, kr_f49co6lg51): a session layout that re-writes its prompt prefix
 * (docs/prompt-caching.md) shows up as cache writes, so once a session of the UTC day ends the runtime asks, per session
 * purpose × model over the day's ended sessions:
 * - the 1-hour cache-write share of the group's list-price cost (`sessionKindUsd`, the Bank's per-kind pricing) passes
 *   `CACHE_MISS_SHARE`, or
 * - a session's first turn wrote more to the cache than it read: the first `assistant` record's `usage` in its stored
 *   transcript (the SDK JSONL, `Transcripts`); a session with no transcript has no first-turn signal.
 * Either raises one `system` event `alert: cache-miss` per purpose per UTC day (the events log is the "already fired"
 * memory); the HUD shows it for a day. Read-only over sessions and transcripts: it writes no Bank row.
 */
import { brotliDecompressSync } from "node:zlib";
import type { Session, TokenCounts } from "@muster-town/schema";
import { utcDay } from "./drift.ts";
import { sessionKindUsd } from "./finance-lane-kind.ts";
import type { World } from "./world.ts";

/** the alert threshold: the 1-hour cache-write share of a purpose × model's cost over the day (KR kr_f49co6lg51) */
export const CACHE_MISS_SHARE = 0.2;
/** how many session ids an alert names (the biggest 1-hour writers first); `sessions` still counts them all */
const MAX_IDS = 10;
const TEXT_PREFIX = "Cache miss:";

/** What a session's first turn did with the cache: tokens read from it and written to it. */
export interface FirstTurn { cacheRead: number; cacheWrite: number }

/** The first main-thread `assistant` record's usage in an SDK JSONL transcript, or null when there is none. */
export function firstTurnUsage(jsonl: string): FirstTurn | null {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let r: { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, unknown> } };
    try { r = JSON.parse(line); } catch { continue; }
    const u = r.type === "assistant" && !r.isSidechain ? r.message?.usage : undefined;
    if (!u) continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  }
  return null;
}

type CheckSession = Pick<Session, "id" | "purpose" | "model" | "byModel"> & Partial<TokenCounts>;

interface CacheMissAlert {
  day: string;
  purpose: Session["purpose"];
  /** the model of the group that crossed (the costliest one when several of the purpose's models did) */
  model: string;
  /** that group's 1-hour cache-write dollars / its dollars, 0–1 (4 decimals) */
  share: number;
  usd: number;
  sessions: number;
  /** what crossed: the share, a first turn that wrote more than it read, or both */
  reasons: ("share" | "first-turn")[];
  /** the sessions it saw: first-turn offenders first, then the biggest 1-hour writers (at most 10) */
  sessionIds: string[];
  firstTurn: { sessionId: string; cacheRead: number; cacheWrite: number }[];
}

/**
 * Pure: the day's ended sessions → at most one alert per purpose. `firstTurnOf` gives a session's first-turn cache
 * usage (undefined/null = unknown, no signal). `skip` = purposes already alerted today (their transcripts aren't read).
 */
export function cacheMissCheck(sessions: CheckSession[], firstTurnOf: (id: string) => FirstTurn | null | undefined, day: string, skip: ReadonlySet<string> = new Set()): CacheMissAlert[] {
  const groups = new Map<string, { purpose: Session["purpose"]; model: string; usd: number; w1h: number; rows: { id: string; w1h: number }[] }>();
  for (const s of sessions) {
    if (skip.has(s.purpose)) continue;
    const k = sessionKindUsd(s);
    const usd = k.input + k.output + k.cacheRead + k.cacheWrite5m + k.cacheWrite1h;
    const key = `${s.purpose}\u0000${s.model}`;
    const g = groups.get(key) ?? { purpose: s.purpose, model: s.model, usd: 0, w1h: 0, rows: [] };
    g.usd += usd; g.w1h += k.cacheWrite1h; g.rows.push({ id: s.id, w1h: k.cacheWrite1h });
    groups.set(key, g);
  }
  const crossed: CacheMissAlert[] = [];
  for (const g of groups.values()) {
    const share = g.usd > 0 ? g.w1h / g.usd : 0;
    const firstTurn = g.rows.flatMap((r) => {
      const f = firstTurnOf(r.id);
      return f && f.cacheWrite > f.cacheRead ? [{ sessionId: r.id, ...f }] : [];
    });
    const reasons = [...(share > CACHE_MISS_SHARE ? ["share" as const] : []), ...(firstTurn.length ? ["first-turn" as const] : [])];
    if (!reasons.length) continue;
    const biggest = [...g.rows].sort((a, b) => b.w1h - a.w1h).map((r) => r.id);
    const sessionIds = [...new Set([...firstTurn.map((f) => f.sessionId), ...biggest])].slice(0, MAX_IDS);
    crossed.push({ day, purpose: g.purpose, model: g.model, share: Math.round(share * 1e4) / 1e4, usd: Math.round(g.usd * 100) / 100, sessions: g.rows.length, reasons, sessionIds, firstTurn });
  }
  // one per purpose: the costliest crossing group
  const out = new Map<string, CacheMissAlert>();
  for (const a of crossed.sort((x, y) => y.usd - x.usd)) if (!out.has(a.purpose)) out.set(a.purpose, a);
  return [...out.values()];
}

/** The one line a human reads in the HUD and the event log. */
function cacheMissText(a: CacheMissAlert): string {
  const why = [
    a.reasons.includes("share") ? `1 h cache writes were ${Math.round(a.share * 100)}% of today's cost (alert above ${Math.round(CACHE_MISS_SHARE * 100)}%)` : null,
    a.firstTurn.length ? `${a.firstTurn.length} first turn${a.firstTurn.length === 1 ? " wrote more to the cache than it" : "s wrote more to the cache than they"} read` : null,
  ].filter(Boolean).join("; ");
  return `${TEXT_PREFIX} ${a.purpose} sessions on ${a.model}: ${why}; ${a.sessions} session${a.sessions === 1 ? "" : "s"}: ${a.sessionIds.join(", ")}`;
}

/** Purposes already alerted on `day` (the events log is the memory: no table, no marker). */
function cacheMissAlerted(world: World, day: string): Set<string> {
  const evs = world.events.list({ types: ["system"], from: `${day}T00:00:00.000Z`, textLike: `${TEXT_PREFIX}%`, limit: 100 });
  return new Set(evs.filter((e) => e.payload.alert === "cache-miss" && e.payload.day === day).map((e) => String(e.payload.purpose)));
}

/** A stored transcript's first-turn usage (decompressed whole: brotli of a few MB at most), or null. */
export function storedFirstTurn(world: World, sessionId: string): FirstTurn | null {
  const raw = world.transcripts.read(sessionId);
  if (!raw) return null;
  try { return firstTurnUsage(brotliDecompressSync(raw).toString("utf8")); } catch { return null; }
}

/**
 * Check the UTC day of `now` and append one `alert: cache-miss` event per purpose that crossed and wasn't alerted yet
 * today. `firstTurnOf` defaults to reading the stored transcript (the runtime passes a memoized one). → the new alerts.
 */
export function checkCacheMiss(world: World, now: Date, firstTurnOf: (id: string) => FirstTurn | null | undefined = (id) => storedFirstTurn(world, id)): CacheMissAlert[] {
  const day = utcDay(now);
  const skip = cacheMissAlerted(world, day);
  const sessions = world.sessions.where("status != 'running' AND endedAt >= ?", [`${day}T00:00:00.000Z`]);
  const alerts = cacheMissCheck(sessions, firstTurnOf, day, skip);
  for (const a of alerts) world.events.append({ type: "system", text: cacheMissText(a), payload: { alert: "cache-miss", ...a } });
  return alerts;
}
