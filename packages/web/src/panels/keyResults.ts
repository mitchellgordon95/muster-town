/**
 * Pure helpers for the board's key-results view (goal-directed buildings, docs/waterfall.md §5): the same numbers
 * and statuses as core's `keyResultsBlock` in the desk brief, so the web and the prompt agree.
 */
import type { GrantView, KeyResultStatus } from "@muster-town/schema";
import { fmtTokens } from "../format";

/** Share of `total` spent, 0..1 (0 when there's no total). */
export function spentShare(spent: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, spent / total)) : 0;
}

/** "1M / 2M tokens (52%)", the grant's bar label. */
export function grantSpendLine(g: Pick<GrantView, "spentTokens" | "grantTokens">): string {
  const total = g.grantTokens ?? 0;
  return `${fmtTokens(g.spentTokens)} / ${fmtTokens(total)} tokens (${Math.round(spentShare(g.spentTokens, total) * 100)}%)`;
}

/** "Funded" or "At checkpoint: its sessions are held", as the brief says it. */
export function grantStateLine(g: Pick<GrantView, "status">): string {
  return g.status === "checkpoint" ? "At checkpoint: its sessions are held until a human decides" : "Funded";
}

/** "1.2M / 3M tokens today", the exploration meter's label. */
export function explorationLine(e: { allowanceTokens: number; spentTodayTokens: number }): string {
  return `${fmtTokens(e.spentTodayTokens)} / ${fmtTokens(e.allowanceTokens)} tokens today`;
}

/** One line for the open proposal; it's decided in the Town Hall in-tray, never on the board. */
export function proposalLine(p: Pick<GrantView, "objective" | "status" | "askTokens">): string {
  return p.status === "countered"
    ? `Proposal "${p.objective}" was countered: the manager revises it and proposes again.`
    : `Proposal "${p.objective}" (asks ${fmtTokens(p.askTokens)} tokens) is waiting for a human in the Town Hall in-tray.`;
}

/** Pill tone per key-result status: met green, missed red, claimed / at risk amber, the rest neutral. */
export function krTone(s: KeyResultStatus): string {
  return s === "met" ? "ok" : s === "missed" ? "bad" : s === "claimed" || s === "at-risk" ? "warn" : "";
}
