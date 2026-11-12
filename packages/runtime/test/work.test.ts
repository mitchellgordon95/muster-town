import { entryOf } from "@muster-town/core";
import { describe, expect, test, vi } from "vitest";
import { callVerb, deferred, init, managerless, result, setup, TEST_TOKEN, text, toolUse, type FakeSession } from "./helpers.ts";
import { cutFlaggedSessions } from "../src/work.ts";

const REPORT = { title: "Mauna Loa growth rate", verdict: "continue", body: "## Summary\nGrowth 2.4 ± 0.1 ppm/yr.\n\n## Proposal for next session\nHow does the 13C record attribute the rise?\nBecause attribution matters." };

async function* happyWork(s: FakeSession) {
  yield init();
  yield text("Let me look around first and then check the board for prior work on the growth rate.");
  yield* callVerb(s, "look", {});
  yield* callVerb(s, "search", { query: "Mauna Loa growth" });
  yield toolUse("mcp__town__go", { to: "library" });
  yield toolUse("WebSearch", { query: "NOAA annual CO2 growth rate 2025" });
  yield toolUse("WebFetch", { url: "https://www.gml.noaa.gov/ccgg/trends/gr.html" });
  yield* callVerb(s, "submit_report", REPORT);
  yield result(1200, 0.42, "Report submitted.");
}

