/** v1.2 runtime: startup reconcile, dismissal hook. */
import { describe, expect, test, vi } from "vitest";
import type { Agent } from "@muster-town/schema";
import { DockerBackend, HostBackend, startRuntime, type DeskBackend, type DeskChild, type DeskHandle, type DockerRunner, type RunResult } from "../src/index.ts";
import { result, setup } from "./helpers.ts";

class FakeDesk implements DeskBackend {
  readonly kind = "docker" as const;
  removed: { agentId: string; purge: boolean }[] = [];
  execs: { argv: string[]; exit(code: number): void; killed: boolean }[] = [];
  async available() { return true; }
  async ensure(a: Agent): Promise<DeskHandle> { return { name: `desk-test-${a.id}`, agentId: a.id }; }
  exec(_h: DeskHandle, argv: string[]): DeskChild {
    let exit!: (c: number) => void;
    const done = new Promise<number>((r) => { exit = r; });
    const rec = { argv, exit, killed: false };
    this.execs.push(rec);
    return { wait: () => done, kill: () => { rec.killed = true; exit(137); } };
  }
  async remove(agentId: string, o: { purge?: boolean } = {}) { this.removed.push({ agentId, purge: !!o.purge }); }
  orphansKilled: string[] = [];
  async killOrphan(agentId: string, sessionId: string) { this.orphansKilled.push(`${agentId} ${sessionId}`); }
}
const REPORT = { title: "PR done", verdict: "continue", body: "## Summary\nOpened a PR.\n\n## Proposal for next session\nNext?\n" } as const;

describe("startup reconcile", () => {
  test("a new runtime ends orphaned running sessions and re-queues their active assignments", async () => {
    const { world, by, sdk } = setup(async function* () { yield result(1, 0); });
    const mei = by("Mei");
    const asg = world.ops.createWork(null, mei.id, { title: "Orphan" });
    const s = world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: asg.id, backend: "docker" });
    expect(world.assignments.require(asg.id).status).toBe("active");
    // a second runtime on the same world = a restart: no live children
    const rt = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk, intervalMs: 0, exportDir: false, deskBackend: new HostBackend() });
    try {
      expect(rt.reconciled.orphanedSessions).toEqual([s.id]);
      expect(rt.reconciled.requeuedAssignments).toEqual([asg.id]);
      expect(world.sessions.require(s.id)).toMatchObject({ status: "error", error: "orphaned at restart" });
      expect(world.assignments.require(asg.id).status).toBe("pending");
      expect(world.agents.require(mei.id)).toMatchObject({ status: "idle", currentAssignmentId: null });
    } finally {
      await rt.stop();
    }
  });

  test("a docker orphan's leftover desk process is killed (the container outlives the server)", async () => {
    const { world, by, sdk } = setup(async function* () { yield result(1, 0); });
    const mei = by("Mei"), noor = by("Noor");
    const s = world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: world.ops.createWork(null, mei.id, {}).id, backend: "docker" });
    world.ops.startSession(noor.id, { purpose: "work", model: "m", backend: "host" });
    const desk = new FakeDesk();
    const rt = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk, intervalMs: 0, exportDir: false, deskBackend: desk });
    try {
      await rt.whenIdle();
      expect(desk.orphansKilled).toEqual([`${mei.id} ${s.id}`]);
    } finally {
      await rt.stop();
    }
  });
});

describe("dismissal", () => {
  test("onAgentRetired aborts the desk session and removes the container (purge passed through)", async () => {
    const desk = new FakeDesk();
    const { world, runtime, by } = setup(async function* () { yield result(1, 0); }, { deskBackend: desk, killGraceMs: 0 });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, {});
    const running = runtime.runWorkSession(noor.id, asg.id);
    await vi.waitFor(() => expect(desk.execs).toHaveLength(1));
    world.ops.dismissAgent(null, noor.id, { purge: false });
    await runtime.onAgentRetired(noor.id, { purge: false });
    const s = await running;
    expect(desk.execs[0].killed).toBe(true);
    expect(s.status).toBe("interrupted");
    expect(desk.removed).toEqual([{ agentId: noor.id, purge: false }]);
    expect(world.agents.require(noor.id).status).toBe("retired");
    expect(world.docs.require(s.reportId!).decisionNote).toMatch(/dismissed/);
    expect(world.assignments.require(asg.id).status).toBe("cancelled");
  });

  test("DockerBackend.remove: rm -f the container; volume only with purge", async () => {
    const calls: string[] = [];
    const runner: DockerRunner = { async run(args): Promise<RunResult> { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; }, spawn() { throw new Error("no"); } };
    const b = new DockerBackend({ collective: "climate", runner });
    await b.remove("ag_1");
    expect(calls).toEqual(["rm -f desk-climate-ag_1"]);
    await b.remove("ag_1", { purge: true });
    expect(calls.slice(1)).toEqual(["rm -f desk-climate-ag_1", "volume rm -f deskhome-ag_1"]);
  });
});
