/**
 * One desk work session (contract steps 4–9): brief → workspace → SDK query with bypassed permissions
 * and the town MCP server → activity posts → control polling (interrupts, stop) → session-end.
 * Exit codes: 0 normal, 2 stopped, 1 error.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { SPEND_LIMIT, townEnv } from "@muster-town/schema";
import type { DeskActivityInput, DeskBrief, DeskSessionEndInput, DeskWorkspace } from "./contract.ts";
import { blocksOf, InputChannel, noUsage, plusUsage, usageOf, type LooseMessage, type Options, type QueryHandle, type Sdk, type Usage } from "./sdk.ts";
import { startMcpProxy, type McpProxy } from "./mcp-proxy.ts";
import type { TownClient } from "./town.ts";
import { setupWorkspace } from "./workspace.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_STOPPED = 2;

const SUBMIT_REPORT = "mcp__town__submit_report";
const THOUGHT_CHARS = 2000;
const INPUT_STRING_CHARS = 1000;

export interface RunDeps {
  town: TownClient;
  sdk: Sdk;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** where the SDK writes transcripts (tests); default $CLAUDE_CONFIG_DIR or ~/.claude */
  claudeDir?: string;
  /** override workspace setup (tests); default runs git/gh/npm */
  setupWorkspace?: (ws: DeskWorkspace, brief: DeskBrief) => string;
  controlIntervalMs?: number;
  flushMs?: number;
  /** the MCP proxy's waits while the town restarts (tests); default RESTART_BACKOFF_MS */
  mcpBackoffMs?: number[];
}

/** Keep tool inputs postable: long strings (file bodies, heredocs) are clipped. */
function clipInput(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > INPUT_STRING_CHARS ? v.slice(0, INPUT_STRING_CHARS) + "…" : v;
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipInput(x, depth + 1)]));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An error that means the subscription is out of quota for now (the desk then fails over to the API key once). */
export { SPEND_LIMIT };
/** The API key to fail over to (both spellings for one release). Never passed to Claude Code itself. */
export const FALLBACK_KEY_ENVS = ["AGENT_TOWN_FALLBACK_API_KEY", "MUSTER_TOWN_FALLBACK_API_KEY"] as const;
const FUNDING = new Set(["subscription", "api-key", "donor-key"]);
type FundingMode = "subscription" | "api-key" | "donor-key";

/**
 * Env for the Claude Code process the SDK spawns. `DESK_AUTH` (the town's funding order) says which credential
 * to use first: subscription → `CLAUDE_CODE_OAUTH_TOKEN` wins and ANTHROPIC_API_KEY is dropped (Claude Code prefers
 * an API key when both are set); api-key / donor-key → the key wins and the token is dropped. The fallback key is
 * never passed on; it comes back as `fallbackKey`. Values are secrets: never log them.
 */
export function sessionEnv(env: NodeJS.ProcessEnv): { env: Record<string, string>; auth: string; fallbackKey: string | null } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  let fallbackKey: string | null = null;
  for (const k of FALLBACK_KEY_ENVS) { fallbackKey ??= out[k] || null; delete out[k]; }
  const label = env.DESK_AUTH && env.DESK_AUTH !== "none" ? env.DESK_AUTH : null;
  if ((label === "api-key" || label === "donor-key") && out.ANTHROPIC_API_KEY) {
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
    return { env: out, auth: label, fallbackKey: null };
  }
  if (out.CLAUDE_CODE_OAUTH_TOKEN) {
    delete out.ANTHROPIC_API_KEY;
    return { env: out, auth: label ?? "subscription token", fallbackKey };
  }
  if (out.ANTHROPIC_API_KEY) return { env: out, auth: label ?? "api key", fallbackKey: null };
  return { env: out, auth: "none (the CLI's own login, if any)", fallbackKey: null };
}

