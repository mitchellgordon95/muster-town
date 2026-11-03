import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

// Bank grant step 2: adjustedOutputTokens next to the raw total and the five counters, derived on read.
let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("adjusted output tokens in the API", () => {
  it("GET /api/sessions and the agent's current session carry adjustedOutputTokens", async () => {
    const t = await seededApp();
    close = t.close;
    const ravi = t.by("Ravi");
    const counts = { input: 1_000, output: 500, cacheRead: 100_000, cacheWrite5m: 4_000, cacheWrite1h: 0 };
    const s = t.world.ops.startSession(ravi.id, { purpose: "work", model: "claude-opus-5-5" });
    t.world.ops.endSession(s.id, { status: "done", counts });
    const want = 500 + 200 + 1_000 + 1_000;
    const list = await json(t.app, "GET", `/api/sessions?agentId=${ravi.id}`, { headers: t.auth });
    expect(list.status).toBe(200);
    expect(list.body.sessions[0]).toMatchObject({ id: s.id, ...counts, tokens: 105_500, adjustedOutputTokens: want });
    expect((await json(t.app, "GET", `/api/agents/${ravi.id}/session`, { headers: t.auth })).body.session.adjustedOutputTokens).toBe(want);
    expect((await json(t.app, "GET", `/api/agents/${ravi.id}`, { headers: t.auth })).body.currentSession.adjustedOutputTokens).toBe(want);
  });

  it("GET /api/bank carries the credited counters and their adjusted figure", async () => {
    const t = await seededApp();
    close = t.close;
    t.world.bank.addInput(t.seed.admin.id, { label: "Key", source: "api-key", model: "claude-opus-5-5", tokens: 1_000, apiKey: "sk" });
    const bank = (await json(t.app, "GET", "/api/bank", { headers: t.auth })).body;
    // step 3: an input's size is adjusted output tokens; its counters are the back-fill split of the 30,000 raw behind it
    expect(bank.creditedTokens).toBe(1_000);
    expect(bank.rawCreditedTokens).toBe(30_000);
    expect(bank.creditedCounts).toMatchObject({ output: 707, cacheRead: 29_293 });
    expect(bank.adjustedCreditedTokens).toBe(1_000);
    expect(bank.inputs.find((i: { label: string }) => i.label === "Key")).toMatchObject({ creditedTokens: 1_000, adjustedCreditedTokens: 1_000 });
  });
  it("GET /api/sessions?grantId= lists every session of that grant, newest first, with usd, agent name and a sum equal to spentTokens", async () => {
    const t = await seededApp();
    close = t.close;
    const ravi = t.by("Ravi");
    const up = (grantId: string, output: number, startedAt: string, extra: object = {}) => t.world.sessions.upsert({
      id: `se_${grantId}_${output}`, agentId: ravi.id, assignmentId: null, purpose: "work", status: "done", model: "claude-opus-5-5",
      output, startedAt, endedAt: startedAt, lane: "grant", grantId, ...extra,
    } as never);
    up("gr_a", 1_000, "2026-11-01T00:00:00.000Z", { reportId: "dc_r1" });
    up("gr_a", 2_500, "2026-11-02T00:00:00.000Z", { status: "error", error: "boom" });
    up("gr_b", 9_000, "2026-11-02T00:00:00.000Z");
    const r = await json(t.app, "GET", "/api/sessions?grantId=gr_a");
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: { id: string }) => s.id)).toEqual(["se_gr_a_2500", "se_gr_a_1000"]);
    expect(r.body.sessions[1]).toMatchObject({ adjustedOutputTokens: 1_000, usd: 0.02, agentName: "Ravi", assignmentTitle: null, reportId: "dc_r1" });
    expect(r.body).toMatchObject({ grantId: "gr_a", tokens: 3_500, usd: 0.07 });
    expect(t.world.grantDesk.spent("gr_a")).toBe(r.body.tokens);
  });
});
