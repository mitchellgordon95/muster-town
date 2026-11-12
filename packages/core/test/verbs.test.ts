import { isAnswered } from "../src/jobs.ts";
import { describe, expect, it } from "vitest";
import { entryOf, buildingRoleId, cabinetDocs, createBuilding, createResident, extractProposal, intrayWorker, isTownHallItem, managerAgentOf, setAssignmentStatus, TOWN_HALL_ID } from "../src/index.ts";
import { seededWorld, tickUntil } from "./helpers.ts";
import { RequestStatus } from "@muster-town/schema";

const REPORT = `## Summary
Did a thing.

## Findings
Numbers with units.

## Proposal for next session
**Question:** How big is the ocean sink in 2024?

Why it matters: because.

## For others
- nothing`;

describe("write / read / board / search", () => {
  it("drafts are private; publishing needs doc.write_building or a home there; authors update their own docs", async () => {
    const { world, by, seed } = seededWorld();
    const mei = by("Mei"), tomas = by("Tomas");
    const { id } = await world.verbs.write(mei, { title: "Ocean notes", body: "solubility pump details" });
    expect(world.docs.require(id).state).toBe("draft");
    await expect(world.verbs.read(tomas, { id })).rejects.toMatchObject({ code: "not_found" });
    expect((await world.verbs.read(mei, { id })).body).toContain("solubility");
    expect((await world.verbs.search(tomas, { query: "solubility" })).results).toHaveLength(0);
    expect((await world.verbs.search(mei, { query: "solubility" })).results.map((r) => r.id)).toContain(id);

    await world.verbs.write(mei, { id, title: "Ocean notes", body: "solubility pump details v2", state: "building" });
    expect(world.docs.require(id).state).toBe("building");
    expect(cabinetDocs(world, "carbon-cycle", 50).map((d) => d.id)).toContain(id);
    expect((await world.verbs.board(tomas, {})).docs.map((d) => d.id)).not.toContain(id);
    await world.verbs.write(mei, { id, type: "fyi", title: "Ocean notes", body: "solubility pump details v3", state: "building" });
    expect((await world.verbs.board(tomas, {})).docs.map((d) => d.id)).toContain(id);
    await expect(world.verbs.write(tomas, { id, title: "x", body: "y" })).rejects.toMatchObject({ code: "forbidden" });

    // a visitor without the member role files in its own building's cabinet (residents publish, gr_2r17x8egrc) but posts no FYI
    const { agent: v } = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: "carbon-cycle", inheritsOwner: false });
    expect((await world.verbs.write(v, { title: "t", body: "b", state: "building" })).state).toBe("building");
    await expect(world.verbs.write(v, { type: "fyi", title: "t", body: "b", state: "building" })).rejects.toMatchObject({ code: "forbidden", permission: "doc.write_building" });
    await expect(world.verbs.write(mei, { type: "report", title: "t", body: "b" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("FTS search finds imported library docs by content and filters", async () => {
    const { world, by } = seededWorld();
    const r = await world.verbs.search(by("Noor"), { query: "Friedlingstein", type: "source" });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((d) => d.type === "source")).toBe(true);
    expect((await world.verbs.search(by("Noor"), { query: "((( \"" })).results.length).toBeGreaterThan(0); // no FTS syntax errors
  });

  it("invalid input is a bad_request", async () => {
    const { world, by } = seededWorld();
    await expect(world.verbs.say(by("Noor"), {} as never)).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("report state machine", () => {
  it("extracts the Proposal section", () => {
    expect(extractProposal(REPORT)).toMatchObject({ title: "How big is the ocean sink in 2024?" });
    expect(extractProposal(REPORT)!.text).not.toContain("For others");
    expect(extractProposal("## Summary\nx")).toBeNull();
  });

  it("submit_report → pending in the in-tray + agent idle; continue → next assignment from Proposal", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const work = world.ops.createWork(admin, mei.id, { title: "First question", description: "go" });
    const session = world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: work.id });
    expect(world.agents.require(mei.id)).toMatchObject({ status: "working", currentAssignmentId: work.id });
    expect(world.assignments.require(work.id).status).toBe("active");

    const res = await world.verbs.submit_report(mei, { title: "Run 1", body: REPORT, verdict: "continue" });
    expect(res.decision).toBe("pending");
    const doc = world.docs.require(res.id);
    expect(doc).toMatchObject({ type: "report", state: "building", decision: "pending", assignmentId: work.id, sessionId: session.id, authorId: mei.id });
    expect(world.assignments.require(work.id)).toMatchObject({ status: "done", reportId: res.id });
    expect(world.agents.require(mei.id)).toMatchObject({ status: "idle", currentAssignmentId: null });
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).toContain(res.id);
    world.ops.endSession(session.id, { status: "done", tokens: 10 });
    expect(world.sessions.require(session.id).reportId).toBe(res.id);
    expect(world.agents.require(mei.id).status).toBe("idle");

    // a member can't review
    await expect(world.verbs.review(by("Tomas"), { docId: res.id, decision: "approve" })).rejects.toMatchObject({ code: "forbidden", permission: "building.review" });
    const r = await world.verbs.review(admin, { docId: res.id, decision: "continue", note: "good" });
    const next = world.assignments.require(r.assignmentId!);
    expect(next).toMatchObject({ agentId: mei.id, title: "How big is the ocean sink in 2024?", status: "pending", fromReportId: res.id, createdBy: admin.ownerUserId });
    expect(next.description).toContain("Why it matters");
    expect(next.description).toContain("good");
    expect(world.docs.require(res.id)).toMatchObject({ decision: "continue", decidedBy: admin.ownerUserId, decisionNote: "good" });
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).not.toContain(res.id);
    expect(world.agents.require(mei.id).status).toBe("idle");
    await expect(world.verbs.review(admin, { docId: res.id, decision: "stop" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("approve acknowledges without an assignment", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const before = world.assignments.count("agentId = ?", [mei.id]);
    const a = await world.verbs.submit_report(mei, { title: "R", body: REPORT, verdict: "continue" });
    const r = await world.verbs.review(admin, { docId: a.id, decision: "approve" });
    expect(r.assignmentId).toBeNull();
    expect(world.assignments.count("agentId = ?", [mei.id])).toBe(before);
    expect(world.docs.require(a.id).decision).toBe("approve");
    expect(world.agents.require(mei.id).status).toBe("idle");
  });

  it("redirect assigns the note (required) with the proposal as context; stop stops and cancels; reviewer agents can review", async () => {
    const { world, by, admin } = seededWorld();
    const moss = by("Moss"), mei = by("Mei"), tomas = by("Tomas");
    const a = await world.verbs.submit_report(mei, { title: "R", body: REPORT, verdict: "continue" });
    await expect(world.verbs.review(moss, { docId: a.id, decision: "redirect", note: "  " })).rejects.toMatchObject({ code: "bad_request" });
    const r = await world.verbs.review(moss, { docId: a.id, decision: "redirect", note: "Focus on the Southern Ocean.\nUse SOCAT.", gap: "The ocean sink is unmeasured" });
    const next = world.assignments.require(r.assignmentId!);
    expect(next.title).toBe("Focus on the Southern Ocean.");
    expect(next.description).toMatch(/redirected you[\s\S]*Focus on the Southern Ocean\.\nUse SOCAT\./);
    expect(next.description).toMatch(/For context, your report proposed:[\s\S]*How big is the ocean sink in 2024\?/);
    // stop: pending assignments are cancelled
    const pending = world.ops.createWork(null, tomas.id, { title: "Queued work" });
    const b = await world.verbs.submit_report(tomas, { title: "R2", body: "## Summary\nnothing", verdict: "stop" });
    const s = await world.verbs.review(moss, { docId: b.id, decision: "stop" });
    expect(s.assignmentId).toBeNull();
    expect(world.agents.require(tomas.id).status).toBe("stopped");
    expect(world.assignments.require(pending.id).status).toBe("cancelled");
  });

  it("a building with a manager agent: residents' reports and the manager's own work reports go to its in-tray without notifying humans; a rollup is refused, and what the manager asks a human is an ask in the Town Hall queue", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    expect(intrayWorker(world, world.buildings.get("carbon-cycle"))).toBe("manager");
    const mitchell = world.users.require(admin.ownerUserId!, "user");
    // Noor's report mentions Mitchell and Mei: only Mei (an agent) is notified
    const r = await world.verbs.submit_report(noor, { title: "R1", body: `${REPORT}\n\n@${mitchell.name} @Mei please look`, verdict: "continue" });
    expect(r).toMatchObject({ decision: "pending", intray: "carbon-cycle", workedBy: "manager" });
    expect(r.note).toContain("Mei, your manager, works");
    expect(world.messages.where("kind = 'mention' AND toId = ?", [admin.id])).toHaveLength(0);
    expect(world.messages.where("kind = 'mention' AND toId = ?", [mei.id])).toHaveLength(1);
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).toContain(r.id);
    expect(world.ops.intray(TOWN_HALL_ID).map((d) => d.id)).not.toContain(r.id);
    // the manager decides it (building.review via the manager role)
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId("carbon-cycle", "manager"));
    await world.verbs.review(mei, { docId: r.id, decision: "approve" });
    // decision 6 (town hall 2026-10-25): the manager's own work report (not a rollup) is a building item like a
    // resident's: no human notified, not in the Town Hall, and the manager decides it itself in its team-lead session
    const own = await world.verbs.submit_report(mei, { title: "My own work", body: `${REPORT}\n\n@${mitchell.name} done`, verdict: "stop" });
    expect(own).toMatchObject({ decision: "pending", intray: "carbon-cycle", workedBy: "manager" });
    expect(own.note).toContain("which you work as its manager");
    expect(isTownHallItem(world, world.docs.require(own.id))).toBe(false);
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).toContain(own.id);
    expect(world.ops.intray(TOWN_HALL_ID)).toHaveLength(0);
    expect(world.messages.where("kind = 'mention' AND toId = ?", [admin.id])).toHaveLength(0);
    await expect(world.verbs.review(noor, { docId: own.id, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    await world.verbs.review(mei, { docId: own.id, decision: "approve" });
    expect(world.docs.require(own.id)).toMatchObject({ decision: "approve", decidedBy: mei.id });
    // nobody rolls up any more: a resident's or the manager's rollup is refused, and no report of theirs reaches the Town Hall
    await expect(world.verbs.submit_report(noor, { title: "x", body: REPORT, verdict: "stop", rollup: true })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/^Rollups are retired\./) });
    await expect(world.verbs.submit_report(mei, { title: "x", body: REPORT, verdict: "stop", rollup: true, provenance: { sourceIds: [r.id], urls: [] } })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/^Rollups are retired\./) });
    expect(world.ops.intray(TOWN_HALL_ID)).toHaveLength(0);
    expect(world.ops.townHallIntray()).toMatchObject({ reports: [], grants: [] });
    // what the manager needs from a human is an ask in the humans' queue, not a report
    const asked = await world.verbs.ask(mei, { type: "policy", title: "Should the banner show today's spend?", body: "Rule: the banner shows today's spend.\nI applied it on the lab banner this week.\nReversing it means the banner shows the balance only.", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" });
    expect(world.ops.townHallIntray().asks.map((a) => a.id)).toContain(asked.askId);
    expect(world.ops.intray(TOWN_HALL_ID)).toHaveLength(0);
    // a stopped manager hands the in-tray back to the humans
    world.setStatus(mei.id, "stopped");
    expect(intrayWorker(world, world.buildings.get("carbon-cycle"))).toBe("human");
    expect(managerAgentOf(world, world.buildings.get("carbon-cycle"))).toBeUndefined();
  });

  it("a grant awaiting a decision is a Town Hall in-tray row and counts in its badge", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId("carbon-cycle", "manager"));
    const g = world.grantDesk.create(mei, "carbon-cycle", { keyResults: [{ text: "a number with uncertainty", howToCheck: "read it" }], objective: "Ocean sink 2024", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "when the number is in", askTokens: 1_000_000 });
    expect(world.ops.townHallIntray().grants).toEqual([]);
    world.grantDesk.propose(mei, g.id);
    expect(world.ops.townHallIntray().grants.map((x) => x.id)).toEqual([g.id]);
    expect(world.ops.intrayCount(TOWN_HALL_ID)).toBe(1);
    expect(world.ops.intray(TOWN_HALL_ID)).toEqual([]);
  });

  it("imported pending report (Ravi run 1) is in the in-tray and can be continued into run 2", async () => {
    const { world, by, admin } = seededWorld();
    const ravi = by("Ravi");
    const report = world.docs.first("type = 'report' AND authorId = ?", [ravi.id])!;
    expect(report.decision).toBe("pending");
    expect(world.ops.intray("carbon-cycle")[0]!.id).toBe(report.id);
    expect(world.snapshot().buildings.find((b) => b.id === "carbon-cycle")!.intray).toBe(world.ops.intray("carbon-cycle").length);
    const r = await world.verbs.review(admin, { docId: report.id, decision: "continue" });
    expect(world.assignments.require(r.assignmentId!).title).toMatch(/land-use change emissions/);
  });

  it("in-tray is oldest first and changes resend the building with its count", async () => {
    const { world, by } = seededWorld();
    const sent: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "building" && m.building.id === "carbon-cycle" && m.building.intray !== undefined) sent.push(m.building.intray); });
    const base = world.ops.intray("carbon-cycle").length;
    const a = await world.verbs.submit_report(by("Mei"), { title: "A", body: REPORT, verdict: "continue" });
    const b = await world.verbs.submit_report(by("Noor"), { title: "B", body: REPORT, verdict: "continue" });
    const ids = world.ops.intray("carbon-cycle").map((d) => d.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(sent).toEqual([base + 1, base + 2]);
    await world.verbs.review(by("Moss"), { docId: a.id, decision: "approve" });
    expect(sent.at(-1)).toBe(base + 1);
  });
});

