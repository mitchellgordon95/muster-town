/**
 * Daily funding reconciliation (post-mortem 2026-10-30 "still open" 1, asked for in 1:1 mt_x40qq8poc3). Once a day,
 * for the UTC day before, the Bank checks itself against its own session records: every api-key session ran on a
 * credential the Bank lists, and no desk claimed a different funding than it was handed. Anything unexplained is an
 * in-town alert: a `system` event with `alert: funding-reconcile` (the HUD shows it for a day). Pure over the world;
 * the runtime calls `reconcileFunding` once per day. The check never leaves the town: it reads no Anthropic Console
 * or Admin API and needs no secret (Mitchell, 2026-10-31, reply to dc_wc1aa3wi9i: the project does not touch anyone's
 * Console).
 */
import type { World } from "./world.ts";

const DAY_MS = 86_400_000;

export interface ReconcileResult {
  day: string;
  /** ended sessions of the day, and how their cost splits by the credential handed out */
  sessions: number;
  subscriptionUsd: number;
  apiKeyUsd: number;
  donorKeyUsd: number;
  /** api-key sessions whose `credentialInputId` names no live api-key input, or none at all once the Bank had started recording it */
  unlisted: string[];
  /** desks that claimed a different funding than they were handed (`alert: funding-mismatch` events of the day) */
  mismatches: number;
  ok: boolean;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The `meta` marker: the latest UTC day the reconciliation is done for (ran, or had no sessions to check). */
export const RECONCILED_MARKER = "reconciledThrough";

/** Remember that `day` is done (the marker only moves forward). */
export function markReconciled(world: World, day: string): void {
  const cur = world.town.marker(RECONCILED_MARKER);
  if (!cur || cur < day) world.town.setMarker(RECONCILED_MARKER, day);
}

/**
 * Whether the day's reconciliation already ran. The runtime asks every tick, so it reads the `meta` marker; only when
 * the marker is behind does it look for the day's `system` event ("Bank reconciliation for <day>…", a scan of every
 * system event) and, if found, moves the marker so the scan runs at most once (post-mortem 2026-10-31 suggestion 3).
 */
export function reconciled(world: World, day: string): boolean {
  const through = world.town.marker(RECONCILED_MARKER);
  if (through && through >= day) return true;
  if (!world.events.list({ types: ["system"], textLike: `Bank reconciliation for ${day}%`, limit: 1 }).length) return false;
  markReconciled(world, day);
  return true;
}

/** Reconcile one UTC day and log the result (`system` event; `alert: funding-reconcile` when something is unexplained). */
export function reconcileFunding(world: World, day: string): ReconcileResult {
  const from = `${day}T00:00:00.000Z`, to = new Date(Date.parse(from) + DAY_MS).toISOString();
  const sessions = world.sessions.where("status != 'running' AND endedAt >= ? AND endedAt < ?", [from, to]);
  let subscriptionUsd = 0, apiKeyUsd = 0, donorKeyUsd = 0;
  const unlisted: string[] = [];
  // the Bank started recording the credential it handed out (migration 062) at the first session that has one
  const recordingSince = world.sessions.first("credentialInputId IS NOT NULL", [], "ORDER BY startedAt, rowid")?.startedAt ?? null;
  for (const s of sessions) {
    if (s.funding === "donor-key") donorKeyUsd += s.costUsd;
    else if (s.funding === "api-key") {
      apiKeyUsd += s.costUsd;
      const input = s.credentialInputId ? world.bank.input(s.credentialInputId) : undefined;
      const listed = input ? input.source === "api-key" : !(recordingSince && s.startedAt >= recordingSince);
      if (!listed) unlisted.push(s.id);
    } else subscriptionUsd += s.costUsd;
  }
  const mismatches = world.events.list({ types: ["system"], from, limit: 5000 }).filter((e) => e.ts < to && e.payload.alert === "funding-mismatch").length;
  const ok = unlisted.length === 0 && mismatches === 0;
  const result: ReconcileResult = { day, sessions: sessions.length, subscriptionUsd: round(subscriptionUsd), apiKeyUsd: round(apiKeyUsd), donorKeyUsd: round(donorKeyUsd), unlisted, mismatches, ok };
  const problems = [
    unlisted.length ? `${unlisted.length} api-key session(s) on a key the Bank does not list` : null,
    mismatches ? `${mismatches} desk(s) claimed a funding they were not handed` : null,
  ].filter((p): p is string => !!p);
  const text = `Bank reconciliation for ${day}: ${sessions.length} sessions, Bank api-key $${result.apiKeyUsd.toFixed(2)}, subscription $${result.subscriptionUsd.toFixed(2)}, donor keys $${result.donorKeyUsd.toFixed(2)}${problems.length ? `. ALERT: ${problems.join("; ")}` : ". OK"}`;
  world.events.append({ type: "system", text, payload: { reconcile: day, ...result, ...(ok ? {} : { alert: "funding-reconcile" }) } });
  markReconciled(world, day);
  return result;
}
