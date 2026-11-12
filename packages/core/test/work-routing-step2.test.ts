/**
 * Work routing step 2 (1:1 mt_lsyqj98z0w, design note dc_vxsq9g008a): what a forking manager must itself see (a relayed
 * tell, an @mention, an outbox answer) is an entry on its building's thread at level manager (plan dc_uwx045472m step
 * 5b: no town-written report), never a job; a retired fork's outbox
 * answer is its building's job on the asking chain (hole B2); a forking manager's leftover own-queue rows move to the
 * building queue at boot; a retry of one goes to the building queue.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createAssignment, createBuilding, createResident, forkManager, jobThread, moveManagerRowsToBuildingQueue, openManagerEntries, retireFork, setAssignmentStatus, updateBuilding } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

/** Pix manages Forky (forks on); Ann is a resident working on an assignment a human gave her (so her tells carry an origin). */
function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 6, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  const bo = createResident(world, { buildingId: b.id, name: "Bo" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const work = createAssignment(world, { agentId: ann.id, title: "From the admin", description: "x", createdBy: { kind: "user", id: seed.admin.id } });
  world.ops.startSession(ann.id, { purpose: "work", model: "m", assignmentId: work.id });
  world.setStatus(pix.id, "idle", "idle");
  const rows = (rule: string) => openManagerEntries(world, b.id).filter((e) => e.moved.rule === rule);
  /** the town writes no report doc for any of them (kr_o8dbx2axii) */
  const townDocs = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report'", [b.id]);
  const jobsFor = (agentId: string) => world.assignments.where("agentId = ? AND status = 'pending'", [agentId]);
  return { ...s, b, pix: world.agents.require(pix.id), ann: world.agents.require(ann.id), bo: world.agents.require(bo.id), rows, jobsFor, townDocs };
}

describe("work routing step 2: a forking manager's messages are entries on its building's thread", () => {
  it("a tell that traces to a human, to the manager or its building id: one human entry for the manager, no job, no report doc; a replay writes nothing", async () => {
    const { world, b, pix, ann, rows, jobsFor, townDocs } = lab();
    const r = await world.verbs.tell(ann, { to: b.id, text: "Please look at the outbox\nit is stuck" }) as { entryId?: string; assignmentId?: string; note?: string };
    expect(r.assignmentId).toBeUndefined();
    const [row] = rows("relay");
    expect(r.entryId).toBe(row!.id);
    expect(r.note).toContain("thread");
    expect(row).toMatchObject({ jobId: `jb_${b.id}`, authorKind: "human", level: "manager", docId: null });
    expect(jobThread(world, b.id)!.entries.map((e) => e.id)).toContain(row!.id);
    expect(townDocs()).toHaveLength(0);
    expect(row!.note).toMatch(/^Message from .* \(via Ann\): Please look at the outbox$/);
    expect(row!.body).toContain("it is stuck");
    expect(row!.body).toContain(`\`tell\` (id ${ann.id})`);
    expect(jobsFor(pix.id)).toHaveLength(0);
    const { relayWake } = await import("../src/index.ts");
    expect(relayWake(world, ann, world.events.list({ types: ["agent.told"], limit: 100 }).at(-1)!)).toBeNull();
    // a second tell is its own row (one per message)
    await world.verbs.tell(ann, { to: pix.id, text: "and the board" });
    expect(rows("relay")).toHaveLength(2);
  });

  it("a tell with no human origin stays inbox only", async () => {
    const { world, pix, bo, rows, jobsFor } = lab();
    const r = await world.verbs.tell(bo, { to: pix.id, text: "fyi" }) as { entryId?: string };
    expect(r.entryId).toBeUndefined();
    expect(rows("relay")).toHaveLength(0);
    expect(jobsFor(pix.id)).toHaveLength(0);
  });

  it("an @mention of the manager that traces to a human: an entry naming who mentioned it", async () => {
    const { world, pix, ann, bo, rows, jobsFor } = lab();
    world.setStatus(bo.id, "working", "busy");
    await world.verbs.tell(ann, { to: bo.id, text: "@Pix can you decide the rename?" });
    const [row] = rows("mention");
    expect(row!.note).toMatch(/^Mentioned by Ann for .*: /);
    expect(row!.body).toContain("can you decide the rename?");
    expect(jobsFor(pix.id)).toHaveLength(0);
  });

  it("an outbox answer to the manager's request is an entry; a retired fork's is its building's job on the asking chain (B2)", async () => {
    const { world, b, pix, rows, jobsFor } = lab();
    const human = world.ops.createUser("Rando").user;
    const avatar = world.ops.ensureAvatar(human.id);
    const answer = async (asker: typeof pix, title: string) => {
      const { id } = await world.verbs.request_human(asker, { title, body: "please", location: "x" });
      world.ops.requestAction(avatar, id, "claim");
      return world.ops.requestAction(avatar, id, "done", "Done: 40 m wide.");
    };
    await answer(pix, "Photograph the slump");
    const [row] = rows("request-answer");
    expect(row!.note).toBe("Answer to Pix's request Photograph the slump: Done: 40 m wide.");
    expect(row!.body).toContain("Done: 40 m wide.");
    expect(jobsFor(pix.id)).toHaveLength(0);

    // a fork asked, then retired: the answer goes on the building queue, continuing the fork's chain
    const asked = createAssignment(world, { agentId: pix.id, title: "Survey", description: "d", createdBy: { kind: "system", id: "system" }, lane: { gap: "g" } });
    const { fork } = forkManager(world, b.id, asked.id);
    setAssignmentStatus(world, asked.id, "active");
    world.agents.patch(fork.id, { currentAssignmentId: asked.id });
    const { id } = await world.verbs.request_human(fork, { title: "Count the geese", body: "please", location: "x" });
    setAssignmentStatus(world, asked.id, "done");
    retireFork(world, fork.id, { reason: "done" });
    world.ops.requestAction(avatar, id, "claim");
    world.ops.requestAction(avatar, id, "done", "Twelve geese.");
    const [job] = buildingQueue(world, b.id);
    expect(job).toMatchObject({ agentId: pix.id, queue: "building", chainId: asked.id, lane: "directed" });
    expect(job!.title).toMatch(/^Answer to Pix 1's request Count the geese: Twelve geese\.$/);
  });
});

describe("work routing step 2: no work session as a forking manager", () => {
  it("boot repair moves a forking manager's pending own-queue rows to the building queue, once; others stay", () => {
    const { world, b, pix, ann } = lab();
    const by = { kind: "system" as const, id: "system" };
    const old = world.assignments.upsert({ ...createAssignment(world, { agentId: pix.id, title: "Answer the counter on X", description: "d", createdBy: by, lane: { gap: "g" } }), queue: "agent" });
    const anns = createAssignment(world, { agentId: ann.id, title: "Ann's", description: "d", createdBy: by, lane: { gap: "g" } });
    expect(moveManagerRowsToBuildingQueue(world)).toEqual([old.id]);
    expect(world.assignments.require(old.id).queue).toBe("building");
    expect(world.assignments.require(anns.id).queue).toBe("agent");
    expect(buildingQueue(world, b.id).map((a) => a.id)).toContain(old.id);
    expect(world.events.list({ types: ["system"], limit: 50 }).filter((e) => (e.payload as { queueRepair?: boolean }).queueRepair)).toHaveLength(1);
    expect(moveManagerRowsToBuildingQueue(world)).toEqual([]);
  });

  it("a retry of a forking manager's own-queue row goes to the building queue", () => {
    const { world, admin, pix } = lab();
    const old = world.assignments.upsert({ ...createAssignment(world, { agentId: pix.id, title: "Old", description: "d", createdBy: { kind: "system", id: "system" }, lane: { gap: "g" } }), queue: "agent" });
    setAssignmentStatus(world, old.id, "cancelled");
    expect(world.ops.retryAssignment(admin, old.id).queue).toBe("building");
  });
});