/** The SDK env for the failover rerun: the fallback API key, no subscription token. */
export function failoverEnv(base: Record<string, string>, key: string): Record<string, string> {
  const { CLAUDE_CODE_OAUTH_TOKEN: _t, ...rest } = base;
  return { ...rest, ANTHROPIC_API_KEY: key };
}

/**
 * The JSONL the Agent SDK wrote for each of `sdkSessionIds` (`<claudeDir>/projects/<cwd slug>/<id>.jsonl`), joined in
 * order (a failover rerun is a second SDK session), or null when none is on disk.
 */
export function readTranscript(claudeDir: string, sdkSessionIds: string[]): Buffer | null {
  const root = join(claudeDir, "projects");
  if (!sdkSessionIds.length || !existsSync(root)) return null;
  const parts: Buffer[] = [];
  for (const id of sdkSessionIds) {
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${id}.jsonl`);
      if (!existsSync(f)) continue;
      const b = readFileSync(f);
      parts.push(b.length && b[b.length - 1] !== 0x0a ? Buffer.concat([b, Buffer.from("\n")]) : b);
      break;
    }
  }
  return parts.length ? Buffer.concat(parts) : null;
}

export async function runSession(sessionId: string, deps: RunDeps): Promise<number> {
  const { town, sdk } = deps;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => process.stderr.write(`[desk] ${line}\n`));
  const controlMs = deps.controlIntervalMs ?? 3000;
  const flushMs = deps.flushMs ?? 500;

  let usage: Usage = noUsage();
  let finalText = "";
  let error: string | null = null;
  let sdkSessionId: string | null = null;
  /** every SDK session this town session ran (two after a failover), for the transcript upload */
  const sdkSessionIds: string[] = [];
  let reportSubmitted = false;
  let stopped = false;
  /** the session hit the subscription's limit and reran on the fallback API key */
  let fellBack = false;
  /** the SDK's message when a result read as SPEND_LIMIT: posted at session end so the server logs `bank.cap` */
  let spendLimit: string | null = null;
  let fundingUsed: FundingMode | null = env.DESK_AUTH && FUNDING.has(env.DESK_AUTH) ? env.DESK_AUTH as FundingMode : null;

  const endSession = async (): Promise<void> => {
    const body: DeskSessionEndInput = {
      session: sessionId,
      tokens: Math.round(usage.tokens),
      counts: usage.counts,
      byModel: usage.byModel,
      costUsd: usage.costUsd,
      turns: usage.turns,
      reportSubmitted,
      ...(sdkSessionId ? { sdkSessionId } : {}),
      ...(finalText ? { finalText } : {}),
      ...(error && !stopped ? { error } : {}),
      ...(fundingUsed ? { fundingUsed } : {}),
      ...(fellBack ? { fallback: true } : {}),
      ...(spendLimit ? { spendLimit } : {}),
    };
    try {
      await town.sessionEnd(body);
      log(`session-end posted (tokens ${body.tokens}, turns ${body.turns}, report ${reportSubmitted ? "yes" : "no"}${stopped ? ", stopped" : ""}${fellBack ? ", API-key fallback" : ""})`);
    } catch (e) {
      log(`session-end failed: ${errMsg(e)}`);
    }
  };
  const exitCode = () => (stopped ? EXIT_STOPPED : error ? EXIT_ERROR : EXIT_OK);

  // ---- 4. brief ----
  let brief: DeskBrief;
  try {
    brief = await town.brief(sessionId);
    log(`brief: ${brief.agent.name} @ ${brief.building.name}, session ${sessionId}`);
  } catch (e) {
    error = `brief failed: ${errMsg(e)}`;
    log(error);
    await endSession();
    return EXIT_ERROR;
  }

  // ---- activity batching (≤ flushMs) ----
  let buffer: DeskActivityInput[] = [];
  let flushing: Promise<void> = Promise.resolve();
  let activityWarned = false;
  const flush = (): Promise<void> => {
    if (!buffer.length) return flushing;
    const batch = buffer;
    buffer = [];
    flushing = flushing.then(async () => {
      for (const item of batch) {
        try {
          await town.activity(item);
        } catch (e) {
          if (!activityWarned) { activityWarned = true; log(`activity post failed (dropping): ${errMsg(e)}`); }
        }
      }
    });
    return flushing;
  };
  const post = (a: Omit<DeskActivityInput, "session">) => buffer.push({ session: sessionId, ...a });
  const flushTimer = setInterval(() => void flush(), flushMs);

  let input = new InputChannel();
  let q: QueryHandle | null = null;

  // ---- 8. control polling ----
  let polling: Promise<void> | null = null;
  const pollControl = (): Promise<void> => {
    if (polling) return polling;
    polling = (async () => {
      try {
        const c = await town.control(sessionId);
        if (c.interrupts.length) {
          for (const i of c.interrupts) {
            if (input.push(`Interrupt from ${i.from}: ${i.text}`)) log(`interrupt from ${i.from} injected`);
          }
          await town.ack(c.interrupts.map((i) => i.id));
          // "send now": abort the current turn; the SDK keeps the queued message and runs it next
          if (c.interrupts.some((i) => i.now) && !stopped) await q?.interrupt?.().catch(() => undefined);
        }
        if (c.stop && !stopped) {
          stopped = true;
          log("stop requested");
          input.close();
          await q?.interrupt?.().catch(() => undefined);
        }
      } catch (e) {
        log(`control poll failed: ${errMsg(e)}`);
      } finally {
        polling = null;
      }
    })();
    return polling;
  };
  const controlTimer = setInterval(() => void pollControl(), controlMs);

  let cwd = homedir();
  let proxy: McpProxy | null = null;
  try {
    // ---- 5. workspace ----
    if (brief.workspace) {
      post({ kind: "status", text: `Setting up ${brief.workspace.branch}` });
      const setup = deps.setupWorkspace ?? ((ws: DeskWorkspace, b: DeskBrief) =>
        setupWorkspace(ws, { ghToken: env.GH_TOKEN || undefined, agentName: b.agent.name, log }));
      cwd = setup(brief.workspace, brief);
      log(`workspace ready: ${cwd} on ${brief.workspace.branch}`);
    }

    // ---- 6. query ----
    // the town MCP server goes through a local proxy that rides out a town restart (mcp-proxy.ts)
    proxy = await startMcpProxy({ target: town.mcpUrl, backoffMs: deps.mcpBackoffMs, log });
    const maxTurnsEnv = Number(env.DESK_MAX_TURNS);
    const options: Options = {
      cwd,
      model: env.DESK_MODEL || brief.session.model,
      maxTurns: Number.isInteger(maxTurnsEnv) && maxTurnsEnv > 0 ? maxTurnsEnv : brief.building.maxTurnsPerSession ?? 80,
      systemPrompt: { type: "preset", preset: "claude_code", append: brief.system },
      mcpServers: {
        town: { type: "http", url: proxy.url, headers: { Authorization: `Bearer ${townEnv("TOKEN", env) ?? ""}` }, alwaysLoad: true },
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    };
    const se = sessionEnv(env);
    log(`auth: ${se.auth}`);

    /** one run of the whole session (the failover reruns it); returns the error text a limit check reads */
    const attempt = async (sdkEnv: Record<string, string>, prior: Usage): Promise<string> => {
      input = new InputChannel();
      input.push(brief.prompt);
      log(`query: model ${options.model}, maxTurns ${options.maxTurns}, cwd ${cwd}`);
      const query = sdk.query({ prompt: input, options: { ...options, env: sdkEnv } });
      q = query;
      const reportCalls = new Set<string>();
      let toolsAfterReport = 0;
      let detail = "";
      try {
        for await (const raw of query) {
          const m = raw as LooseMessage;
          if (m.session_id && !sdkSessionId) { sdkSessionId = m.session_id; sdkSessionIds.push(m.session_id); }
          if (m.type === "assistant") {
            for (const b of blocksOf(m)) {
              if (b.type === "tool_use" && b.name) {
                post({ kind: "tool", tool: b.name, input: clipInput(b.input ?? {}) });
                if (b.name === SUBMIT_REPORT && b.id) reportCalls.add(b.id);
                if (reportSubmitted && ++toolsAfterReport > 2) void query.interrupt?.().catch(() => undefined);
              } else if (b.type === "text" && b.text?.trim()) {
                const t = b.text.trim();
                finalText = t;
                if (m.error) detail += ` ${t}`;
                post({ kind: "thought", text: t.length > THOUGHT_CHARS ? t.slice(0, THOUGHT_CHARS - 1) + "…" : t });
              }
            }
          } else if (m.type === "user") {
            for (const b of blocksOf(m)) {
              if (b.type === "tool_result" && b.tool_use_id && reportCalls.has(b.tool_use_id) && !b.is_error && !reportSubmitted) {
                reportSubmitted = true;
                log("report submitted");
                input.close(); // the session ends after submit_report
              }
            }
          } else if (m.type === "result") {
            const u = usageOf(m);
            usage = plusUsage(prior, u);
            if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
            // a later turn that succeeds clears an earlier turn's error (e.g. one aborted by an interrupt-now)
            // the subtype of a limit death is "success" with the message in `result`: record the message, not "success"
            const resultText = typeof m.result === "string" ? m.result.trim().split("\n")[0]?.slice(0, 300) : "";
            error = m.is_error ? m.errors?.join("; ") || (m.subtype !== "success" ? m.subtype : "") || resultText || "session ended with an error" : null;
            detail = m.is_error ? `${error} ${typeof m.result === "string" ? m.result : ""} ${finalText}` : "";
            log(`turn done (${usage.turns} turns, ${usage.tokens} tokens${m.is_error ? `, ${m.subtype ?? "error"}` : ""})`);
            // between turns: pick up queued interrupts / stop before deciding whether to finish
            if (!stopped && !reportSubmitted) await pollControl();
            if (stopped || reportSubmitted || (input.pending === 0 && !(m.queued_turn_count && m.queued_turn_count > 0))) {
              input.close();
              break;
            }
          }
        }
      } catch (e) {
        error = errMsg(e);
        detail = `${error} ${detail} ${finalText}`;
        log(`session error: ${error}`);
      } finally {
        input.close();
      }
      return detail;
    };

    const detail = await attempt(se.env, usage);
    if (error && !stopped && SPEND_LIMIT.test(`${error} ${detail}`)) spendLimit = (detail.trim() || error).replace(/\s+/g, " ").trim().slice(0, 2000);
    // ---- failover: the subscription hit its spend limit → rerun the session once on the API key ----
    if (error && !stopped && !reportSubmitted && se.fallbackKey && SPEND_LIMIT.test(`${error} ${detail}`)) {
      log("subscription limit hit; retrying on the API key");
      post({ kind: "status", text: "Switching to API-key funding (subscription limit)" });
      await flush();
      fellBack = true;
      fundingUsed = "api-key";
      error = null;
      finalText = "";
      sdkSessionId = null;
      await attempt(failoverEnv(se.env, se.fallbackKey), usage);
    }
  } catch (e) {
    error = errMsg(e);
    log(`session error: ${error}`);
  } finally {
    clearInterval(controlTimer);
    clearInterval(flushTimer);
    input.close();
    await proxy?.close();
    await polling;
    await flush();
  }

  // ---- transcript (docs/transcripts.md): best effort, before session-end so a restart right after can't cut it ----
  try {
    const raw = readTranscript(deps.claudeDir ?? (env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")), sdkSessionIds);
    if (raw) {
      const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
      await town.transcript(sessionId, br);
      log(`transcript uploaded (${raw.length} bytes, ${br.length} compressed)`);
    } else if (sdkSessionIds.length) log("transcript not found on disk");
  } catch (e) {
    log(`transcript upload failed: ${errMsg(e)}`);
  }

  // ---- 9. session-end ----
  await endSession();
  return exitCode();
}
