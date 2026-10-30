import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_STOPPED, runSession } from "../src/run.ts";
import { TownClient } from "../src/town.ts";
import { assistant, brief, fakeSdk, result, sleep, startFakeTown, toolResult, TOKEN, type FakeTown } from "./helpers.ts";

let town: FakeTown;
const logs: string[] = [];
const deps = (sdk: ReturnType<typeof fakeSdk>, extra = {}) => ({
  town: new TownClient({ baseUrl: town.url, token: TOKEN, backoffMs: [5, 5], restartBackoffMs: [5, 5] }),
  sdk,
  env: { AGENT_TOWN_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token", DESK_AUTH: "subscription" } as NodeJS.ProcessEnv, // the runtime always hands a desk one credential
  log: (l: string) => logs.push(l),
  controlIntervalMs: 20,
  flushMs: 10,
  readProcStat: () => null,
  ...extra,
});

beforeEach(async () => { town = await startFakeTown(); logs.length = 0; });
afterEach(async () => { await town.close(); });

describe("runSession", () => {
  it("uploads the SDK's JSONL transcript (brotli) before session-end", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "desk-claude-"));
    mkdirSync(join(claudeDir, "projects", "-home-agent-work"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-home-agent-work", "sdk-1.jsonl"), '{"type":"user"}\n{"type":"assistant"}');
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { claudeDir }));
    expect(brotliDecompressSync(town.transcripts.get("s1")!).toString()).toBe('{"type":"user"}\n{"type":"assistant"}\n');
    const i = town.requests.indexOf("POST /api/agents/me/transcript");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(town.requests.indexOf("POST /api/agents/me/session-end"));
  });

  it("posts wallMs, cpuMs and stealMs from /proc/stat in session-end", async () => {
    town.briefs.set("s1", brief("s1"));
    const reads = [{ cpu: 1000, steal: 10 }, { cpu: 1450, steal: 3610 }];
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { readProcStat: () => reads.shift() ?? null }));
    expect(town.ends[0]).toMatchObject({ cpuMs: 4500, stealMs: 36000 });
    expect(town.ends[0]!.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("skips the upload when the SDK left no transcript", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { claudeDir: mkdtempSync(join(tmpdir(), "desk-claude-")) }));
    expect(town.transcripts.size).toBe(0);
    expect(town.ends).toHaveLength(1);
  });

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
    expect(opts.mcpServers).toEqual({ town: { type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), headers: { Authorization: `Bearer ${TOKEN}` }, alwaysLoad: true } });
    expect(sdk.sessions[0]!.received).toEqual(["Do the assignment."]);

    expect(town.activity).toContainEqual({ session: "s1", kind: "thought", text: "Looking at the data." });
    expect(town.activity).toContainEqual({ session: "s1", kind: "tool", tool: "Bash", input: { command: "ls" } });
    const report = town.activity.find((a) => a.tool === "mcp__town__submit_report")!;
    expect((report.input as { body: string }).body.length).toBeLessThan(1100);

    expect(town.ends).toHaveLength(1);
    const counts = { input: 100, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(town.ends[0]).toEqual({ session: "s1", tokens: 110, counts, byModel: { m: counts }, costUsd: 0.5, turns: 1, reportSubmitted: true, sdkSessionId: "sdk-1", finalText: "Report filed.", wallMs: expect.any(Number), fundingUsed: "subscription" });
  });

  it("honours DESK_MODEL / DESK_MAX_TURNS overrides", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { env: { AGENT_TOWN_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token", DESK_MODEL: "claude-haiku-5-5", DESK_MAX_TURNS: "7" } }));
    expect(sdk.sessions[0]!.params.options!.model).toBe("claude-haiku-5-5");
    expect(sdk.sessions[0]!.params.options!.maxTurns).toBe(7);
  });

  it("passes CLAUDE_CODE_OAUTH_TOKEN through to the SDK session env, logging the mode only", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { env: { AGENT_TOWN_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret", DESK_AUTH: "subscription token" } }));
    const env = sdk.sessions[0]!.params.options!.env!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-secret");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AGENT_TOWN_TOKEN).toBe(TOKEN);
    expect(logs).toContain("auth: subscription token");
    expect(logs.join("\n")).not.toContain("sk-ant-oat-secret");
  });

  it("a token and an API key together is a hard failure: nothing reaches the SDK, the session ends in error (post-mortem 2026-10-30)", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    const code = await runSession("s1", deps(sdk, { env: { AGENT_TOWN_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret", ANTHROPIC_API_KEY: "sk-ant-stale", DESK_AUTH: "subscription" } }));
    expect(code).toBe(EXIT_ERROR);
    expect(sdk.sessions).toHaveLength(0);
    expect(logs.join("\n")).toContain("CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are both set");
    expect(logs.join("\n")).not.toContain("sk-ant-");
    expect(town.ends.at(-1)?.error).toContain("both set");
  });

  it("an API key (donor or env) reaches the SDK env unchanged when there is no subscription token", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: "hi" }); });
    await runSession("s1", deps(sdk, { env: { AGENT_TOWN_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-donor", DESK_AUTH: "donor key" } }));
    const env = sdk.sessions[0]!.params.options!.env!;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-donor");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(logs).toContain("auth: donor key");
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

  it("an interrupt marked now stops the current turn and runs next; the session doesn't end as an error", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* (s, _text, n) {
      if (n === 1) {
        yield assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } });
        town.control.interrupts.push({ id: "i3", text: "stop that, look at 13C", from: "Mitchell", now: true });
        await Promise.race([s.interruptedSignal, sleep(5000)]);
        yield toolResult("t1");
      } else {
        yield assistant({ type: "text", text: "Switching to 13C." });
      }
    });
    const code = await runSession("s1", deps(sdk));
    expect(code).toBe(EXIT_OK);
    expect(sdk.sessions[0]!.interrupted).toBe(true);
    expect(sdk.sessions[0]!.received).toEqual(["Do the assignment.", "Interrupt from Mitchell: stop that, look at 13C"]);
    expect(town.acked).toEqual(["i3"]);
    expect(town.ends[0]).toMatchObject({ turns: 2, finalText: "Switching to 13C." });
    expect(town.ends[0]!.error).toBeUndefined();
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
    const c = new TownClient({ baseUrl: town.url, token: TOKEN, fetch: f, backoffMs: [5, 5], restartBackoffMs: [5, 5] });
    expect(await c.control("s1")).toEqual({ interrupts: [], stop: false });
    expect(calls).toBe(3);
  });
  it("gives up when the restart backoff runs out", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new TypeError("fetch failed"); }) as typeof fetch;
    const c = new TownClient({ baseUrl: town.url, token: TOKEN, fetch: f, backoffMs: [1, 1], restartBackoffMs: [1, 1] });
    await expect(c.ack(["x"])).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });
});

