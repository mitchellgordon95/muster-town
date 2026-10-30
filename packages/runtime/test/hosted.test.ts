import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NO_KEY_HOLD } from "@muster-town/core";
import { HOSTED_MAX_RUNNING } from "../src/index.ts";
import { callVerb, init, result, setup, type FakeSession } from "./helpers.ts";

/** A hosted collective's runtime (docs/hosted-collectives.md, step 5): its own key only, never the host's credentials. */
const HOST_KEY = "sk-ant-api03-WORKSHOP-HOST-KEY";
const HOST_TOKEN = "sk-ant-oat01-WORKSHOP-SUBSCRIPTION";
const OWNER_KEY = "sk-ant-api03-owner-key";

async function* work(s: FakeSession) {
  yield init();
  yield* callVerb(s, "submit_report", { title: "First look", verdict: "stop", body: "## What I did\nLooked.\n\n## Findings\nNone.\n\n## What I need from you\nNothing needed." });
  yield result(800, 0.1, "Report submitted.");
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
  Object.assign(process.env, { ANTHROPIC_API_KEY: HOST_KEY, CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: "/root/.claude" });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function hosted() {
  const dir = mkdtempSync(join(tmpdir(), "hosted-"));
  const t = setup(work, { hosted: { dir } });
  const { world, lab } = t;
  world.host.hosted = true;
  // a hosted collective has no allocations of the host's: only what its own Bank holds
  for (const a of world.allocations.where("buildingId = ?", [lab.id])) world.budget.retire(a.id);
  const addKey = () => world.bank.addInput(t.seed.admin.id, { label: "Owner key", source: "api-key", model: "m", tokens: 1_000_000, apiKey: OWNER_KEY } as never);
  return { ...t, dir, addKey };
}

describe("hosted runtime", () => {
  test("no key yet: work is held (not failed), nothing reaches the SDK, chat says why", async () => {
    const { world, runtime, sdk, by } = hosted();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Look around" });
    expect(world.budget.canStart(noor.id, world.assignments.get(asg.id)!)).toBe(false);
    expect(world.assignments.get(asg.id)!.heldReason).toBe(NO_KEY_HOLD);
    await runtime.tickOnce();
    await runtime.whenIdle();
    await expect(runtime.runWorkSession(noor.id, asg.id)).rejects.toThrow(/No key yet/);
    const reply = await runtime.chat(noor.id, { message: "hi", history: [] });
    expect(reply.reply).toMatch(/No key yet/);
    expect(sdk.sessions).toHaveLength(0);
    expect(world.assignments.get(asg.id)!.status).toBe("pending");
    expect(world.agents.get(noor.id)!.status).toBe("idle");
  });

  test("with the owner's key: the session runs on it, in its own config dir; no host key or token in the options", async () => {
    const { world, runtime, sdk, by, dir, addKey } = hosted();
    addKey();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Look around" });
    expect(world.budget.canStart(noor.id, world.assignments.get(asg.id)!)).toBe(true);
    const session = await runtime.runWorkSession(noor.id, asg.id);
    expect(session.status).toBe("done");
    expect(session.funding).toBe("api-key");
    const env = sdk.sessions[0]!.options.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(OWNER_KEY);
    expect(env.HOME).toBe(join(dir, "home"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(dir, "claude"));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const all = JSON.stringify(sdk.sessions.map((s) => s.options));
    expect(all).not.toContain(HOST_KEY);
    expect(all).not.toContain(HOST_TOKEN);
    expect(all).not.toContain("/root/.claude");
  });

  test("one session at a time, and no redeploy of the host", () => {
    const { world, runtime } = hosted();
    expect(world.host.slots!().max).toBe(HOSTED_MAX_RUNNING);
    expect(world.host.redeploy).toBeUndefined();
    expect(() => runtime.redeploy({ image: false, requestedBy: "owner" })).toThrow(/can't redeploy/);
  });

  test("the Workshop's runtime (not hosted) still sees the host env", async () => {
    delete process.env.ANTHROPIC_API_KEY; // the host carries one credential (two is a hard failure: post-mortem 2026-10-30)
    const { world, runtime, sdk, by } = setup(work);
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Look around" });
    await runtime.runWorkSession(noor.id, asg.id);
    const env = sdk.sessions[0]!.options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expect(typeof world.host.redeploy).toBe("function");
  });
});
