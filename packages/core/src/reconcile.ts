/**
 * Daily funding reconciliation (post-mortem 2026-10-30 "still open" 1, asked for in 1:1 mt_x40qq8poc3). Once a day,
 * for the UTC day before, the Bank checks that every session ran on a credential it lists, that no desk claimed a
 * different funding than it was handed, and (with the org's Admin API key in the collective secrets, `ANTHROPIC_ADMIN_KEY`)
 * that the Console's spend for the day is explained by the Bank's api-key spend. Anything unexplained is an in-town
 * alert: a `system` event with `alert: funding-reconcile` (the HUD shows it for a day). Pure over the world; the runtime
 * fetches the Console report and calls `reconcileFunding`.
 */
import type { World } from "./world.ts";

/** The collective secret (Town Hall → Secrets) holding the org's Admin API key (`sk-ant-admin…`) for the Console cost report. */
export const ADMIN_KEY_SECRET = "ANTHROPIC_ADMIN_KEY";
/** Console spend the Bank's api-key spend doesn't explain is tolerated up to the larger of this and 10% of the Bank's figure (list vs billed price). */
export const RECONCILE_TOLERANCE_USD = 1;
const DAY_MS = 86_400_000;

/** The Console's cost for the day (USD), or why it couldn't be read. */
export type ConsoleCost = { usd: number } | { error: string } | null;

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
  /** the Console's USD for the day; null = no Admin key, or the report failed (`consoleError`) */
  consoleUsd: number | null;
  consoleError: string | null;
  /** Console spend past the Bank's api-key spend and the tolerance; null without a Console figure */
  unexplainedUsd: number | null;
  ok: boolean;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Whether the day's reconciliation already ran (one `system` event per day, "Bank reconciliation for <day>…"). */
export function reconciled(world: World, day: string): boolean {
  return world.events.list({ types: ["system"], textLike: `Bank reconciliation for ${day}%`, limit: 1 }).length > 0;
}

/**
 * Reconcile one UTC day and log the result (`system` event; `alert: funding-reconcile` when something is unexplained).
 * `console`: the Console's cost for the day from the Admin API (the runtime fetches it), an error, or null without a key.
 */
export function reconcileFunding(world: World, day: string, console: ConsoleCost): ReconcileResult {
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
  const consoleUsd = console && "usd" in console ? round(console.usd) : null;
  const consoleError = console && "error" in console ? console.error : null;
  const tolerance = Math.max(RECONCILE_TOLERANCE_USD, 0.1 * apiKeyUsd);
  const unexplainedUsd = consoleUsd === null ? null : round(Math.max(0, consoleUsd - apiKeyUsd - tolerance));
  const ok = unlisted.length === 0 && mismatches === 0 && !(unexplainedUsd && unexplainedUsd > 0);
  const result: ReconcileResult = { day, sessions: sessions.length, subscriptionUsd: round(subscriptionUsd), apiKeyUsd: round(apiKeyUsd), donorKeyUsd: round(donorKeyUsd), unlisted, mismatches, consoleUsd, consoleError, unexplainedUsd, ok };
  const consoleLine = consoleUsd !== null ? `Console $${consoleUsd.toFixed(2)}` : consoleError ? `Console report failed (${consoleError.slice(0, 120)})` : `no ${ADMIN_KEY_SECRET} secret, Console not checked`;
  const problems = [
    unexplainedUsd ? `$${unexplainedUsd.toFixed(2)} of Console spend the Bank cannot account for` : null,
    unlisted.length ? `${unlisted.length} api-key session(s) on a key the Bank does not list` : null,
    mismatches ? `${mismatches} desk(s) claimed a funding they were not handed` : null,
  ].filter((p): p is string => !!p);
  const text = `Bank reconciliation for ${day}: ${sessions.length} sessions, Bank api-key $${result.apiKeyUsd.toFixed(2)}, subscription $${result.subscriptionUsd.toFixed(2)}, donor keys $${result.donorKeyUsd.toFixed(2)}; ${consoleLine}${problems.length ? `. ALERT: ${problems.join("; ")}` : ". OK"}`;
  world.events.append({ type: "system", text, payload: { reconcile: day, ...result, ...(ok ? {} : { alert: "funding-reconcile" }) } });
  return result;
}
