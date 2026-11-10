/**
 * The ask card's pure parts (docs/legible-delegation.md §4-6, UI / UX B-C): the decision queue's ask order, the card's delta line,
 * what each branch button does, a claim's check line, and the funding slate's arithmetic. Hook-free so tests call them.
 */
import { grantPricingOf, type AskBranch, type AskClaim, type GrantView, type Notice, type StepCalibration, type StepSize, type StepSizeTable } from "@muster-town/schema";
import type { AskView } from "../api";

/** Open asks first, by rank (unranked after ranked), then oldest; deferred ones after every open one. */
export function sortAsks<T extends Pick<AskView, "status" | "createdAt" | "rank">>(asks: T[]): T[] {
  const r = (a: T) => (typeof a.rank === "number" ? a.rank : Number.POSITIVE_INFINITY);
  return [...asks].sort((a, b) => Number(a.status === "deferred") - Number(b.status === "deferred") || r(a) - r(b) || a.createdAt.localeCompare(b.createdAt));
}

/** The hydrant's ask count: every live ask, open or deferred (a deferred one still waits on a human; it opens again when what it waits behind settles). */
export const openAskCount = (asks: Pick<AskView, "status">[]) => asks.filter((a) => a.status === "open" || a.status === "deferred").length;

/** The card's delta line (the body's first paragraph) and the prose after it. */
export function deltaOf(body: string): { delta: string; rest: string } {
  const parts = body.trim().split(/\n\s*\n/);
  return { delta: (parts[0] ?? "").trim(), rest: parts.slice(1).join("\n\n").trim() };
}

/**
 * What a branch button does, by the ask's target (§11 B): a grant decides through POST /api/grants/:id/decide, a retainer
 * through its retainer decide, a captain or access request through its own decide, an outbox request through claim or
 * decline; anything else (policy, meeting, a question in words) records the label through POST /api/asks/:id/decide.
 * `form`: the button opens a field first (tokens for adjust, tokens and a note for a grant's counter, tokens per run, an end
 * date and a note for a retainer's counter, a note for a request).
 */
export type BranchCall =
  | { kind: "grant"; action: "fund" | "counter" | "reject" | "adjust" | "cut"; form?: "tokens" | "counter" }
  /** a retainer's Counter opens the grant counter's shape: tokens per run, an optional end date, a note (any one of them) */
  | { kind: "retainer"; action: "approve" | "counter" | "reject"; form?: "retainer" }
  | { kind: "captain"; action: "accept" | "decline" }
  | { kind: "access"; grant: boolean }
  /** an outbox request: Claim opens an optional note (the author hears it), Decline a required one (the server refuses a bare decline) */
  | { kind: "request"; action: "claim" | "decline"; form: "note" }
  | { kind: "ask"; decision: string }
  /** a branch the server refuses (continue at the ceiling): not drawn */
  | { kind: "none" };

const verbOf = (b: AskBranch) => (b.action ?? b.label).trim().toLowerCase().split(/\s+/)[0] ?? "";

export function branchCall(ask: Pick<AskView, "targetKind"> & { type?: AskView["type"] }, b: AskBranch, grant?: Pick<GrantView, "status">): BranchCall {
  const v = verbOf(b);
  switch (ask.targetKind) {
    case "grant":
      if (v === "fund") return { kind: "grant", action: "fund" };
      if (v === "counter") return { kind: "grant", action: "counter", form: "counter" };
      if (v === "reject") return { kind: "grant", action: "reject" };
      if (v === "cut") return { kind: "grant", action: "cut" };
      if (v === "adjust" || v === "raise" || v === "top") return { kind: "grant", action: "adjust", form: "tokens" };
      // continue is refused at the ceiling: a held grant is adjusted (a new ceiling) or cut
      if (v === "continue") return { kind: "none" };
      // a money ask on a grant never records a bare label (a "Yes" would decide the ask and leave the grant as it was):
      // Yes / No act on the grant by its status, and anything else isn't drawn
      if (ask.type === "money") {
        const yes = v === "yes" || v === "approve", no = v === "no";
        if (grant?.status === "proposed" && (yes || no)) return yes ? { kind: "grant", action: "fund" } : { kind: "grant", action: "reject" };
        if ((grant?.status === "funded" || grant?.status === "checkpoint") && (yes || no)) return yes ? { kind: "grant", action: "adjust", form: "tokens" } : { kind: "grant", action: "cut" };
        return { kind: "none" };
      }
      break;
    case "retainer":
      if (v === "approve" || v === "fund") return { kind: "retainer", action: "approve" };
      if (v === "counter") return { kind: "retainer", action: "counter", form: "retainer" };
      if (v === "reject") return { kind: "retainer", action: "reject" };
      break;
    case "captain":
      if (v === "accept") return { kind: "captain", action: "accept" };
      if (v === "decline") return { kind: "captain", action: "decline" };
      break;
    case "access":
      if (v === "grant" || v === "let") return { kind: "access", grant: true };
      if (v === "decline") return { kind: "access", grant: false };
      break;
    case "request":
      if (v === "claim") return { kind: "request", action: "claim", form: "note" };
      if (v === "decline") return { kind: "request", action: "decline", form: "note" };
      break;
  }
  return { kind: "ask", decision: b.label };
}

