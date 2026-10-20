/**
 * One desk work session (contract steps 4–9): brief → workspace → SDK query with bypassed permissions
 * and the town MCP server → activity posts → control polling (interrupts, stop) → session-end.
 * Exit codes: 0 normal, 2 stopped, 1 error.
 */
import { homedir } from "node:os";
import type { DeskActivityInput, DeskBrief, DeskSessionEndInput, DeskWorkspace } from "./contract.ts";
import { blocksOf, InputChannel, usageOf, type LooseMessage, type Options, type QueryHandle, type Sdk, type Usage } from "./sdk.ts";
import type { TownClient } from "./town.ts";
import { greenMerge, type MergeResult } from "./merge.ts";
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
  /** override workspace setup (tests); default runs git/gh/npm */
  setupWorkspace?: (ws: DeskWorkspace, brief: DeskBrief) => string;
  controlIntervalMs?: number;
  flushMs?: number;
  /** override the merge=green step (tests); default runs gh + the checks in the checkout */
  merge?: (ws: DeskWorkspace & { dir: string }, log: (line: string) => void) => Promise<MergeResult | null>;
}

/** Keep tool inputs postable: long strings (file bodies, heredocs) are clipped. */
function clipInput(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > INPUT_STRING_CHARS ? v.slice(0, INPUT_STRING_CHARS) + "…" : v;
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipInput(x, depth + 1)]));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runSession(sessionId: string, deps: RunDeps): Promise<number> {
  const { town, sdk } = deps;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => process.stderr.write(`[desk] ${line}\n`));
  const controlMs = deps.controlIntervalMs ?? 3000;
  const flushMs = deps.flushMs ?? 500;

  let usage: Usage = { tokens: 0, costUsd: 0, turns: 0 };
  let finalText = "";
  let error: string | null = null;
  let sdkSessionId: string | null = null;
  let reportSubmitted = false;
  let stopped = false;
  let mergeResult: MergeResult | null = null;

  const endSession = async (): Promise<void> => {
    const body: DeskSessionEndInput = {
      session: sessionId,
      tokens: Math.round(usage.tokens),
      costUsd: usage.costUsd,
      turns: usage.turns,
      reportSubmitted,
      ...(mergeResult ? { merged: mergeResult.merged, prNumber: mergeResult.prNumber } : {}),
      ...(sdkSessionId ? { sdkSessionId } : {}),
      ...(finalText ? { finalText } : {}),
      ...(error && !stopped ? { error } : {}),
    };
    try {
      await town.sessionEnd(body);
      log(`session-end posted (tokens ${body.tokens}, turns ${body.turns}, report ${reportSubmitted ? "yes" : "no"}${stopped ? ", stopped" : ""})`);
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

  const input = new InputChannel();
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
    const maxTurnsEnv = Number(env.DESK_MAX_TURNS);
    const options: Options = {
      cwd,
      model: env.DESK_MODEL || brief.session.model,
      maxTurns: Number.isInteger(maxTurnsEnv) && maxTurnsEnv > 0 ? maxTurnsEnv : brief.building.maxTurnsPerSession ?? 80,
      systemPrompt: { type: "preset", preset: "claude_code", append: brief.system },
      mcpServers: {
        town: { type: "http", url: town.mcpUrl, headers: { Authorization: `Bearer ${env.AGENT_TOWN_TOKEN ?? ""}` }, alwaysLoad: true },
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    };
    input.push(brief.prompt);
    log(`query: model ${options.model}, maxTurns ${options.maxTurns}, cwd ${cwd}`);
    q = sdk.query({ prompt: input, options });

    const reportCalls = new Set<string>();
    let toolsAfterReport = 0;
    for await (const raw of q) {
      const m = raw as LooseMessage;
      if (m.session_id && !sdkSessionId) sdkSessionId = m.session_id;
      if (m.type === "assistant") {
        for (const b of blocksOf(m)) {
          if (b.type === "tool_use" && b.name) {
            post({ kind: "tool", tool: b.name, input: clipInput(b.input ?? {}) });
            if (b.name === SUBMIT_REPORT && b.id) reportCalls.add(b.id);
            if (reportSubmitted && ++toolsAfterReport > 2) void q.interrupt?.().catch(() => undefined);
          } else if (b.type === "text" && b.text?.trim()) {
            const t = b.text.trim();
            finalText = t;
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
        usage = usageOf(m);
        if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
        // a later turn that succeeds clears an earlier turn's error (e.g. one aborted by an interrupt-now)
        error = m.is_error ? m.errors?.join("; ") || m.subtype || "session ended with an error" : null;
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
    log(`session error: ${error}`);
  } finally {
    clearInterval(controlTimer);
    clearInterval(flushTimer);
    input.close();
    await polling;
    await flush();
  }

  // ---- v1.2 merge rule: green workspaces squash-merge their PR when every check passes ----
  if (brief.workspace?.merge === "green" && reportSubmitted && !stopped) {
    try {
      const ws = { ...brief.workspace, dir: cwd };
      mergeResult = deps.merge ? await deps.merge(ws, log) : await greenMerge(ws, { log });
      if (mergeResult) {
        post({ kind: "status", text: mergeResult.line });
        log(`${mergeResult.line}${mergeResult.detail ? ` (${mergeResult.detail})` : ""}`);
      }
    } catch (e) {
      log(`merge step failed: ${errMsg(e)}`);
    }
    await flush();
  }

  // ---- 9. session-end ----
  await endSession();
  return exitCode();
}
