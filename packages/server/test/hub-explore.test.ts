import { World } from "@muster-town/core";
import { startRuntime, type Sdk } from "@muster-town/runtime";
import { ROOT_GOAL_ID, type VerbName } from "@muster-town/schema";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { Hub, type HubCollective } from "../src/hub.ts";

// gr_5ltmbf3a2f step 3 (kr_f722z9ut50): a hosted collective started with a key works from its first tick: the explore tick
// reserves a chunk under the founder's goal, the Workshop's manager-resident files a grant proposal that lands in the
// founder's Town Hall in-tray, and the session runs (and is booked) on the founder's own key input.
const KEY = "sk-ant-api03-founder-key-0123456789abcdef";
const OCTO = { id: 2002, login: "octo", name: "Octo Cat", avatar_url: "https://avatars.test/2002" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** A fake Agent SDK: the explorer files one grant proposal and its report, through the town's verbs (in-process). */
function explorerSdk(world: World): Sdk & { sessions: { agentId: string | null; env: Record<string, string> }[] } {
  const sessions: { agentId: string | null; env: Record<string, string> }[] = [];
  let n = 0;
  async function* call(agentId: string, verb: VerbName, input: Record<string, unknown>) {
    const id = `tu_${++n}`;
    yield { type: "assistant", session_id: "sdk-1", message: { content: [{ type: "tool_use", id, name: `mcp__town__${verb}`, input }] } };
    const out = await (world.verbs[verb] as (a: string, i: unknown) => Promise<unknown>)(agentId, input);
    yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(out) }] } };
  }
  return {
    sessions,
    query({ prompt, options = {} }) {
      const town = options.mcpServers?.town as { headers?: Record<string, string> } | undefined;
      const agentId = world.tokens.resolve(town?.headers?.Authorization?.replace(/^Bearer /, "") ?? "")?.id ?? null;
      const first = sessions.push({ agentId, env: (options.env ?? {}) as Record<string, string> }) === 1;
      async function* explore() {
        yield* call(agentId!, "propose_grant", {
          objective: "Map the first ten community gardens", approach: "Walk the city's open data, one source card per garden",
          stopCondition: "Ten gardens mapped or 150,000 tokens", askTokens: 150_000,
          keyResults: [{ text: "Ten gardens on the map", howToCheck: "The library lists ten garden source cards", due: "2026-11-20" }],
        });
        yield* call(agentId!, "submit_report", { title: "Explored: garden map", verdict: "stop", body: "## What I did\nLooked.\n\n## Findings\nA grant proposal.\n\n## What I need from you\nDecide the proposal." });
      }
      async function* run() {
        if (typeof prompt !== "string") await prompt[Symbol.asyncIterator]().next(); // the first user message is the prompt
        yield { type: "system", subtype: "init", session_id: "sdk-1", tools: [] };
        // only the explorer acts; any later session (the manager reading its fork's report) just ends
        if (first) yield* explore();
        yield {
          type: "result", subtype: "success", is_error: false, result: "done", num_turns: 4, total_cost_usd: 0.2, session_id: "sdk-1",
          usage: { input_tokens: 2000, output_tokens: 0 },
          modelUsage: { "claude-opus-5-5": { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2 } },
        };
      }
      return Object.assign(run(), { async interrupt() {} });
    },
  };
}

async function start(apiKey?: string) {
  const hub: Hub = new Hub(mkdtempSync(join(tmpdir(), "hub-explore-")), (w: World, row: HubCollective, dir: string) => buildApp({
    world: w, webDist: false, prefix: `/${row.slug}`, exportDir: join(dir, "export"), runtime: null,
    retire: () => hub.retire(row.slug),
  }));
  cleanups.push(() => hub.close());
  await hub.create({ name: "Garden Club", goal: "Map every community garden in town", apiKey }, OCTO);
  const world = hub.world("garden-club")!;
  const dir = hub.dirOf("garden-club");
  const sdk = explorerSdk(world);
  // as main.ts startHosted: its own runtime, no timer (the host's rotation ticks it); hosted means in-process desks
  const runtime = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/garden-club/mcp", sdk, intervalMs: 0, exportDir: false, hosted: { dir } });
  cleanups.push(() => runtime.stop());
  return { hub, world, runtime, sdk };
}

describe("a hosted collective's first explorer", () => {
  it("explores at once: the tick reserves a chunk, the resident's grant proposal lands in the founder's in-tray, billed on the founder's key", async () => {
    const { world, runtime, sdk } = await start(KEY);
    const founder = world.users.first("githubId = ?", [OCTO.id])!;
    const keyInput = world.bank.liveApiKeyInput()!;
    const lab = world.buildings.first("kind != 'town-hall'")!;
    const before = world.bank.balance();
    expect(world.goals.get(ROOT_GOAL_ID)).toMatchObject({ text: "Map every community garden in town", ownerId: founder.id });

    await runtime.tickOnce!();
    await runtime.whenIdle();

    // the tick reserved one chunk under the founder's goal for the Workshop
    const reservations = world.bankReservations.where("buildingId = ?", [lab.id]);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ goalId: ROOT_GOAL_ID });
    const asg = world.assignments.get(reservations[0]!.assignmentId!)!;
    expect(asg.lane).toBe("exploration");

    // the resident's session ran on the founder's key input, and only on it
    const sessions = world.sessions.where("assignmentId = ?", [asg.id]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "done", funding: "api-key", credentialInputId: keyInput.id });
    expect(sdk.sessions[0]).toMatchObject({ agentId: asg.agentId });
    // every session it ran (the explorer, then the manager reading its report) was on the founder's key, never a token
    for (const s of sdk.sessions) expect(s.env).toMatchObject({ ANTHROPIC_API_KEY: KEY });
    for (const s of sdk.sessions) expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    for (const s of world.sessions.all()) expect(s).toMatchObject({ funding: "api-key", credentialInputId: keyInput.id });
    // and the Bank booked them against the key's credit
    expect(world.bank.balance()).toBeLessThan(before);

    // its proposal is open under the root and goes to the founder (the root's captain), not to "the admins"
    const grant = world.grants.first("buildingId = ?", [lab.id])!;
    expect(grant).toMatchObject({ status: "proposed", askTokens: 150_000 });
    expect(world.goalTree.route({ grantId: grant.id })).toMatchObject({ userId: founder.id });
  });

  it("started without one (Hollyville): nothing explores until the founder adds a key at the Bank, then the next tick does", async () => {
    const { world, runtime } = await start();
    const founder = world.users.first("githubId = ?", [OCTO.id])!;
    await runtime.tickOnce!();
    await runtime.whenIdle();
    expect(world.bankReservations.all()).toHaveLength(0);
    expect(world.sessions.all()).toHaveLength(0);
    // the Bank's Donate form: To the Bank, API key, 1M tokens once (its default)
    world.bank.addInput(founder.id, { label: "octo's API key", source: "api-key", model: "claude-opus-5-5", tokens: 1_000_000, recurrence: "once", apiKey: KEY });
    await runtime.tickOnce!();
    await runtime.whenIdle();
    expect(world.bankReservations.all()).toHaveLength(1);
    expect(world.grants.first("status = 'proposed'")).toBeTruthy();
  });
});