/** A claim's check as one line: "✓ checked 4 min ago", "✗ …", or "pending" before the server ran it (manual claims: "check by hand"). */
export function claimMark(c: AskClaim, now = Date.now()): { mark: "✓" | "✗" | "…"; line: string; tone: "ok" | "bad" | "" } {
  if (!c.result) return { mark: "…", line: c.check.kind === "manual" ? "check by hand" : "pending", tone: "" };
  const min = Math.max(0, Math.round((now - Date.parse(c.result.at)) / 60_000));
  const ago = min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
  return { mark: c.result.ok ? "✓" : "✗", line: `checked ${ago}`, tone: c.result.ok ? "ok" : "bad" };
}

// ---- the funding slate (§6, C) ----

/** The money asks on proposals: what the slate lists. */
export function slateAsks(asks: AskView[], grants: GrantView[]): { ask: AskView; grant: GrantView }[] {
  const byId = new Map(grants.map((g) => [g.id, g]));
  return sortAsks(asks.filter((a) => a.status === "open" && a.type === "money" && a.targetKind === "grant"))
    .flatMap((ask) => { const grant = byId.get(ask.targetId ?? ""); return grant && grant.status === "proposed" ? [{ ask, grant }] : []; });
}

/** A size's calibrated ratio (spent ÷ size), 1.0 when the server has none or too few steps. */
function ratioOf(cal: StepCalibration | null | undefined, size: StepSize): number {
  const r = cal?.sizes?.[size];
  return r && typeof r.ratio === "number" && r.sample >= (cal?.minSample ?? 0) ? r.ratio : 1;
}

/** What a grant is expected to spend: its steps' sizes × the calibrated ratio; a grant without sized steps expects its ask. */
export function expectedSpend(g: Pick<GrantView, "steps" | "askTokens">, sizes: StepSizeTable | undefined, cal?: StepCalibration | null): number {
  const table = sizes ?? grantPricingOf({}).stepSizes;
  if (!g.steps?.length || g.steps.some((st) => !st.size)) return g.askTokens;
  return Math.round(g.steps.reduce((s, st) => { const z = st.size ?? "M"; return s + table[z] * ratioOf(cal, z); }, 0));
}

/**
 * The slate's live line: free tokens before these asks (free tokens already subtract open asks, so the slate's own asks
 * are added back), the toggled asks' sum, what is left after, and what the toggled grants are expected to spend.
 */
export function slateLine(free: { freeTokens: number; openAsksTokens: number } | null | undefined, items: { grant: GrantView }[], funded: Set<string>, sizes?: StepSizeTable, cal?: StepCalibration | null) {
  const all = items.reduce((s, x) => s + x.grant.askTokens, 0);
  const before = free ? free.freeTokens + Math.min(free.openAsksTokens, all) : null;
  const on = items.filter((x) => funded.has(x.grant.id));
  const toggled = on.reduce((s, x) => s + x.grant.askTokens, 0);
  const expected = on.reduce((s, x) => s + expectedSpend(x.grant, sizes, cal), 0);
  return { before, toggled, after: before === null ? null : before - toggled, expected, count: on.length };
}

/** The newest slate notice, whose text heads the funding view. */
export const latestSlate = (notices: Notice[] | undefined) => (notices ?? []).filter((n) => n.kind === "slate").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/**
 * A retainer counter's body (core retainers.ts): the per-run amount only when it differs from the asked one, the end
 * date (a YYYY-MM-DD day, its last second UTC) when given; null when nothing would change (the server refuses that).
 */
export function retainerCounter(perRunText: string, untilDay: string, note: string, askedPerRun?: number): { tokensPerRun?: number; until?: string } | null {
  const t = perRunText.replace(/[,_\s]/g, "");
  const n = t === "" ? NaN : Math.round(Number(t) * 1e6);
  const tokensPerRun = Number.isFinite(n) && n > 0 && n !== askedPerRun ? n : undefined;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(untilDay) ? new Date(`${untilDay}T23:59:59Z`).toISOString() : undefined;
  if (!tokensPerRun && !until && !note.trim()) return null;
  return { ...(tokensPerRun ? { tokensPerRun } : {}), ...(until ? { until } : {}) };
}
