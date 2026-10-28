import { describe, expect, it } from "vitest";
import { buildingRoleId, cabinetDocs, createBuilding, createResident, createTownModerator, extractProposal, intrayWorker, isTownHallItem, managerAgentOf, setAssignmentStatus, TOWN_HALL_ID } from "../src/index.ts";
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
  it("drafts are private; publishing needs doc.write_building; authors update their own docs", async () => {
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

    // a visitor without member role can't publish
    const { agent: v } = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: "carbon-cycle", inheritsOwner: false });
    await expect(world.verbs.write(v, { title: "t", body: "b", state: "building" })).rejects.toMatchObject({ code: "forbidden", permission: "doc.write_building" });
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

  it("a building with a manager agent: residents' reports and the manager's own work reports go to its in-tray without notifying humans; only rollups go to the Town Hall in-tray", async () => {
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
    // a resident can't roll up; the manager's rollup needs covered reports of its building
    await expect(world.verbs.submit_report(noor, { title: "x", body: REPORT, verdict: "stop", rollup: true })).rejects.toMatchObject({ code: "bad_request" });
    await expect(world.verbs.submit_report(mei, { title: "x", body: REPORT, verdict: "stop", rollup: true })).rejects.toMatchObject({ code: "bad_request" });
    await expect(world.verbs.submit_report(mei, { title: "x", body: REPORT, verdict: "stop", rollup: true, provenance: { sourceIds: ["dc_nope"], urls: [] } })).rejects.toMatchObject({ code: "bad_request" });
    const sent: [string, number][] = [];
    world.changes.subscribe((m) => { if (m.type === "building" && m.building.intray !== undefined) sent.push([m.building.id, m.building.intray]); });
    const up = await world.verbs.submit_report(mei, { title: `Rollup: ${new Date().toISOString().slice(0, 10)}`, body: `## Shipped\nnothing\n## Decided\n- ${r.id}: approve\n## Key results\n(none)\n## Needs from ${mitchell.name}\nNothing needed. @${mitchell.name}`, verdict: "continue", rollup: true, provenance: { sourceIds: [r.id], urls: [] } });
    expect(up).toMatchObject({ decision: "pending", intray: "town-hall", workedBy: "human" });
    const rollup = world.docs.require(up.id);
    expect(rollup).toMatchObject({ type: "report", buildingId: "carbon-cycle", tags: ["rollup"], provenance: { sourceIds: [r.id] } });
    expect(isTownHallItem(world, rollup)).toBe(true);
    expect(world.ops.intray("carbon-cycle").map((d) => d.id)).not.toContain(up.id);
    expect(world.ops.intray(TOWN_HALL_ID).map((d) => d.id)).toEqual([up.id]);
    expect(world.ops.townHallIntray()).toMatchObject({ reports: [{ id: up.id }], grants: [] });
    expect(world.ops.intrayCount(TOWN_HALL_ID)).toBe(1);
    expect(world.snapshot().buildings.find((b) => b.id === TOWN_HALL_ID)!.intray).toBe(1);
    expect(sent).toContainEqual([TOWN_HALL_ID, 1]);
    // the Town Hall item notifies the human; the manager can't decide its own rollup, the admin can
    expect(world.messages.where("kind = 'mention' AND toId = ?", [admin.id])).toHaveLength(1);
    await expect(world.verbs.review(mei, { docId: up.id, decision: "approve" })).rejects.toMatchObject({ code: "bad_request" });
    await world.verbs.review(admin, { docId: up.id, decision: "approve" });
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
    const kr = world.grantDesk.createKeyResult(admin, "carbon-cycle", { text: "a number with uncertainty", howToCheck: "read it" });
    const g = world.grantDesk.create(mei, "carbon-cycle", { keyResultId: kr.id, objective: "Ocean sink 2024", stopCondition: "when the number is in", askTokens: 1_000_000, testingPlan: [{ text: "a source card", howToCheck: "it exists" }] });
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
    const { assignmentId } = await world.verbs.assign(moss, { agentId: noor.id, title: "Check Mauna Loa", description: "y", gap: "No Mauna Loa check" });
    expect((await world.verbs.assignments(noor, {})).assignments[0]).toMatchObject({ id: assignmentId, status: "pending" });
    await world.verbs.accept_assignment(noor, { id: assignmentId });
    expect(world.agents.require(noor.id).currentAssignmentId).toBe(assignmentId);
    expect((await world.verbs.look(noor, {})).notices.currentAssignment).toBe("Check Mauna Loa");
    expect((await world.verbs.inbox(noor, {})).messages.some((m) => m.body.includes("Check Mauna Loa"))).toBe(true);
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
    // the Town Hall in-tray is a Town Hall station everyone can walk to (waterfall §3.5)
    expect(look.places.some((p) => p.id === "intray:town-hall" && p.kind === "intray")).toBe(true);
  });

  it("tell to an idle or stopped resident says it won't start work; to a working one it says nothing", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const idle = await world.verbs.tell(by("Ravi"), { to: noor.id, text: "ping" });
    expect(world.agents.require(noor.id).status).toBe("idle");
    expect(idle.note).toMatch(/Noor is idle.*does not start work/);
    world.setStatus(noor.id, "stopped");
    expect((await world.verbs.tell(by("Ravi"), { to: noor.id, text: "ping" })).note).toMatch(/Noor is stopped/);
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
  it("open (no approval step) → claimed → done creates a library human-report and notifies the agent", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { title: "Photograph thaw slump", body: "If you're near...", location: "Yukon" });
    expect(world.docs.require(id)).toMatchObject({ type: "request", state: "building", requestStatus: "open", location: "Yukon" });
    expect(world.ops.outbox().map((d) => d.id)).toEqual([id]);
    const other = world.ops.createUser("Rando").user;
    const randoAvatar = world.ops.ensureAvatar(other.id);
    world.ops.requestAction(randoAvatar, id, "claim");
    expect(() => world.ops.requestAction(randoAvatar, id, "claim")).toThrow(/claimed/);
    expect(world.docs.require(id).claimedByUserId).toBe(other.id);
    expect(() => world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), id, "done")).toThrow(/needs a report body/);
    const { humanReport } = world.ops.requestAction(randoAvatar, id, "done", "Photos attached; slump is 40 m wide.");
    expect(humanReport).toMatchObject({ type: "human-report", state: "library", authorId: other.id, authorKind: "user" });
    expect(world.docs.require(id).requestStatus).toBe("done");
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes(humanReport!.id))).toBe(true);
  });

  it("only a moderator can delete a request; the requester is told", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const { id } = await world.verbs.request_human(ingrid, { title: "Spam", body: "x" });
    const rando = world.ops.ensureAvatar(world.ops.createUser("Rando").user.id);
    expect(() => world.ops.requestAction(rando, id, "delete")).toThrow(/approve_request/);
    expect(world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), id, "delete").request).toBeNull();
    expect(world.docs.get(id)).toBeUndefined();
    expect(world.ops.outbox()).toHaveLength(0);
    expect((await world.verbs.inbox(ingrid, {})).messages.some((m) => m.body.includes("deleted your outbox request"))).toBe(true);
  });

  it("the outbox badge counts only unclaimed requests: snapshot and live `outbox` frames", async () => {
    const { world, by, seed } = seededWorld();
    const ingrid = by("Ingrid");
    const sent: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "outbox") sent.push(m.open); });
    const a = await world.verbs.request_human(ingrid, { title: "Photo the slump", body: "x" });
    const b = await world.verbs.request_human(ingrid, { title: "Call the office", body: "y" });
    await world.verbs.request_human(ingrid, { title: "Spam", body: "z" });
    expect(world.snapshot().outbox).toBe(3);
    const avatar = world.ops.ensureAvatar(world.ops.createUser("Rando").user.id);
    world.ops.requestAction(avatar, a.id, "claim");
    world.ops.requestAction(avatar, a.id, "done", "Done.");
    world.ops.requestAction(avatar, b.id, "claim");
    const spam = world.ops.outbox().find((d) => d.title === "Spam")!;
    world.ops.requestAction(world.ops.ensureAvatar(seed.admin.id), spam.id, "delete");
    expect(sent).toEqual([1, 2, 3, 2, 2, 1, 0]);
    expect(world.snapshot().outbox).toBe(0);
    expect(world.ops.outbox().filter((d) => d.requestStatus === "open")).toHaveLength(0);
  });

  it("legacy proposed/approved requests read as open", () => {
    expect(RequestStatus.parse("proposed")).toBe("open");
    expect(RequestStatus.parse("approved")).toBe("open");
  });
});