describe("subscription limit: one credential per session, no in-session failover (1:1 mt_x40qq8poc3)", () => {
  const LIMIT = "You've hit your org's monthly spend limit · your session limit resets 8:50pm (UTC)";
  // an old runtime's fallback key in the env: dropped, never a second credential
  const subEnv = { AGENT_TOWN_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: "oat-secret", AGENT_TOWN_FALLBACK_API_KEY: "sk-fallback", DESK_AUTH: "subscription" } as NodeJS.ProcessEnv;
  const limited = () => result(1, { is_error: true, subtype: "success", result: LIMIT, total_cost_usd: 0, modelUsage: {} });
  const reports = async function* () {
    yield assistant({ type: "tool_use", id: "r1", name: "mcp__town__submit_report", input: { title: "Done", body: "b", verdict: "continue" } });
    yield toolResult("r1");
  };

  it("a spend-limit error ends the session with the error and spendLimit; no rerun on the fallback key, which never reaches the SDK", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield assistant({ type: "text", text: LIMIT }); yield limited(); });
    const code = await runSession("s1", deps(sdk, { env: subEnv }));
    expect(code).toBe(EXIT_ERROR);
    expect(sdk.sessions).toHaveLength(1);
    const env = sdk.sessions[0]!.params.options!.env!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-secret");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AGENT_TOWN_FALLBACK_API_KEY).toBeUndefined();
    expect(logs).toContain("subscription limit hit; the session ends here and the next one runs on the Bank's API key");
    expect(logs.join("\n")).not.toMatch(/sk-fallback|oat-secret/);
    expect(town.activity).toContainEqual({ session: "s1", kind: "status", text: "Subscription limit hit: ending; the next session runs on the API key" });
    expect(town.ends).toHaveLength(1);
    expect(town.ends[0]).toMatchObject({ session: "s1", reportSubmitted: false, fundingUsed: "subscription", error: LIMIT, spendLimit: expect.stringContaining("spend limit") });
    expect(town.ends[0].fallback).toBeUndefined();
  });

  it("a thrown limit error ends the same way", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { throw new Error("Claude AI usage limit reached|1760000000"); });
    expect(await runSession("s1", deps(sdk, { env: subEnv }))).toBe(EXIT_ERROR);
    expect(sdk.sessions).toHaveLength(1);
    expect(town.ends[0]).toMatchObject({ fundingUsed: "subscription", spendLimit: expect.stringContaining("usage limit") });
    expect(town.ends[0].fallback).toBeUndefined();
  });

  it("other errors don't fail over", async () => {
    town.briefs.set("s1", brief("s1"));
    const sdk = fakeSdk(async function* () { yield result(1, { is_error: true, subtype: "error_during_execution", errors: ["API Error: 529 overloaded"] }); });
    expect(await runSession("s1", deps(sdk, { env: subEnv }))).toBe(EXIT_ERROR);
    expect(sdk.sessions).toHaveLength(1);
    expect(town.ends[0]).toMatchObject({ error: "API Error: 529 overloaded", fundingUsed: "subscription" });
    expect(town.ends[0].fallback).toBeUndefined();
  });

  it("a report already submitted before the limit stands: the session ends done", async () => {
    town.briefs.set("s1", brief("s1"));
    const reported = fakeSdk(async function* () { yield* reports(); yield limited(); });
    await runSession("s1", deps(reported, { env: subEnv }));
    expect(reported.sessions).toHaveLength(1);
    expect(town.ends[0]).toMatchObject({ reportSubmitted: true, fundingUsed: "subscription" });
    expect(town.ends[0].fallback).toBeUndefined();
  });
});
