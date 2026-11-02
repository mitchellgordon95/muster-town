import type { Grant, GrantEstimate, SimilarGrant } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** What an estimate is asked about: a grant (or a plan not saved yet) by its building, key-result count and ask. */
interface EstimateInput { id?: string | null; buildingId: string; keyResults: number; askTokens: number }

/** How many closed grants an estimate's range is read from. */
const NEAREST = 3;

/**
 * What a grant is likely to cost, from the grants already closed as done or cut (Mitchell, 1:1 mt_c9u1kr15jp; docs/how-work-gets-done.md
 * §4 "What a grant is likely to cost"). Read-only arithmetic over existing data: no session, no charge. The (up to) 3
 * closed grants nearest by key-result count, then by funded tokens against the ask, give the range (least and most they
 * spent); the median spent ÷ funded is given collective-wide and for the building. The grant itself never counts.
 */
export function estimateGrant(world: World, input: EstimateInput, at = nowIso()): GrantEstimate {
  // one row per grant id: a grant counts once however it is reached
  const closed = new Map<string, Grant>();
  for (const g of world.grants.where("status = 'closed' AND outcome IN ('done', 'cut') AND grantTokens IS NOT NULL", [], "ORDER BY closedAt, rowid")) {
    if (g.id !== input.id) closed.set(g.id, g);
  }
  const spent = new Map<string, number>();
  if (closed.size) {
    for (const s of world.sessions.where("grantId IN (SELECT id FROM grants WHERE status = 'closed' AND outcome IN ('done', 'cut'))")) {
      if (s.grantId) spent.set(s.grantId, (spent.get(s.grantId) ?? 0) + sessionTokens(s));
    }
  }
  const krCount = new Map<string, number>();
  for (const k of world.keyResults.where("grantId IS NOT NULL")) krCount.set(k.grantId!, (krCount.get(k.grantId!) ?? 0) + 1);
  const rows: SimilarGrant[] = [...closed.values()].map((g) => ({
    id: g.id, buildingId: g.buildingId, objective: g.objective.slice(0, 80), keyResults: krCount.get(g.id) ?? g.testingPlan.length,
    grantTokens: g.grantTokens ?? 0, spentTokens: Math.round(spent.get(g.id) ?? 0), outcome: g.outcome ?? "",
  }));
  const own = rows.filter((r) => r.buildingId === input.buildingId);
  const similar = [...rows].sort((a, b) =>
    Math.abs(a.keyResults - input.keyResults) - Math.abs(b.keyResults - input.keyResults)
    || Math.abs(a.grantTokens - input.askTokens) - Math.abs(b.grantTokens - input.askTokens)
    || a.id.localeCompare(b.id)).slice(0, NEAREST);
  const spends = similar.map((r) => r.spentTokens);
  const est = {
    askTokens: input.askTokens, sample: rows.length, buildingSample: own.length,
    medianRatio: medianRatio(rows), buildingMedianRatio: medianRatio(own), similar,
    low: spends.length ? Math.min(...spends) : null, high: spends.length ? Math.max(...spends) : null, at,
  };
  return { ...est, sentence: sentenceOf(est) };
}

/** The one plain line next to the ask: "ask 200,000 · 3 similar grants spent 180,000–610,000 (median spent/funded 1.21 across 39 closed grants; this building 0.95 across 12)". */
function sentenceOf(e: Omit<GrantEstimate, "sentence">): string {
  const ask = `ask ${fmt(e.askTokens)}`;
  if (!e.similar.length || e.low === null || e.high === null) return `${ask} · no closed grants yet to compare it with`;
  const range = e.low === e.high ? fmt(e.low) : `${fmt(e.low)}–${fmt(e.high)}`;
  const head = e.similar.length < NEAREST
    ? `only ${e.similar.length} closed grant${e.similar.length === 1 ? "" : "s"} to compare with: spent ${range}`
    : `${NEAREST} similar grants spent ${range}`;
  const building = e.buildingMedianRatio !== null ? `; this building ${e.buildingMedianRatio.toFixed(2)} across ${e.buildingSample}` : "";
  return `${ask} · ${head} (median spent/funded ${e.medianRatio!.toFixed(2)} across ${e.sample} closed grant${e.sample === 1 ? "" : "s"}${building})`;
}

/** Median of spent ÷ funded, to 2 decimals (null: no rows). */
function medianRatio(rows: SimilarGrant[]): number | null {
  const r = rows.filter((x) => x.grantTokens > 0).map((x) => x.spentTokens / x.grantTokens).sort((a, b) => a - b);
  if (!r.length) return null;
  const m = r.length % 2 ? r[(r.length - 1) / 2]! : (r[r.length / 2 - 1]! + r[r.length / 2]!) / 2;
  return Math.round(m * 100) / 100;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
