/**
 * The ask card's pure parts (docs/legible-delegation.md §4-6, UI / UX B-C): the decision queue's ask order, the card's delta line,
 * a claim's check line (what each branch does is schema `branchAct`, executed by the server), and the funding slate's arithmetic. Hook-free so tests call them.
 */
import { grantPricingOf, type AskClaim, type GrantView, type Notice, type StepCalibration, type StepSize, type StepSizeTable } from "@muster-town/schema";
import type { AskView } from "../api";

/** Open asks first, by rank (unranked after ranked), then oldest; deferred ones after every open one. */
export function sortAsks<T extends Pick<AskView, "status" | "createdAt" | "rank">>(asks: T[]): T[] {
  const r = (a: T) => (typeof a.rank === "number" ? a.rank : Number.POSITIVE_INFINITY);
  return [...asks].sort((a, b) => Number(a.status === "deferred") - Number(b.status === "deferred") || r(a) - r(b) || a.createdAt.localeCompare(b.createdAt));
}

/** The hydrant's ask count: every live ask, open or deferred (a deferred one still waits on a human; it opens again when what it waits behind settles). */
export const openAskCount = (asks: Pick<AskView, "status">[]) => asks.filter((a) => a.status === "open" || a.status === "deferred").length;

/** The card's delta line (the body's first paragraph) and the prose after it. Both are regular weight (Mitchell, 1:1 mt_eq521xwgth: no bold). */
export function deltaOf(body: string): { delta: string; rest: string } {
  const parts = body.trim().split(/\n\s*\n/);
  return { delta: (parts[0] ?? "").trim(), rest: parts.slice(1).join("\n\n").trim() };
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
  const stepSizes = (g.steps ?? []).map((st) => st.size);
  if (!stepSizes.length || !stepSizes.every((z): z is StepSize => !!z)) return g.askTokens;
  return Math.round(stepSizes.reduce((s, z) => s + table[z] * ratioOf(cal, z), 0));
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
