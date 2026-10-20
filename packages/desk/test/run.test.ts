import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_STOPPED, runSession } from "../src/run.ts";
import { TownClient } from "../src/town.ts";
import { assistant, brief, fakeSdk, sleep, startFakeTown, toolResult, TOKEN, type FakeTown } from "./helpers.ts";

let town: FakeTown;
const logs: string[] = [];
const deps = (sdk: ReturnType<typeof fakeSdk>, extra = {}) => ({
  town: new TownClient({ baseUrl: town.url, token: TOKEN, backoffMs: [5, 5] }),
  sdk,
  env: { AGENT_TOWN_TOKEN: TOKEN } as NodeJS.ProcessEnv,
  log: (l: string) => logs.push(l),
  controlIntervalMs: 20,
  flushMs: 10,
  ...extra,
});

beforeEach(async () => { town = await startFakeTown(); logs.length = 0; });
afterEach(async () => { await town.close(); });

describe("runSession", () => {
  it("fetches the brief, runs the query with bypassed permissions, posts activity and session-end", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () {
      yield assistant({ type: "text", text: "Looking at the data." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } });
      yield toolResult("t1");
      yield assistant({ type: "tool_use", id: "t2", name: "mcp__town__submit_report", input: { title: "Done", body: "x".repeat(5000), verdict: "continue" } });
      yield toolResult("t2");
      yield assistant({ type: "text", text: "Report filed." });
    });
    const code = await runSession("s1", deps(sdk));
    expect(code).toBe(EXIT_OK);

    expect(town.requests[0]).toBe("GET /api/agents/me/brief");
    const opts = sdk.sessions[0]!.params.options!;
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.model).toBe("claude-opus-5-5");
    expect(opts.maxTurns).toBe(40);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "You are Ada." });
    expect(opts.mcpServers).toEqual({ town: { type: "http", url: `${town.url}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` }, alwaysLoad: true } });
    expect(sdk.sessions[0]!.received).toEqual(["Do the assignment."]);

    expect(town.activity).toContainEqual({ session: "s1", kind: "thought", text: "Looking at the data." });
    expect(town.activity).toContainEqual({ session: "s1", kind: "tool", tool: "Bash", input: { command: "ls" } });
    const report = town.activity.find((a) => a.tool === "mcp__town__submit_report")!;
    expect((report.input as { body: string }).body.length).toBeLessThan(1100);

    expect(town.ends).toHaveLength(1);
    expect(town.ends[0]).toEqual({ session: "s1", tokens: 110, costUsd: 0.5, turns: 1, reportSubmitted: true, sdkSessionId: "sdk-1", finalText: "Report filed." });
  });

  it("honours DESK_MODEL / DESK_MAX_TURNS overrides", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { env: { AGENT_TOWN_TOKEN: TOKEN, DESK_MODEL: "claude-haiku-5-5", DESK_MAX_TURNS: "7" } }));
    expect(sdk.sessions[0]!.params.options!.model).toBe("claude-haiku-5-5");
    expect(sdk.sessions[0]!.params.options!.maxTurns).toBe(7);
  });

  it("injects a queued interrupt as the next user message and acks it", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* (_s, _text, n) {
      if (n === 1) {
        yield assistant({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } });
        town.control.interrupts.push({ id: "i1", text: "check the 2023 data too", from: "Mitchell" });
        await sleep(80); // a control poll lands mid-turn
        yield toolResult("t1");
      } else {
        yield assistant({ type: "text", text: "Will do." });
      }
    });
    const code = await runSession("s1", deps(sdk));
    expect(code).toBe(EXIT_OK);
    expect(sdk.sessions[0]!.received).toEqual(["Do the assignment.", "Interrupt from Mitchell: check the 2023 data too"]);
    expect(town.acked).toEqual(["i1"]);
    expect(town.ends[0]).toMatchObject({ session: "s1", turns: 2, reportSubmitted: false, finalText: "Will do." });
  });

  it("an interrupt queued between turns is picked up before finishing", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* (_s, _text, n) {
      if (n === 1) town.control.interrupts.push({ id: "i2", text: "one more thing", from: "Grace" });
      yield assistant({ type: "text", text: `turn ${n}` });
    });
    await runSession("s1", deps(sdk, { controlIntervalMs: 60_000 }));
    expect(sdk.sessions[0]!.received).toEqual(["Do the assignment.", "Interrupt from Grace: one more thing"]);
    expect(town.acked).toEqual(["i2"]);
  });

  it("stop: true interrupts the query, posts session-end and exits 2", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* (s) {
      yield assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } });
      town.control.stop = true;
      await Promise.race([s.interruptedSignal, sleep(5000)]);
    });
    const code = await runSession("s1", deps(sdk));
    expect(code).toBe(EXIT_STOPPED);
    expect(sdk.sessions[0]!.interrupted).toBe(true);
    expect(town.ends).toHaveLength(1);
    expect(town.ends[0]).toMatchObject({ session: "s1", reportSubmitted: false, turns: 1, tokens: 110 });
    expect(town.ends[0]!.error).toBeUndefined();
  });

  it("reports SDK errors in session-end and exits 1", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () {
      yield assistant({ type: "text", text: "hmm" });
      throw new Error("Claude Code process exited with code 1");
    });
    const code = await runSession("s1", deps(sdk));
    expect(code).toBe(EXIT_ERROR);
    expect(town.ends[0]).toMatchObject({ session: "s1", error: "Claude Code process exited with code 1" });
  });

  it("brief 403 → session-end with error, exit 1", async () => {
    const sdk = fakeSdk(async function* () { /* never */ });
    const code = await runSession("nope", deps(sdk));
    expect(code).toBe(EXIT_ERROR);
    expect(sdk.sessions).toHaveLength(0);
    expect(town.ends[0]!.error).toMatch(/brief failed.*403/);
  });

  it("runs workspace setup and uses its dir as cwd", async () => {
    const ws = { repoUrl: "https://example.com/r.git", base: "main", branch: "agent/ada/co2", branchPrefix: "agent", dir: "/home/agent/work/r" };
    town.briefs.set("s1", brief("s1", { workspace: ws }));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "ok" }); });
    const seen: unknown[] = [];
    await runSession("s1", deps(sdk, { setupWorkspace: (w: unknown) => { seen.push(w); return "/tmp/ws"; } }));
    expect(seen).toEqual([ws]);
    expect(sdk.sessions[0]!.params.options!.cwd).toBe("/tmp/ws");
    expect(town.activity[0]).toEqual({ session: "s1", kind: "status", text: "Setting up agent/ada/co2" });
  });
});

describe("TownClient", () => {
  it("retries network errors then succeeds", async () => {
    let calls = 0;
    const f = (async (...args: Parameters<typeof fetch>) => {
      if (++calls < 3) throw new TypeError("fetch failed");
      return fetch(...args);
    }) as typeof fetch;
    const c = new TownClient({ baseUrl: town.url, token: TOKEN, fetch: f, backoffMs: [5, 5] });
    expect(await c.control("s1")).toEqual({ interrupts: [], stop: false });
    expect(calls).toBe(3);
  });
  it("gives up after 3 attempts", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new TypeError("fetch failed"); }) as typeof fetch;
    const c = new TownClient({ baseUrl: town.url, token: TOKEN, fetch: f, backoffMs: [1, 1] });
    await expect(c.ack(["x"])).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });
});