describe("assignments", () => {
  it("assign (permissioned), list, accept", async () => {
    const { world, by, admin } = seededWorld();
    const noor = by("Noor"), moss = by("Moss");
    await expect(world.verbs.assign(by("Mei"), { agentId: noor.id, title: "x", description: "y" })).rejects.toMatchObject({ code: "forbidden" });
    // one named manager per building (1:1 mt_wngibcr98b decision 1): an agent names only itself (or a visitor)
    await expect(world.verbs.assign(moss, { agentId: noor.id, title: "x", description: "y", gap: "g" })).rejects.toThrow(/Leave agentId out/);
    const { assignmentId } = await world.verbs.assign(moss, { agentId: moss.id, title: "Check Mauna Loa", description: "y", gap: "No Mauna Loa check" });
    expect((await world.verbs.assignments(moss, {})).assignments[0]).toMatchObject({ id: assignmentId, status: "pending" });
    await world.verbs.accept_assignment(moss, { id: assignmentId });
    expect(world.agents.require(moss.id).currentAssignmentId).toBe(assignmentId);
    expect((await world.verbs.look(moss, {})).notices.currentAssignment).toBe("Check Mauna Loa");
    // the manager naming itself queues to its building (work routing, mt_lsyqj98z0w): no "New assignment" message to itself
    expect(world.assignments.require(assignmentId).queue).toBe("building");
  });

  it("done and cancelled are terminal; a report on a cancelled assignment leaves it cancelled", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Check Mauna Loa" });
    world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id });
    // cancelled mid-session (e.g. a stop decision): currentAssignmentId is cleared but the session still points at it
    setAssignmentStatus(world, asg.id, "cancelled");
    world.agents.patch(noor.id, { currentAssignmentId: null });
    const { id: docId } = await world.verbs.submit_report(world.agents.require(noor.id), { title: "Run 1", body: REPORT, verdict: "continue" });
    expect(world.docs.require(docId)).toMatchObject({ type: "report", decision: "pending" });
    expect(world.assignments.require(asg.id)).toMatchObject({ status: "cancelled", reportId: null });
    expect(() => setAssignmentStatus(world, asg.id, "active")).toThrow(/already cancelled/);
    expect(setAssignmentStatus(world, asg.id, "cancelled").status).toBe("cancelled");
    const done = world.ops.createWork(null, noor.id, { title: "Done one" });
    setAssignmentStatus(world, done.id, "done");
    for (const s of ["pending", "active", "cancelled"] as const) expect(() => setAssignmentStatus(world, done.id, s)).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

describe("say / tell / inbox / look", () => {
  it("say is heard within Chebyshev 3 by agents only; inbox marks read", async () => {
    const { world, by, admin } = seededWorld();
    const noor = by("Noor"), tomas = by("Tomas"), ingrid = by("Ingrid");
    // place bodies deterministically
    world.agents.patch(noor.id, { pos: { x: 10, y: 10 } });
    world.agents.patch(tomas.id, { pos: { x: 13, y: 13 } }); // distance 3
    world.agents.patch(ingrid.id, { pos: { x: 14, y: 10 } }); // distance 4
    world.agents.patch(admin.id, { pos: { x: 11, y: 10 } }); // human nearby
    for (const a of world.agents.all()) if (![noor.id, tomas.id, ingrid.id, admin.id].includes(a.id)) world.agents.patch(a.id, { pos: { x: 0, y: 0 } });
    const r = await world.verbs.say(noor, { text: "Anyone have the 2024 growth rate?" });
    expect(r.heardBy).toEqual(["Tomas"]);
    expect(world.events.list({ types: ["agent.said"] }).at(-1)!.text).toBe("Anyone have the 2024 growth rate?");
    const inbox = await world.verbs.inbox(tomas, {});
    expect(inbox.messages).toMatchObject([{ kind: "heard", from: "Noor", body: "Anyone have the 2024 growth rate?" }]);
    expect((await world.verbs.inbox(tomas, {})).messages).toHaveLength(0);
    expect((await world.verbs.inbox(ingrid, {})).messages).toHaveLength(0);
    const look = await world.verbs.look(noor, {});
    expect(look.nearby.map((n) => n.name).sort()).toEqual(["Mitchell", "Tomas"]);
    expect(look.nearby.find((n) => n.name === "Mitchell")!.kind).toBe("human");
    // the hydrant (the decision queue) is a Town Hall station everyone can walk to; the Town Hall has no in-tray
    expect(look.places.some((p) => p.id === "hydrant:town-hall" && p.kind === "hydrant")).toBe(true);
    expect(look.places.some((p) => p.id === "intray:town-hall")).toBe(false);
    // the help sign of my home building is listed too
    expect(look.places.some((p) => p.id === `help:${noor.buildingId}` && p.kind === "help")).toBe(true);
  });

  it("tell to an idle or stopped resident says it won't start work; to a working one it says nothing", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const idle = await world.verbs.tell(by("Ravi"), { to: noor.id, text: "ping" });
    expect(world.agents.require(noor.id).status).toBe("idle");
    expect(idle.note).toMatch(/Noor is idle.*does not start work/);
    world.setStatus(noor.id, "stopped");
    expect((await world.verbs.tell(by("Ravi"), { to: noor.id, text: "ping" })).note).toMatch(/Noor is stopped/);
    world.setStatus(noor.id, "idle"); // resumed first: stopped → working is not in STATUS_TRANSITIONS
    world.setStatus(noor.id, "working");
    expect((await world.verbs.tell(by("Ravi"), { to: noor.id, text: "ping" })).note).toBeUndefined();
  });

  it("tell delivers a direct message and an event", async () => {
    const { world, by } = seededWorld();
    await world.verbs.tell(by("Ravi"), { to: by("Noor").id, text: "Please confirm 2.124 GtC/ppm" });
    const m = await world.verbs.inbox(by("Noor"), { markRead: false });
    expect(m.messages[0]).toMatchObject({ kind: "tell", from: "Ravi" });
    expect((await world.verbs.look(by("Noor"), {})).notices.unread).toBe(1);
    expect(world.events.list({ types: ["agent.told"] })).toHaveLength(1);
    await expect(world.verbs.tell(by("Ravi"), { to: "ag_nope", text: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("request_human lifecycle", () => {
  it("open → done (no claim: 1:1 mt_msnjkpgwdb decision 17) creates a library human-report, answers its entry on the thread and notifies the agent", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Photograph thaw slump", body: "If you're near...", location: "Yukon" });
    expect(world.docs.require(id)).toMatchObject({ type: "request", state: "building", requestStatus: "open", location: "Yukon" });
    expect(world.ops.outbox().map((d) => d.id)).toEqual([id]);
    const other = world.ops.createUser("Rando").user;
    const randoAvatar = world.ops.ensureAvatar(other.id);
    // it is a do ask in the decision queue, with the reason it is worth leaving the queue, and an entry at level human on the thread
    expect(world.docs.require(id).body).toContain("Worth leaving the queue: Only a human can do this");
    expect(world.asks.first("targetKind = 'request' AND targetId = ?", [id])).toMatchObject({ type: "do", status: "open", branches: [{ label: "Done", action: "done" }, { label: "Decline", action: "decline" }] });
    expect(entryOf(world, `en_${id}`)).toMatchObject({ level: "human", docId: id, moved: { kind: "do", requestId: id } });
    expect(() => world.ops.requestAction(randoAvatar, id, "claim" as never)).toThrow();
    expect(() => world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), id, "done")).toThrow(/needs your report back/);
    const { humanReport } = world.ops.requestAction(randoAvatar, id, "done", "Photos attached; slump is 40 m wide.");
    expect(humanReport).toMatchObject({ type: "human-report", state: "library", authorId: other.id, authorKind: "user" });
    expect(world.docs.require(id)).toMatchObject({ requestStatus: "done", claimedByUserId: other.id });
    expect(world.asks.first("targetKind = 'request' AND targetId = ?", [id])!.status).toBe("retired");
    expect(isAnswered(world, `en_${id}`)).toBe(true);
    expect(() => world.ops.requestAction(randoAvatar, id, "done", "again")).toThrow(/Request is done/);
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes(humanReport!.id))).toBe(true);
  });

  it("only an admin can delete a request; the requester is told", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Spam", body: "x" });
    const rando = world.ops.ensureAvatar(world.ops.createUser("Rando").user.id);
    expect(() => world.ops.requestAction(rando, id, "delete")).toThrow(/approve_request/);
    expect(world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), id, "delete").request).toBeNull();
    expect(world.docs.get(id)).toBeUndefined();
    expect(world.ops.outbox()).toHaveLength(0);
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes("deleted your request"))).toBe(true);
  });

  it("the open-requests count (the map's counter badge) follows requests filed, done and deleted: snapshot and live `outbox` frames", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const sent: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "outbox") sent.push(m.open); });
    const a = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Photo the slump", body: "x" });
    const b = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Call the office", body: "y" });
    await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Spam", body: "z" });
    expect(world.snapshot().outbox).toBe(3);
    const avatar = world.ops.ensureAvatar(world.ops.createUser("Rando").user.id);
    world.ops.requestAction(avatar, a.id, "done", "Done.");
    world.ops.requestAction(avatar, b.id, "done", "Called.");
    const spam = world.ops.outbox().find((d) => d.title === "Spam")!;
    world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), spam.id, "delete");
    expect(sent).toEqual([1, 2, 3, 2, 1, 0]);
    expect(world.snapshot().outbox).toBe(0);
    expect(world.ops.outbox().filter((d) => d.requestStatus === "open")).toHaveLength(0);
  });

  it("the author withdraws its own open request with a note; a colleague can't, the building's manager can; a claimed one stays", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const noor = by("Noor");
    const mei = by("Mei");
    const { id } = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Photo", body: "x" });
    await expect(world.verbs.withdraw_request(noor, { docId: id, note: "nope" })).rejects.toMatchObject({ code: "forbidden" });
    expect(() => world.ops.requestAction(ingrid, id, "withdraw")).toThrow(/why/);
    const r = await world.verbs.withdraw_request(ingrid, { docId: id, note: "No longer needed." });
    expect(r.requestStatus).toBe("withdrawn");
    expect(world.docs.require(id)).toMatchObject({ requestStatus: "withdrawn", requestNote: "No longer needed.", requestDecidedById: ingrid.id });
    expect(world.ops.outbox()).toHaveLength(0);
    expect(world.snapshot().outbox).toBe(0);
    await expect(world.verbs.withdraw_request(ingrid, { docId: id, note: "again" })).rejects.toThrow(/withdrawn/);
    // the building's manager withdraws a resident's; the resident is told
    world.ops.updateBuilding(world.ops.ensureAvatar(seed.admin.id), "carbon-cycle", { managerAgentId: mei.id });
    const b = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Second", body: "y" });
    await world.verbs.withdraw_request(mei, { docId: b.id, note: "Superseded by the plan." });
    expect(world.docs.require(b.id)).toMatchObject({ requestStatus: "withdrawn", requestDecidedById: mei.id });
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes("withdrew your request") && m.body.includes("Superseded"))).toBe(true);
    // a finished one is settled: it stays
    const c = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Third", body: "z" });
    world.ops.requestAction(world.ops.ensureAvatar(world.ops.createUser("Rando").user.id), c.id, "done", "Did it.");
    await expect(world.verbs.withdraw_request(ingrid, { docId: c.id, note: "late" })).rejects.toThrow(/done/);
  });

  it("a request that replaces an older one withdraws it: `replaces`, or \"replaces dc_…\" in the text; another agent's is left alone", async () => {
    const { world, by } = seededWorld();
    const ingrid = by("Ingrid");
    const noor = by("Noor");
    const a = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Drill v1", body: "x" });
    const theirs = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Noor's", body: "n" });
    const b = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Drill v2", body: "Run it again.", replaces: a.id });
    expect(b.withdrew).toEqual([a.id]);
    expect(world.docs.require(a.id)).toMatchObject({ requestStatus: "withdrawn", requestDecidedById: ingrid.id });
    expect(world.docs.require(a.id).requestNote).toContain(`Replaced by ${b.id}`);
    expect(world.docs.require(b.id).requestReplaces).toBe(a.id);
    const c = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Drill v3", body: `This supersedes ${b.id} and ${theirs.id}. Run it once more.` });
    expect(c.withdrew).toEqual([b.id]);
    expect(world.docs.require(b.id).requestStatus).toBe("withdrawn");
    expect(world.docs.require(c.id).requestReplaces).toBe(b.id);
    expect(world.docs.require(theirs.id).requestStatus).toBe("open");
    expect(world.ops.outbox().map((d) => d.id).sort()).toEqual([c.id, theirs.id].sort());
    // an explicit `replaces` that isn't yours, or isn't open, refuses the whole request
    await expect(world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Bad", body: "x", replaces: theirs.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Bad", body: "x", replaces: a.id })).rejects.toThrow(/not open/);
  });

  it("an admin declines an open request with a note; the author hears why; a member can't; delete stays its own move", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { worth: "Only a human can do this; the work waits on it.", title: "Set the repo topics", body: "x" });
    const rando = world.ops.ensureAvatar(world.ops.createUser("Rando").user.id);
    expect(() => world.ops.requestAction(rando, id, "decline", "no")).toThrow(/approve_request/);
    expect(() => world.ops.requestAction(ingrid, id, "decline", "no")).toThrow(/Only humans/);
    const admin = world.ops.ensureAvatar(seed.admin.id);
    expect(() => world.ops.requestAction(admin, id, "decline")).toThrow(/why/);
    const { request } = world.ops.requestAction(admin, id, "decline", "Outreach is paused.");
    expect(request).toMatchObject({ requestStatus: "declined", requestNote: "Outreach is paused.", requestDecidedById: seed.admin.id });
    expect(request!.requestViaAgentId).toBeUndefined();
    expect(world.ops.outbox()).toHaveLength(0);
    expect(world.ops.outbox(true).map((d) => d.id)).toEqual([id]);
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes("declined your request") && m.body.includes("Outreach is paused."))).toBe(true);
    expect(() => world.ops.requestAction(admin, id, "done", "too late")).toThrow(/declined/);
    expect(world.ops.requestAction(admin, id, "delete").request).toBeNull();
  });

  it("legacy proposed/approved requests read as open", () => {
    expect(RequestStatus.parse("proposed")).toBe("open");
    expect(RequestStatus.parse("approved")).toBe("open");
  });
});