describe("promote / trophy / ban", () => {
  it("promote needs building.promote; trophies need town.approve_trophy", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const { id } = await world.verbs.write(mei, { title: "Synthesis", body: "b", state: "building" });
    await expect(world.verbs.promote(mei, { docId: id, state: "library" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(world.verbs.promote(by("Moss"), { docId: id, state: "library" })).rejects.toMatchObject({ code: "forbidden" }); // reviewers don't promote
    await world.verbs.promote(admin, { docId: id, state: "library" });
    expect(world.docs.require(id).state).toBe("library");
    await world.verbs.propose_trophy(mei, { docId: id, why: "Great" });
    expect(world.docs.require(id).trophyProposedBy).toBe(mei.id);
    expect(() => world.ops.decideTrophy(by("Moss"), id, true)).toThrow(/approve_trophy/);
    world.ops.decideTrophy(admin, id, true);
    expect(world.docs.require(id).state).toBe("trophy");
  });

  it("ban needs town.ban (town moderator); marks the agent banned and blocks its verbs", async () => {
    const { world, by } = seededWorld();
    await expect(world.verbs.ban(by("Moss"), { agentId: by("Tomas").id, reason: "spam" })).rejects.toMatchObject({ code: "forbidden", permission: "town.ban" });
    const wren = createTownModerator(world, { name: "Wren" });
    await world.verbs.ban(wren, { agentId: by("Tomas").id, reason: "spam" });
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
    expect(l.nearby.map((n) => n.name)).toContain("Ada");
  });
});