describe("work session", () => {
  test("streams SDK messages into readable events, charges usage, ends idle with the report in the in-tray", async () => {
    const { world, runtime, sdk, by, lab } = setup(happyWork);
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Measure the growth rate" });
    const before = world.events.lastId();
    const session = await runtime.runWorkSession(noor.id, asg.id);

    const evs = world.events.list({ since: before, agentId: noor.id, limit: 500 });
    const tools = evs.filter((e) => e.type === "agent.tool").map((e) => e.text);
    expect(tools).toEqual([
      "Looking around",
      "Searching the library: Mauna Loa growth",
      "Walking to library",
      "Searching the web: NOAA annual CO2 growth rate 2025",
      "Reading gml.noaa.gov",
      "Submitting report: Mauna Loa growth rate",
    ]);
    const thought = evs.find((e) => e.type === "agent.thought")!;
    expect(thought.text.length).toBeLessThanOrEqual(200);
    expect(thought.payload.sessionId).toBe(session.id);
    expect(evs.some((e) => e.type === "session.started")).toBe(true);
    const ended = evs.find((e) => e.type === "session.ended")!;
    expect(ended.payload).toMatchObject({ status: "done", tokens: 1200, costUsd: 0.42 });

    // options: MCP over http with the agent's bearer token, tool allow/deny lists, model, turns
    const opts = sdk.sessions[0].options;
    expect(opts.mcpServers?.town).toMatchObject({ type: "http", url: "http://127.0.0.1:4321/mcp", headers: { Authorization: expect.stringMatching(/^Bearer at_/) } });
    // the session's own token, revoked when it ended (docs/secrets.md "Login tokens")
    const bearerTok = (opts.mcpServers!.town as { headers: Record<string, string> }).headers.Authorization.slice("Bearer ".length);
    expect(world.tokens.resolve(bearerTok)).toBeUndefined();
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE sessionId = ?").get(session.id)).toEqual({ n: 0 });
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["mcp__town__look", "mcp__town__submit_report", "WebSearch", "WebFetch"]));
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent"]));
    expect(opts.maxTurns).toBe(lab.maxTurnsPerSession);
    expect(opts.model).toBe("claude-fable-5-1"); // a resident's own session runs on its own model (new residents: Fable), not the lab's
    expect(noor.model).toBe("claude-fable-5-1");
    expect(opts.permissionMode).toBeUndefined();
    // house allocation has no key of its own: the Bank's subscription token, and nothing from the host env (post-mortem 2026-10-30)
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TEST_TOKEN);
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(opts.env ?? {}).some((k) => k.startsWith("DESK_ENV_") || k.startsWith("MUSTER_TOWN_"))).toBe(false); // allowlisted host env
    expect(sdk.sessions[0].received[0]).toContain("Measure the growth rate");

    const s = world.sessions.require(session.id);
    expect(s).toMatchObject({ status: "done", tokens: 1200, sdkSessionId: "sdk-session-1", purpose: "work" });
    expect(s.reportId).toBeTruthy();
    // the session's usage is stamped onto the report it produced
    expect(world.docs.require(s.reportId!)).toMatchObject({ sessionId: session.id, tokens: 720, costUsd: 0.42, turns: 4 });
    const after = world.agents.require(noor.id);
    expect(after.status).toBe("idle");
    expect(world.ops.intray(lab.id).map((d) => d.id)).toContain(s.reportId);
    expect(after.spentTokensToday).toBe(720);
    expect(after.activity).toBe("Submitting report: Mauna Loa growth rate");
    expect(world.assignments.require(asg.id).status).toBe("done");
    expect(world.allocations.first("buildingId = ?", [lab.id])!.spentTokens).toBe(720);
  });

  test("donor API key is passed through env", async () => {
    const { world, runtime, sdk, by, lab, seed } = setup(happyWork);
    world.allocations.where("buildingId = ?", [lab.id]).forEach((a) => world.allocations.patch(a.id, { spentTokens: a.tokens }));
    const donor = world.ops.createUser("Donor").user;
    world.budget.donate(donor.id, { tokens: 100_000, buildingId: lab.id, apiKey: "sk-ant-donor" });
    const noor = by("Noor");
    world.setStatus(noor.id, "idle");
    const asg = world.ops.createWork(null, noor.id, {});
    await runtime.runWorkSession(noor.id, asg.id);
    expect(sdk.sessions[0].options.env?.ANTHROPIC_API_KEY).toBe("sk-ant-donor");
    expect(world.allocations.first("userId = ?", [donor.id])!.spentTokens).toBe(720);
    expect(seed.admin.id).toBeTruthy();
  });

  test("a session that ends without submit_report leaves a code entry on its job's thread for the manager, no report doc", async () => {
    const { world, runtime, by } = setup(async function* (s) {
      yield init();
      yield* callVerb(s, "look", {});
      yield text("I found that the growth rate was 2.4 ppm/yr but ran out of turns.");
      yield result(300, 0.01, "I found that the growth rate was 2.4 ppm/yr but ran out of turns.");
    });
    const tomas = by("Tomas");
    const asg = world.ops.createWork(null, tomas.id, { title: "Land sink size" });
    const session = await runtime.runWorkSession(tomas.id, asg.id);
    expect(world.sessions.require(session.id).reportId ?? null).toBeNull();
    expect(world.docs.count("type = 'report' AND authorId = ?", [tomas.id])).toBe(0);
    const entry = entryOf(world, `en_${session.id}`)!;
    expect(entry).toMatchObject({ authorKind: "code", authorId: tomas.id, level: "manager", docId: null, assignmentId: asg.id, sessionId: session.id, tokens: 180, moved: { kind: "dead-session", stopped: false } });
    expect(entry.note).toBe("Session ended without a report: Land sink size");
    expect(entry.body).toContain("2.4 ppm/yr");
    expect(entry.body).toContain("without `submit_report`");
    // nothing stays active with no session behind it
    expect(world.assignments.require(asg.id)).toMatchObject({ status: "cancelled", heldReason: "The session ended without a report." });
    expect(world.agents.require(tomas.id).status).toBe("idle");
    expect(world.events.list({ agentId: tomas.id, types: ["system"] }).some((e) => e.payload.fallback)).toBe(true);
  });

  test("building exhaustion from usage sets out-of-budget and blocks the scheduler (no per-agent daily cap)", async () => {
    const { world, runtime, sdk, by, lab } = setup(happyWork);
    for (const a of world.allocations.where("buildingId = ?", [lab.id])) world.allocations.upsert({ ...a, spentTokens: a.tokens - 500 });
    const mei = by("Mei");
    const asg = world.ops.createWork(null, mei.id, {});
    await runtime.runWorkSession(mei.id, asg.id);
    const after = world.agents.require(mei.id);
    expect(after.spentTokensToday).toBe(720);
    expect(after.status).toBe("out-of-budget");
    expect(world.events.list({ types: ["budget.exhausted"], agentId: mei.id })).toHaveLength(1);
    // the report waits in the in-tray (no next assignment); give her one: she still can't start
    expect(world.assignments.count("agentId = ? AND status = 'pending'", [mei.id])).toBe(0);
    world.ops.createWork(null, mei.id, {});
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(sdk.sessions).toHaveLength(1);
    await expect(runtime.runWorkSession(mei.id, asg.id)).rejects.toThrow(/out of budget/);
  });

  test("interrupt is delivered as the next streamed user message", async () => {
    const thinking = deferred();
    const { world, runtime, sdk, by } = setup(async function* (s) {
      yield init();
      yield text("Starting on the isotopes.");
      thinking.resolve();
      const msg = await s.next(); // the SDK reads the next streamed user message
      yield text(`Got it: ${msg}`);
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    const running = runtime.runWorkSession(noor.id, asg.id);
    await thinking.promise;
    expect(runtime.isWorking(noor.id)).toBe(true);
    expect(await runtime.interrupt(noor.id, "Focus on 13C only", "Mitchell")).toBe(true);
    await running;
    const received = sdk.sessions[0].received;
    expect(received).toHaveLength(2);
    expect(received[1]).toContain("Interrupt from Mitchell: Focus on 13C only");
    expect(world.events.list({ agentId: noor.id, types: ["system"] }).some((e) => e.payload.interrupt)).toBe(true);
    expect(await runtime.interrupt(noor.id, "too late")).toBe(false);
  });

  test("interrupt now aborts the current turn; the message still runs next and the session ends done", async () => {
    const thinking = deferred();
    const { world, runtime, sdk, by } = setup(async function* (s) {
      yield init();
      yield text("Starting a long scan.");
      thinking.resolve();
      await vi.waitFor(() => { if (!s.interrupted) throw new Error("not yet"); });
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"], num_turns: 1, total_cost_usd: 0, session_id: "sdk-session-1", queued_turn_count: 1 };
      const msg = await s.next();
      yield text(`Switching: ${msg}`);
      yield* callVerb(s, "submit_report", REPORT);
      yield result(100, 0.01);
    });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    const running = runtime.runWorkSession(noor.id, asg.id);
    await thinking.promise;
    expect(await runtime.interrupt(noor.id, "Drop the scan", "Mitchell", true)).toBe(true);
    const session = await running;
    expect(sdk.sessions[0].interrupted).toBe(true);
    expect(sdk.sessions[0].received[1]).toContain("Interrupt from Mitchell: Drop the scan");
    expect(world.events.list({ agentId: noor.id, types: ["system"] }).find((e) => e.payload.interrupt)?.payload.now).toBe(true);
    expect(session.status).toBe("done");
    expect(session.error).toBeNull();
  });

  test("stopping an agent mid-session aborts it and leaves a record on the thread (no report, nothing for the manager)", async () => {
    const gate = deferred();
    const { world, runtime, sdk, by } = setup(async function* (s) {
      yield init();
      yield text("Working...");
      gate.resolve();
      await vi.waitFor(() => { if (!s.interrupted) throw new Error("not yet"); });
      yield result(50, 0.001);
    });
    const ravi = by("Ravi");
    world.setStatus(ravi.id, "idle");
    const asg = world.ops.createWork(null, ravi.id, {});
    const running = runtime.runWorkSession(ravi.id, asg.id);
    await gate.promise;
    world.ops.stopAgent(null, ravi.id);
    const session = await running;
    expect(sdk.sessions[0].interrupted).toBe(true);
    expect(session.status).toBe("interrupted");
    expect(world.agents.require(ravi.id).status).toBe("stopped");
    expect(session.reportId ?? null).toBeNull();
    expect(entryOf(world, `en_${session.id}`)).toMatchObject({ authorKind: "code", level: "none", tokens: 30, moved: { kind: "dead-session", stopped: true } });
    expect(world.assignments.require(asg.id).status).toBe("cancelled");
  });
});

