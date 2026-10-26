import { describe, expect, test, vi } from "vitest";
import { callVerb, deferred, init, result, setup, text, toolUse, type FakeSession } from "./helpers.ts";

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
    expect(opts.mcpServers?.town).toMatchObject({ type: "http", url: "http://127.0.0.1:4321/mcp", headers: { Authorization: `Bearer ${world.tokens.getOrCreate("agent", noor.id)}` } });
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["mcp__town__look", "mcp__town__submit_report", "WebSearch", "WebFetch"]));
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent"]));
    expect(opts.maxTurns).toBe(lab.maxTurnsPerSession);
    expect(opts.model).toBe(lab.model);
    expect(opts.permissionMode).toBeUndefined();
    expect(opts.env?.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY); // house allocation has no donor key
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

  test("fallback report when the session ends without submit_report", async () => {
    const { world, runtime, by } = setup(async function* (s) {
      yield init();
      yield* callVerb(s, "look", {});
      yield text("I found that the growth rate was 2.4 ppm/yr but ran out of turns.");
      yield result(300, 0.01, "I found that the growth rate was 2.4 ppm/yr but ran out of turns.");
    });
    const tomas = by("Tomas");
    const asg = world.ops.createWork(null, tomas.id, { title: "Land sink size" });
    const session = await runtime.runWorkSession(tomas.id, asg.id);
    const report = world.docs.require(world.sessions.require(session.id).reportId!);
    expect(report).toMatchObject({ type: "report", verdict: "continue", decision: "pending", authorId: tomas.id, assignmentId: asg.id });
    expect(report.body).toContain("2.4 ppm/yr");
    expect(report.body).toContain("without `submit_report`");
    expect(report).toMatchObject({ sessionId: session.id, tokens: 180, costUsd: 0.01, turns: 4 });
    expect(world.agents.require(tomas.id).status).toBe("idle");
    expect(world.events.list({ agentId: tomas.id, types: ["system"] }).some((e) => e.payload.fallback)).toBe(true);
  });

  test("budget exhaustion from usage sets out-of-budget and blocks the scheduler", async () => {
    const { world, runtime, sdk, by, lab } = setup(happyWork);
    world.ops.updateBuilding(null, lab.id, { dailyTokensPerAgent: 500 });
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

  test("stopping an agent mid-session aborts it and writes a stopped fallback report", async () => {
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
    expect(world.docs.require(session.reportId!)).toMatchObject({ decision: "stop", tokens: 30, costUsd: 0.001, turns: 4 });
    expect(world.assignments.require(asg.id).status).toBe("cancelled");
  });
});

describe("waiting assignments", () => {
  test("the tick unblocks a met wait and the scheduler starts it; the runtime fills world.host for deploy waits", async () => {
    const { world, runtime, by } = setup(happyWork);
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
  test("a work session's system prompt carries the wiki and log, its prompt the recent-work block, and the session is logged", async () => {
    const { world, runtime, sdk, by } = setup(happyWork);
    const noor = by("Noor");
    await world.verbs.write(noor.id, { type: "wiki", title: "Dashboard", body: "Waiting on Mitchell: 0.44 or the 2024 value.", state: "draft" });
    await world.verbs.write(noor.id, { type: "note", title: "Dashboard number", body: "Use the 10-year mean 0.44 ± 0.03.", state: "building" });
    const asg = world.ops.createWork(null, noor.id, { title: "Reply to Mitchell", description: "Which number did you pick?" });
    await runtime.runWorkSession(noor.id, asg.id);
    const system = JSON.stringify(sdk.sessions[0].options.systemPrompt);
    expect(system).toContain("## What you know (your wiki)");
    expect(system).toContain("### Dashboard (dc_");
    expect(system).toContain("Waiting on Mitchell: 0.44 or the 2024 value.");
    expect(system).toContain("Your memory between sessions is your wiki and your log");
    const log = world.docs.first("authorId = ? AND type = 'log'", [noor.id]);
    expect(log?.body).toMatch(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Assignment "Reply to Mitchell" \(as_[\w-]+\): done, report "/);
    const prompt = sdk.sessions[0].received[0];
    expect(prompt).toContain("## Your recent work");
    expect(prompt).toMatch(/- note "Dashboard number" \(dc_[\w-]+, just now\): Use the 10-year mean 0\.44 ± 0\.03\./);
    expect(prompt).toContain("`read` the documents above that are relevant");
  });
});
