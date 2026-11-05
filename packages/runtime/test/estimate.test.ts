import { describe, expect, test } from "vitest";
import { buildingRoleId } from "@muster-town/core";
import { result, setup, text } from "./helpers.ts";

const LAB = "carbon-cycle";

/** Propose a grant the way propose_grant does; the grant.proposed event starts the model's estimate in the background. */
async function propose(world: ReturnType<typeof setup>["world"], runtime: ReturnType<typeof setup>["runtime"]) {
  const manager = world.agents.require(world.buildings.require(LAB).managerAgentId!);
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const r = await world.verbs.propose_grant(manager, { keyResults: [{ text: "a check", howToCheck: "look" }], objective: "Estimate me", approach: "one PR", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 150_000 });
  await runtime.whenIdle();
  return { manager, grant: world.grantDesk.get(r.grantId) };
}

describe("a grant's cost estimate from the cheap model (1:1 mt_c9u1kr15jp, step 2)", () => {
  test("one call on the building's cheapModel after the propose: its range is saved beside the history range; booked as a directed session", async () => {
    const answer = '{"low": 120000, "high": 260000, "reason": "Like the one-PR grants before it."}';
    const { world, runtime, sdk } = setup(async function* (s) {
      if (!s.agentId) { yield text(answer); yield result(40, 0.0002, answer); }
    });
    const { manager, grant } = await propose(world, runtime);
    const calls = sdk.sessions.filter((s) => !s.agentId);
    expect(calls).toHaveLength(1);
    const building = world.buildings.require(LAB);
    expect(calls[0].options.model).toBe(building.cheapModel);
    expect(calls[0].received[0]).toContain("Objective: Estimate me");
    expect(calls[0].received[0]).toContain("Approach: one PR");
    expect(grant.status).toBe("proposed");
    expect(grant.askTokens).toBe(150_000);
    expect(grant.estimate?.model).toMatchObject({ low: 120_000, high: 260_000, note: "Like the one-PR grants before it.", modelId: building.cheapModel });
    const session = world.sessions.first("purpose = 'estimate'")!;
    expect(session).toMatchObject({ agentId: manager.id, status: "done", lane: "directed" });
    expect(grant.estimate?.model?.sessionId).toBe(session.id);
    expect(session.tokens).toBeGreaterThan(0);
  });

  test("a failed call leaves the proposal with the history range only", async () => {
    const { world, runtime } = setup(async function* (s) {
      if (!s.agentId) { yield text("Not logged in"); yield { ...result(0, 0, "Not logged in"), subtype: "error_during_execution", is_error: true }; }
    });
    const { grant } = await propose(world, runtime);
    expect(grant.status).toBe("proposed");
    expect(grant.estimate).not.toBeNull();
    expect(grant.estimate?.model).toBeNull();
    expect(world.sessions.first("purpose = 'estimate'")!.status).toBe("error");
  });

  test("an unusable answer (no range) is not saved", async () => {
    const { world, runtime } = setup(async function* (s) {
      if (!s.agentId) { yield text("Probably about 200k."); yield result(20, 0, "Probably about 200k."); }
    });
    const { grant } = await propose(world, runtime);
    expect(grant.estimate?.model).toBeNull();
  });
});

describe("open proposals at boot", () => {
  test("a proposal made before the model step (no estimate recorded) gets its history range and the model's at the next boot", async () => {
    const answer = '{"low": 90000, "high": 210000, "reason": "r"}';
    const first = setup(async function* () { /* no call expected */ });
    const { world } = first;
    const manager = world.agents.require(world.buildings.require(LAB).managerAgentId!);
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.propose_grant(manager, { keyResults: [{ text: "a check", howToCheck: "look" }], objective: "Old proposal", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 150_000 });
    await first.runtime.whenIdle();
    // as proposed before migration 083: nothing recorded
    world.grants.upsert({ ...world.grants.require(r.grantId), estimate: null });
    const updatedAt = world.grants.require(r.grantId).updatedAt;
    await first.runtime.stop();
    const { startRuntime, HostBackend } = await import("../src/index.ts");
    const { fakeSdk } = await import("./helpers.ts");
    const sdk = fakeSdk(world, async function* (s) { if (!s.agentId) { yield text(answer); yield result(30, 0, answer); } });
    const runtime = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk, intervalMs: 0, exportDir: false, deskBackend: new HostBackend() });
    await new Promise((res) => setTimeout(res, 50));
    await runtime.whenIdle();
    const g = world.grants.require(r.grantId);
    expect(g.estimate?.sample).toBe(0);
    expect(g.estimate?.model).toMatchObject({ low: 90_000, high: 210_000 });
    expect(g.updatedAt).toBe(updatedAt);
    await runtime.stop();
  });
});
