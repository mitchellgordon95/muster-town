/**
 * Pure helpers for the building panel's Goals and Grants tabs and the Town Hall in-tray (goal-directed buildings): the
 * same numbers and statuses as core's `keyResultsBlock` in the desk brief, so the web and the prompt agree.
 */
import type { GrantView, KeyResultStatus } from "@muster-town/schema";
import type { FinanceSpend, ObjectiveTree, ObjectiveView, SpendNode } from "../api";
import { ADJ, fmtTokens } from "../format";

/** Share of `total` spent, 0..1 (0 when there's no total). */
export function spentShare(spent: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, spent / total)) : 0;
}

/** "1M / 2M tokens (52%)", the grant's bar label. */
export function grantSpendLine(g: Pick<GrantView, "spentTokens" | "grantTokens">): string {
  const total = g.grantTokens ?? 0;
  return `${fmtTokens(g.spentTokens)} / ${fmtTokens(total)} ${ADJ} (${Math.round(spentShare(g.spentTokens, total) * 100)}%)`;
}

/** Pill tone per key-result status: met green, missed red, claimed / at risk amber, the rest neutral. */
export function krTone(s: KeyResultStatus): string {
  return s === "met" ? "ok" : s === "missed" ? "bad" : s === "claimed" || s === "at-risk" ? "warn" : "";
}

/** "Moves Trust · 2026-Q4", an objective's subtitle. */
export function objectiveLine(o: Pick<ObjectiveView, "kpiName" | "horizon">): string {
  return `${o.kpiName ? `Moves ${o.kpiName}` : "Names no KPI yet"} · ${o.horizon}`;
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
export const UNBLOCK_LINE = "A human unblocks it by writing the goal's key results in Building → Goals → Edit, or the manager does with set_key_result once a meeting or the 1:1 settles them.";

/** The blocked label when a lab is blocked (the server's `blockedAt`), else null. */
export function blockedLabel(b: { kind: string; blockedAt?: string | null }): string | null {
  return b.kind !== "town-hall" && b.blockedAt ? BLOCKED_LABEL : null;
}

/** Why a proposal can't be funded yet (it names no goal key result), or null when it can. */
export function unfundableReason(g: Pick<GrantView, "status" | "keyResult">): string | null {
  return g.status === "proposed" && !g.keyResult ? "It names no goal key result, so it can't be funded: write the goal's key results, then counter it so the manager names one." : null;
}

/** "Written by Pix, edited by Mitchell" for a goal key result (a manager writes its own building's too); null when unknown (older ones). */
export function krAuthorLine(k: { createdByName?: string | null; editedByName?: string | null }): string | null {
  const by = k.createdByName ?? null, ed = k.editedByName ?? null;
  if (!by) return ed ? `Edited by ${ed}` : null;
  return ed && ed !== by ? `Written by ${by}, edited by ${ed}` : `Written by ${by}`;
}

// ---------- the building panel's Goals and Grants tabs ----------

/** A key result's grant state in one word: a live (funded or checkpoint) grant names it, an open proposal does, or neither. */
export type KrGrantWord = "funded" | "proposed" | "open";
const LIVE = new Set<GrantView["status"]>(["funded", "checkpoint"]);
const OPEN_PROPOSAL = new Set<GrantView["status"]>(["proposed", "countered"]);
export function krGrantWord(krId: string, grants: Pick<GrantView, "keyResultId" | "status">[]): KrGrantWord {
  const mine = grants.filter((g) => g.keyResultId === krId);
  return mine.some((g) => LIVE.has(g.status)) ? "funded" : mine.some((g) => OPEN_PROPOSAL.has(g.status)) ? "proposed" : "open";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Overview's Goals line: "3 objectives, 5 key results, 2 funded". */
export function goalsSummary(tree: ObjectiveTree, grants: Pick<GrantView, "keyResultId" | "status">[]): string {
  const krs = [...tree.objectives.flatMap((o) => o.keyResults), ...tree.unsorted];
  const funded = krs.filter((k) => krGrantWord(k.id, grants) === "funded").length;
  return `${plural(tree.objectives.length, "objective")}, ${plural(krs.length, "key result")}, ${funded} funded`;
}

/** The Grants tab's order: open proposals (oldest first), then funded (newest funding first), then checkpoint / closed / rejected (latest first). Drafts aren't grants yet. */
export function grantGroups<G extends Pick<GrantView, "status" | "createdAt" | "updatedAt" | "fundedAt">>(grants: G[]): { proposals: G[]; funded: G[]; settled: G[] } {
  const by = (k: (g: G) => string, asc: boolean) => (a: G, b: G) => asc ? k(a).localeCompare(k(b)) : k(b).localeCompare(k(a));
  return {
    proposals: grants.filter((g) => OPEN_PROPOSAL.has(g.status)).sort(by((g) => g.createdAt, true)),
    funded: grants.filter((g) => g.status === "funded").sort(by((g) => g.fundedAt ?? g.createdAt, false)),
    settled: grants.filter((g) => g.status === "checkpoint" || g.status === "closed" || g.status === "rejected").sort(by((g) => g.updatedAt, false)),
  };
}

/**
 * The Overview's Grants line: "1 proposal, 3 funded", plus ", 2 closed or held" when there are any. Given the goal's key
 * result ids (`krIds`), funded grants on key results outside them (named before the building moved to its goal) are
 * called out, so the line can't read as contradicting the Goals line's "n funded" (which counts only the goal's own).
 */
export function grantsSummary(grants: Pick<GrantView, "keyResultId" | "status" | "createdAt" | "updatedAt" | "fundedAt">[], krIds?: ReadonlySet<string>): string {
  const { proposals, funded, settled } = grantGroups(grants);
  const outside = krIds ? funded.filter((g) => !(g.keyResultId && krIds.has(g.keyResultId))).length : 0;
  const where = outside ? ` (${outside === 1 ? `${funded.length === 1 ? "" : "1 "}on a key result` : `${outside === funded.length ? "all" : outside} on key results`} outside this goal)` : "";
  return `${plural(proposals.length, "proposal")}, ${funded.length} funded${where}${settled.length ? `, ${settled.length} closed or held` : ""}`;
}

/** A grant's step assignments with their spend, from GET /api/finance/spend (building → grant → assignment). */
export function grantSteps(spend: FinanceSpend | null | undefined, buildingId: string, grantId: string): SpendNode[] {
  const b = spend?.rows.find((r) => r.kind === "building" && r.id === buildingId);
  const g = b?.children?.find((r) => r.kind === "grant" && r.id === grantId);
  return (g?.children ?? []).filter((r) => r.kind === "assignment");
}
