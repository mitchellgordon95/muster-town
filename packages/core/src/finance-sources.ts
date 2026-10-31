import type { Allocation, BankCredit, BankDebit, BankInput, Building, User } from "@muster-town/schema";
import { townFinance } from "./finance.ts";
import type { Repos } from "./store.ts";

/**
 * GET /api/finance/sources: where a collective's tokens came from (Bank Transparency grant gr_gbpbbwy9b8, step 1).
 * Every figure is adjusted output tokens, counted with financeSummary's rules (finance.ts), so `totalReceived` is
 * /api/finance `total`: the Bank inputs' credits (each dated credit row), plus the direct donations to buildings (a
 * retired allocation counts only what it spent, up to its size). Read-only: no Bank row is changed.
 */
export interface SourceCredit {
  id: string;
  createdAt: string;
  /** null for a durable (API key) credit */
  expiresAt: string | null;
  tokens: number;
  /** a subscription credit past expiresAt: what was not drawn from it (floor 0), as financeSummary counts `expired` */
  expiredTokens: number;
}

export interface SourceInput {
  /** the BankInput's id; null for the synthetic row holding credits whose input no longer exists */
  id: string | null;
  label: string;
  source: BankInput["source"] | null;
  recurrence: BankInput["recurrence"] | null;
  /** the input owner's name ("" when unknown) */
  who: string;
  createdAt: string | null;
  cancelledAt: string | null;
  /** a recurring input limited to N credits: N and how many are still due (null = until cancelled); its next credit (null = none due) */
  creditsTotal: number | null;
  creditsLeft: number | null;
  nextCreditAt: string | null;
  /** the sum of its credits' tokens */
  tokens: number;
  /** its first and last credit's date; null when it never credited */
  firstAt: string | null;
  lastAt: string | null;
  expiredTokens: number;
  /** oldest first */
  credits: SourceCredit[];
}

export interface SourceDonation {
  id: string;
  label: string;
  who: string;
  buildingId: string;
  buildingName: string;
  createdAt: string;
  auth: Allocation["auth"];
  retired: boolean;
  /** the allocation's size */
  sizeTokens: number;
  spentTokens: number;
  /** what counts as received: the size, or for a retired allocation min(size, spent) (finance.ts) */
  tokens: number;
}

export interface FinanceSources {
  /** one row per Bank input, oldest first, then a "deleted input" row when credits name a missing input */
  inputs: SourceInput[];
  /** one row per direct donation (allocation), oldest first */
  donations: SourceDonation[];
  /** Σ inputs[].tokens: the credit rows' sum (= /api/finance `credited`) */
  creditedTokens: number;
  /** Σ donations[].tokens (= /api/finance `donated`) */
  donatedTokens: number;
  totalReceived: number;
  /** Σ inputs[].expiredTokens (= /api/finance `expired`) */
  expiredTokens: number;
  /** creditedTokens + donatedTokens vs totalReceived, from the rows */
  sumCheck: { ok: boolean; diff: number; identity: string };
  /** /api/finance `total`, and whether totalReceived equals it */
  financeTotal: number;
  matchesFinance: boolean;
  at: string;
}

export interface SourcesInputs {
  inputs: (Pick<BankInput, "id" | "userId" | "label" | "source" | "recurrence" | "createdAt" | "cancelledAt"> & Partial<Pick<BankInput, "creditsTotal" | "creditsLeft" | "nextCreditAt">>)[];
  credits: Pick<BankCredit, "id" | "inputId" | "tokens" | "createdAt" | "expiresAt">[];
  debits: Pick<BankDebit, "creditId" | "tokens">[];
  allocations: Pick<Allocation, "id" | "userId" | "buildingId" | "label" | "createdAt" | "auth" | "retired" | "tokens" | "spentTokens">[];
  buildings: Pick<Building, "id" | "name">[];
  users: Pick<User, "id" | "name">[];
}

export const DELETED_INPUT = "Deleted input (credits whose Bank input no longer exists)";
export const SOURCES_IDENTITY = "credits + donations = total received";

const byDate = <T extends { createdAt: string | null }>(a: T, b: T) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");