describe("promote / ban", () => {
  it("promote needs building.promote; trophies are gone", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const { id } = await world.verbs.write(mei, { title: "Synthesis", body: "b", state: "building" });
    await expect(world.verbs.promote(mei, { docId: id, state: "library" })).rejects.toMatchObject({ code: "forbidden" });
    await world.verbs.promote(admin, { docId: id, state: "library" });
    expect(world.docs.require(id).state).toBe("library");
    expect("propose_trophy" in world.verbs).toBe(false);
    expect(world.layout.places.some((p) => p.id === "trophy-room")).toBe(false);
  });

  it("ban needs town.ban (admin); marks the agent banned and blocks its verbs", async () => {
    const { world, by, admin } = seededWorld();
    await expect(world.verbs.ban(by("Moss"), { agentId: by("Tomas").id, reason: "spam" })).rejects.toMatchObject({ code: "forbidden", permission: "town.ban" });
    await world.verbs.ban(admin, { agentId: by("Tomas").id, reason: "spam" });
    expect(world.agents.require(by("Tomas").id).status).toBe("banned");
    await expect(world.verbs.look(by("Tomas"), {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("walk + verbs together", () => {
  it("an agent can walk to the library and look there", async () => {
    const { world, by } = seededWorld();
    await tickUntil(world, world.verbs.go(by("Ravi"), { to: "library" }));
    const l = await world.verbs.look(by("Ravi"), {});
    expect(l.me.place).toBe("library");
    expect(l.building?.id).toBe("town-hall");
  });
});
