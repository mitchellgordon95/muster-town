/**
 * The pure core of the Secretary's decision run (core overtake.ts; 1:1 mt_msnjkpgwdb decisions 10, 15, 20a): which
 * open asks a human's decision may have made moot. Properties over generated asks and decisions (a fixed-seed generator:
 * the same cases every run).
 */
import { describe, expect, it } from "vitest";
import { maySettle, namesId, overtakeCandidates, type AskFacts, type DecisionFacts } from "../src/overtake.ts";

const TYPES = ["money", "click", "credential", "meeting", "policy"];
const STATUSES = ["open", "deferred", "decided", "retired", "folded"];
const KINDS = [null, "grant", "request", "captain", "access", "retainer", "keyResult", "rule", "meeting"];
const TARGETS = [null, "gr_aaa111", "gr_aaa1112", "sc_bbb222", "dc_ccc333", "kr_ddd444"];

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function genAsks(r: () => number, n: number): AskFacts[] {
  return Array.from({ length: n }, (_, i) => {
    const targetId = pick(r, TARGETS);
    const mention = r() < 0.3 ? ` see ${pick(r, TARGETS.filter(Boolean) as string[])}` : "";
    const cites = r() < 0.2 ? ` after ak_${Math.floor(r() * 12)}` : "";
    return {
      id: `ak_${i}`, type: pick(r, TYPES), status: pick(r, STATUSES), targetKind: targetId ? pick(r, KINDS.filter(Boolean) as string[]) : null, targetId,
      title: `Ask ${i}${mention}`, body: `Body ${i}${cites}`, deferredUntil: r() < 0.15 ? pick(r, TARGETS.filter(Boolean) as string[]) : null,
    };
  });
}
function genDecision(r: () => number): DecisionFacts {
  const targetId = pick(r, TARGETS);
  return { askId: r() < 0.7 ? `ak_${Math.floor(r() * 12)}` : null, targetKind: targetId && r() < 0.6 ? pick(r, KINDS.filter(Boolean) as string[]) : null, targetId };
}

describe("overtake (pure core): what the Secretary may settle after a human's decision", () => {
  it("maySettle: only a live click or policy ask that is not a request a human must carry out", () => {
    for (const type of TYPES) for (const status of STATUSES) for (const targetKind of KINDS) {
      const a: AskFacts = { id: "ak_x", type, status, targetKind, targetId: targetKind ? "x_1" : null, title: "t", body: "" };
      expect(maySettle(a), `${type} ${status} ${targetKind}`).toBe((type === "click" || type === "policy") && (status === "open" || status === "deferred") && targetKind !== "request");
    }
  });

  it("property: every candidate is settleable, is not the decided ask, and is tied to the decision (same item, or names it)", () => {
    const r = rng(20261112);
    let candidates = 0;
    for (let round = 0; round < 400; round++) {
      const asks = genAsks(r, 12);
      const d = genDecision(r);
      const out = overtakeCandidates(d, asks);
      candidates += out.length;
      for (const a of out) {
        expect(maySettle(a)).toBe(true);
        expect(["money", "credential", "meeting"]).not.toContain(a.type);
        expect(a.targetKind).not.toBe("request");
        expect(a.id).not.toBe(d.askId);
        const words = `${a.title}\n${a.body}\n${a.deferredUntil ?? ""}`;
        const same = !!d.targetId && a.targetId === d.targetId && (!d.targetKind || a.targetKind === d.targetKind);
        const named = [d.askId, d.targetId].some((id) => !!id && namesId(words, id));
        expect(same || named, JSON.stringify({ a, d })).toBe(true);
      }
      // a subset of the input, in the input's order, with no ask twice
      expect(out.every((a) => asks.includes(a))).toBe(true);
      expect(out.map((a) => asks.indexOf(a))).toEqual([...out.map((a) => asks.indexOf(a))].sort((x, y) => x - y));
      expect(new Set(out).size).toBe(out.length);
    }
    // the generator does produce candidates: the property is not vacuous
    expect(candidates).toBeGreaterThan(50);
  });

  it("property: complete: every settleable ask on the decided item is a candidate; a decision that names nothing overtakes nothing", () => {
    const r = rng(7);
    for (let round = 0; round < 300; round++) {
      const asks = genAsks(r, 12);
      const d = genDecision(r);
      const out = new Set(overtakeCandidates(d, asks));
      for (const a of asks) {
        if (maySettle(a) && a.id !== d.askId && d.targetId && a.targetId === d.targetId && (!d.targetKind || a.targetKind === d.targetKind)) expect(out.has(a)).toBe(true);
      }
      expect(overtakeCandidates({}, asks)).toEqual([]);
      expect(overtakeCandidates({ askId: null, targetId: null }, asks)).toEqual([]);
    }
  });

  it("an id is named only as a whole id: gr_aaa111 is not named by gr_aaa1112", () => {
    expect(namesId("fund gr_aaa111 first", "gr_aaa111")).toBe(true);
    expect(namesId("(gr_aaa111)", "gr_aaa111")).toBe(true);
    expect(namesId("fund gr_aaa1112 first", "gr_aaa111")).toBe(false);
    expect(namesId("xgr_aaa111", "gr_aaa111")).toBe(false);
    expect(namesId("anything", "")).toBe(false);
  });

  it("worked example: a rejected proposal overtakes the click that waited on it, not the money ask beside it nor the outbox request", () => {
    const asks: AskFacts[] = [
      { id: "ak_1", type: "click", status: "open", targetKind: null, targetId: null, title: "Let the test account in so gr_x can be checked", body: "" },
      { id: "ak_2", type: "money", status: "open", targetKind: "grant", targetId: "gr_y", title: "Fund the follow-up to gr_x", body: "" },
      { id: "ak_3", type: "click", status: "open", targetKind: "request", targetId: "dc_r", title: "Sign up for the monitor gr_x needs", body: "" },
      { id: "ak_4", type: "policy", status: "deferred", targetKind: "rule", targetId: "rule-1", title: "Keep the rule?", body: "", deferredUntil: "gr_x" },
      { id: "ak_5", type: "click", status: "open", targetKind: null, targetId: null, title: "Unrelated", body: "" },
    ];
    expect(overtakeCandidates({ askId: "ak_0", targetKind: "grant", targetId: "gr_x" }, asks).map((a) => a.id)).toEqual(["ak_1", "ak_4"]);
  });
});