/** The pure aggregation behind GET /api/finance/sources; `financeTotal` is /api/finance `total` for matchesFinance. */
export function financeSources(inp: SourcesInputs, financeTotal: number, now = new Date()): FinanceSources {
  const iso = now.toISOString();
  const userName = new Map(inp.users.map((u) => [u.id, u.name]));
  const buildingName = new Map(inp.buildings.map((b) => [b.id, b.name]));
  const drawn = new Map<string, number>();
  for (const d of inp.debits) if (d.creditId) drawn.set(d.creditId, (drawn.get(d.creditId) ?? 0) + d.tokens);

  const rows = new Map<string, SourceInput>();
  for (const i of [...inp.inputs].sort(byDate)) rows.set(i.id, {
    id: i.id, label: i.label, source: i.source, recurrence: i.recurrence, who: userName.get(i.userId) ?? "",
    createdAt: i.createdAt, cancelledAt: i.cancelledAt, creditsTotal: i.creditsTotal ?? null, creditsLeft: i.creditsLeft ?? null,
    nextCreditAt: i.nextCreditAt ?? null, tokens: 0, firstAt: null, lastAt: null, expiredTokens: 0, credits: [],
  });
  let orphan: SourceInput | null = null;
  for (const c of [...inp.credits].sort(byDate)) {
    // same rule as financeSummary: an expiring credit past expiresAt, minus its debits, floor 0
    const expiredTokens = c.expiresAt && c.expiresAt <= iso ? Math.max(0, c.tokens - (drawn.get(c.id) ?? 0)) : 0;
    let row = rows.get(c.inputId);
    if (!row) row = orphan ??= {
      id: null, label: DELETED_INPUT, source: null, recurrence: null, who: "", createdAt: null, cancelledAt: null,
      creditsTotal: null, creditsLeft: null, nextCreditAt: null, tokens: 0, firstAt: null, lastAt: null, expiredTokens: 0, credits: [],
    };
    row.credits.push({ id: c.id, createdAt: c.createdAt, expiresAt: c.expiresAt, tokens: c.tokens, expiredTokens });
    row.tokens += c.tokens;
    row.expiredTokens += expiredTokens;
    row.firstAt ??= c.createdAt;
    row.lastAt = c.createdAt;
  }
  const inputs = [...rows.values(), ...(orphan ? [orphan] : [])];

  const donations: SourceDonation[] = [...inp.allocations].sort(byDate).map((a) => ({
    id: a.id, label: a.label, who: userName.get(a.userId) ?? "", buildingId: a.buildingId, buildingName: buildingName.get(a.buildingId) ?? a.buildingId,
    createdAt: a.createdAt, auth: a.auth, retired: a.retired, sizeTokens: a.tokens, spentTokens: a.spentTokens,
    tokens: a.retired ? Math.min(a.tokens, a.spentTokens) : a.tokens,
  }));

  const creditedTokens = inputs.reduce((s, r) => s + r.tokens, 0);
  const donatedTokens = donations.reduce((s, d) => s + d.tokens, 0);
  const totalReceived = creditedTokens + donatedTokens;
  // re-add from the leaves (each credit, each donation) so the check covers the per-row totals too
  const leaves = inputs.reduce((s, r) => s + r.credits.reduce((t, c) => t + c.tokens, 0), 0) + donations.reduce((s, d) => s + d.tokens, 0);
  const diff = leaves - totalReceived;
  return {
    inputs, donations, creditedTokens, donatedTokens, totalReceived,
    expiredTokens: inputs.reduce((s, r) => s + r.expiredTokens, 0),
    sumCheck: { ok: diff === 0, diff, identity: SOURCES_IDENTITY },
    financeTotal, matchesFinance: totalReceived === financeTotal,
    at: iso,
  };
}

/** financeSources over the world's ledgers (Bank.sources). */
export function townSources(repos: Repos, now = new Date()): FinanceSources {
  return financeSources({
    inputs: repos.bankInputs.all(),
    credits: repos.bankCredits.all(),
    debits: repos.bankDebits.all(),
    allocations: repos.allocations.all(),
    buildings: repos.buildings.all(),
    users: repos.users.all(),
  }, townFinance(repos, now).total, now);
}
