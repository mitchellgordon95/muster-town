/**
 * Pure helpers for the building panel's Goals and Grants tabs (the Goals tab reads the building's subtree of the one goal tree) and the decision queue (goal-directed buildings): the
 * same numbers and statuses as core's `keyResultsBlock` in the desk brief, so the web and the prompt agree.
 */
import { krStatusWords, type GrantView, type KeyResult, type KeyResultStatus } from "@muster-town/schema";
import type { FinanceSpend, SpendNode } from "../api";
import { ADJ, fmtTokens, fmtTokensExact } from "../format";

/** Share of `total` spent, 0..1 (0 when there's no total). */
export function spentShare(spent: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, spent / total)) : 0;
}

/** "1M / 2M tokens (52%) · holds at 1.35M", the grant's bar label (a funded grant's next hold point, exact: grant C gr_95svkzi4l6). */
export function grantSpendLine(g: Pick<GrantView, "spentTokens" | "grantTokens"> & { holdAtTokens?: number | null }): string {
  const total = g.grantTokens ?? 0;
  const hold = g.holdAtTokens != null ? ` · holds at ${fmtTokensExact(g.holdAtTokens)}` : "";
  return `${fmtTokens(g.spentTokens)} / ${fmtTokens(total)} ${ADJ} (${Math.round(spentShare(g.spentTokens, total) * 100)}%)${hold}`;
}

/** Pill tone per key-result status: met green, missed red, claimed / met unverified amber, open neutral. */
export function krTone(s: KeyResultStatus): string {
  return s === "met" ? "ok" : s === "missed" ? "bad" : s === "claimed" || s === "met-unverified" ? "warn" : "";
}

/** The human-readable status, "met, unverified" for "met-unverified". */
export const krStatusLabel = (s: KeyResultStatus) => krStatusWords(s);

/** The statuses a holder may set: `fund` holders judge met / missed; managers (and `manage` holders) go up to claimed. */
const KR_STATUSES: KeyResultStatus[] = ["open", "claimed", "met", "missed"];
export function settableStatuses(canFund: boolean): KeyResultStatus[] {
  return canFund ? KR_STATUSES : KR_STATUSES.filter((s) => s !== "met" && s !== "missed");
}

/** The short blocked label for a building's panel, map sign and the decision queue. */
export const BLOCKED_LABEL = "Blocked: no key results";
/** Who unblocks a blocked building, and how. */
export const UNBLOCK_LINE = "Key results belong to grants now: the building's manager proposes a grant with its own key results, and a human funds it.";

/** The blocked label when a lab is blocked (the server's `blockedAt`), else null. */
export function blockedLabel(b: { kind: string; blockedAt?: string | null }): string | null {
  return b.kind !== "town-hall" && b.blockedAt ? BLOCKED_LABEL : null;
}

/** Why a proposal can't be funded yet (it carries no key results), or null when it can. */
export function unfundableReason(g: Pick<GrantView, "status" | "keyResults">): string | null {
  return g.status === "proposed" && !g.keyResults.length ? "It carries no key results, so it can't be funded: counter it so the manager adds them." : null;
}

/** "Written by Pix, edited by Mitchell" for a goal key result (a manager writes its own building's too); null when unknown (older ones). */
export function krAuthorLine(k: { createdByName?: string | null; editedByName?: string | null }): string | null {
  const by = k.createdByName ?? null, ed = k.editedByName ?? null;
  if (!by) return ed ? `Edited by ${ed}` : null;
  return ed && ed !== by ? `Written by ${by}, edited by ${ed}` : `Written by ${by}`;
}

// ---------- the building panel's Goals and Grants tabs ----------

/** A grant on the tree (as the goal tree shows it): any but a draft or a rejected proposal. */
export const onTree = (g: Pick<GrantView, "status">) => g.status !== "draft" && g.status !== "rejected";
const LIVE = new Set<GrantView["status"]>(["funded", "checkpoint"]);
const OPEN_PROPOSAL = new Set<GrantView["status"]>(["proposed", "countered"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A goal and every goal under it, the node itself first. */
export function subtreeGoals<N extends { children: N[] }>(node: N): N[] {
  return [node, ...node.children.flatMap((c) => subtreeGoals(c))];
}

/**
 * The key results the building's subtree counts: those of its grants on the tree (by their one parent, `grantId`) and
 * those a goal keeps as history with no grant (before migration 069). A draft's or a rejected proposal's are not counted.
 */
export function subtreeKrs<K extends Pick<KeyResult, "grantId">>(krs: K[], grants: Pick<GrantView, "id" | "status">[]): K[] {
  const ok = new Set(grants.filter(onTree).map((g) => g.id));
  return krs.filter((k) => !k.grantId || ok.has(k.grantId));
}

/** The Overview's Goals line, read from the one tree: "3 goals, 2 grants funded, 1 of 5 key results met" (a held grant counts as funded; met includes met, unverified). */
export function goalsSummary(goals: number, grants: Pick<GrantView, "id" | "status">[], krs: Pick<KeyResult, "grantId" | "status">[]): string {
  const counted = subtreeKrs(krs, grants);
  const met = counted.filter((k) => k.status === "met" || k.status === "met-unverified").length;
  return `${plural(goals, "goal")}, ${plural(grants.filter((g) => LIVE.has(g.status)).length, "grant")} funded, ${met} of ${plural(counted.length, "key result")} met`;
}

/** The Grants tab's order: open proposals (oldest first), then funded (newest funding first), then checkpoint / stopping / closed / rejected (latest first). Drafts aren't grants yet. */
export function grantGroups<G extends Pick<GrantView, "status" | "createdAt" | "updatedAt" | "fundedAt">>(grants: G[]): { proposals: G[]; funded: G[]; settled: G[] } {
  const by = (k: (g: G) => string, asc: boolean) => (a: G, b: G) => asc ? k(a).localeCompare(k(b)) : k(b).localeCompare(k(a));
  return {
    proposals: grants.filter((g) => OPEN_PROPOSAL.has(g.status)).sort(by((g) => g.createdAt, true)),
    funded: grants.filter((g) => g.status === "funded").sort(by((g) => g.fundedAt ?? g.createdAt, false)),
    settled: grants.filter((g) => g.status === "checkpoint" || g.status === "stopping" || g.status === "closed" || g.status === "rejected").sort(by((g) => g.updatedAt, false)),
  };
}

/** The Overview's Grants line: "1 proposal, 3 funded", plus ", 2 closed or held" when there are any. */
export function grantsSummary(grants: Pick<GrantView, "status" | "createdAt" | "updatedAt" | "fundedAt">[]): string {
  const { proposals, funded, settled } = grantGroups(grants);
  return `${plural(proposals.length, "proposal")}, ${funded.length} funded${settled.length ? `, ${settled.length} closed or held` : ""}`;
}

/** A grant's step assignments with their spend, from GET /api/finance/spend (building → grant → assignment). */
export function grantSteps(spend: FinanceSpend | null | undefined, buildingId: string, grantId: string): SpendNode[] {
  const b = spend?.rows.find((r) => r.kind === "building" && r.id === buildingId);
  const g = b?.children?.find((r) => r.kind === "grant" && r.id === grantId);
  return (g?.children ?? []).filter((r) => r.kind === "assignment");
}