describe("waiting assignments", () => {
  test("the tick unblocks a met wait and the scheduler starts it; the runtime fills world.host for deploy waits", async () => {
    const { world, runtime, by } = setup(happyWork);
    managerless(world);
    const noor = by("Noor");
    expect(world.host.startedAt).toBe("2026-10-19T10:00:00.000Z");
    expect(typeof world.host.isLive).toBe("function");
    const first = world.ops.createWork(null, noor.id, { title: "First" });
    world.ops.cancelAssignment(null, first.id);
    const later = world.ops.createWork(null, noor.id, { title: "After first", waitFor: { assignment: first.id } });
    const blocker = world.ops.createWork(null, by("Mei").id, { title: "Mei's push" });
    const third = world.ops.createWork(null, noor.id, { title: "After Mei", waitFor: { assignment: blocker.id } });
    await runtime.tickOnce();
    await runtime.whenIdle();
    expect(world.assignments.require(later.id)).toMatchObject({ waitFor: null, status: "done" });
    expect(world.assignments.require(third.id)).toMatchObject({ waitFor: { assignment: blocker.id }, status: "pending" });
  });
});

describe("agent memory", () => {
  test("a work session's first message carries the wiki and log (live: docs/prompt-caching.md) and the recent-work block; the session is logged", async () => {
    const { world, runtime, sdk, by } = setup(happyWork);
    const noor = by("Noor");
    await world.verbs.write(noor.id, { type: "wiki", title: "Dashboard", body: "Waiting on Mitchell: 0.44 or the 2024 value.", state: "draft" });
    await world.verbs.write(noor.id, { type: "note", title: "Dashboard number", body: "Use the 10-year mean 0.44 ± 0.03.", state: "building" });
    const asg = world.ops.createWork(null, noor.id, { title: "Reply to Mitchell", description: "Which number did you pick?" });
    await runtime.runWorkSession(noor.id, asg.id);
    const system = JSON.stringify(sdk.sessions[0].options.systemPrompt);
    expect(system).not.toContain("Waiting on Mitchell: 0.44 or the 2024 value.");
    expect(system).toContain("Your memory between sessions is your wiki and your log");
    const first = sdk.sessions[0].received[0];
    expect(first).toMatch(/^Clock: it is /);
    expect(first).toContain("## What you know (your wiki)");
    expect(first).toContain("### Dashboard (dc_");
    expect(first).toContain("Waiting on Mitchell: 0.44 or the 2024 value.");
    const log = world.docs.first("authorId = ? AND type = 'log'", [noor.id]);
    expect(log?.body).toMatch(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC Assignment "Reply to Mitchell" \(as_[\w-]+\): done, report "/);
    const prompt = sdk.sessions[0].received[0];
    expect(prompt).toContain("## Your recent work");
    expect(prompt).toMatch(/- note "Dashboard number" \(dc_[\w-]+, just now\): Use the 10-year mean 0\.44 ± 0\.03\./);
    expect(prompt).toContain("`read` the documents above that are relevant");
  });
});

describe("the circuit breaker's cut", () => {
  test("ends a flagged session only while it is still its agent's live session, after the drain's kill grace", () => {
    vi.useFakeTimers();
    try {
      const kills: string[] = [];
      const live = (agentId: string, sessionId: string) => ({
        kind: "desk" as const, agentId, sessionId, purpose: "work" as const, input: { close: () => undefined }, q: null,
        reportSubmitted: false, stopped: false, child: { kill: () => { kills.push(sessionId); } },
      });
      const ctx = { live: new Map([["ag_a", live("ag_a", "se_new")], ["ag_b", live("ag_b", "se_b")]]) };
      // ag_a's flagged session already ended and a newer one runs: left alone; ag_c has nothing live
      const cut = cutFlaggedSessions(ctx as never, [{ agentId: "ag_a", sessionId: "se_old" }, { agentId: "ag_b", sessionId: "se_b" }, { agentId: "ag_c", sessionId: "se_c" }], 10_000);
      expect(cut).toEqual(["ag_b"]);
      expect(ctx.live.get("ag_a")!.stopped).toBe(false);
      expect(ctx.live.get("ag_b")!.stopped).toBe(true);
      // the child is killed only after the grace, never at once
      expect(kills).toEqual([]);
      vi.advanceTimersByTime(10_000);
      expect(kills).toEqual(["se_b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
