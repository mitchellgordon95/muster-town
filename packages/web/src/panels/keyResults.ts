/**
 * Pure helpers for the board's key-results view (goal-directed buildings, docs/waterfall.md §5): the same numbers
 * and statuses as core's `keyResultsBlock` in the desk brief, so the web and the prompt agree.
 */
import type { GrantView, KeyResultStatus } from "@muster-town/schema";
import type { GoalKeyResult } from "../api";
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

/** A board row: a goal key result and the live grant working on it (null = open for exploration). */
export interface KeyResultRow { kr: GoalKeyResult; grant: GrantView | null }

/**
 * The board's rows in goal order, each key result with its live grant, plus the live grants that name no key result
 * (pre-032 grants, shown after the list so their spend stays visible). Same reading as core's `keyResultsBlock`.
 */
export function keyResultRows(board: { keyResults: GoalKeyResult[]; grants: GrantView[] }): { rows: KeyResultRow[]; orphans: GrantView[] } {
  const grants = new Map(board.grants.map((g) => [g.id, g]));
  const rows = board.keyResults.map((kr) => ({ kr, grant: (kr.grantId && grants.get(kr.grantId)) || null }));
  const named = new Set(board.keyResults.map((k) => k.grantId).filter(Boolean));
  return { rows, orphans: board.grants.filter((g) => !named.has(g.id)) };
}

/** "No funded grant: open for exploration", or the grant's state as the brief says it. */
export function krFundingLine(grant: GrantView | null): string {
  return grant ? grantStateLine(grant) : "No funded grant: open for exploration";
}

/** The human-readable status, "not started" for "not-started". */
export const krStatusLabel = (s: KeyResultStatus) => s.replace(/-/g, " ");

/** The statuses a holder may set: `fund` holders judge met / missed; managers (and `manage` holders) go up to claimed. */
export const KR_STATUSES: KeyResultStatus[] = ["not-started", "on-track", "at-risk", "claimed", "met", "missed"];
export function settableStatuses(canFund: boolean): KeyResultStatus[] {
  return canFund ? KR_STATUSES : KR_STATUSES.filter((s) => s !== "met" && s !== "missed");
}

/** The short blocked label for a building's panel, map sign and the Town Hall in-tray. */
export const BLOCKED_LABEL = "Blocked: no key results";
/** Who unblocks a blocked building, and how. */
export const UNBLOCK_LINE = "A human unblocks it by writing the goal's key results in Building → Settings → Key results; the manager drafts them in a rollup or the 1:1.";

/** The blocked label when a goal-directed building is blocked (the server's `blockedAt`), else null. */
export function blockedLabel(b: { kind: string; budgetMode: string; blockedAt?: string | null }): string | null {
  return b.kind !== "town-hall" && b.budgetMode === "goal-directed" && b.blockedAt ? BLOCKED_LABEL : null;
}

/** Why a proposal can't be funded yet (it names no goal key result), or null when it can. */
export function unfundableReason(g: Pick<GrantView, "status" | "keyResult">): string | null {
  return g.status === "proposed" && !g.keyResult ? "It names no goal key result, so it can't be funded: write the goal's key results, then counter it so the manager names one." : null;
}
