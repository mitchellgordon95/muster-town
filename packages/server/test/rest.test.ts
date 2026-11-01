import { afterEach, describe, expect, it } from "vitest";
import { buildingRoleId, townRoleId } from "@muster-town/core";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup(opts?: Parameters<typeof seededApp>[0]) {
  const s = await seededApp(opts);
  cleanups.push(s.close);
  return s;
}

describe("auth & town", () => {
  it("dev admin token, /api/town, /api/me", async () => {
    const { app, seed, auth } = await setup();
    const tok = await json(app, "GET", "/api/dev/admin-token");
    expect(tok.status).toBe(200);
    expect(tok.body.token).toBe(seed.adminToken);

    const town = await json(app, "GET", "/api/town");
    expect(town.status).toBe(200);
    for (const k of ["town", "buildings", "agents", "places", "grid", "meetings"]) expect(town.body).toHaveProperty(k);
    expect(town.body.buildings.map((b: any) => b.id)).toEqual(expect.arrayContaining(["town-hall", "carbon-cycle"]));
    expect(town.body.grid.tiles.length).toBe(town.body.grid.w * town.body.grid.h);

    const me = await json(app, "GET", "/api/me", { headers: auth });
    expect(me.status).toBe(200);
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.user.id).toBe(seed.admin.id);
    expect(me.body.avatarAgentId).toMatch(/^ag_/);

    expect((await json(app, "GET", "/api/me")).status).toBe(401);
    expect((await json(app, "GET", "/api/me", { headers: { authorization: "Bearer nope" } })).body.code).toBe("unauthorized");
  });

  it("dev token is refused to proxied or tunnelled requests", async () => {
    const { app } = await setup();
    for (const headers of [{ "x-forwarded-for": "203.0.113.7" }, { forwarded: "for=203.0.113.7" }, { "cf-connecting-ip": "203.0.113.7" }] as Record<string, string>[]) {
      const r = await json(app, "GET", "/api/dev/admin-token", { headers });
      expect(r.status).toBe(403);
      expect(r.body.token).toBeUndefined();
    }
  });

  it("dev token route is absent outside dev; unknown api paths 404 as JSON", async () => {
    const { app } = await setup({ dev: false });
    const r = await json(app, "GET", "/api/dev/admin-token");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_found");
  });
});

describe("buildings & agents", () => {
  it("creates a building with its manager (no resident routes); validation and permission errors map to status codes", async () => {
    const { app, auth, world } = await setup();
    const b = await json(app, "POST", "/api/buildings", { headers: auth, body: { name: "Ocean Lab", goal: "Ocean heat", headcount: 20 } });
    expect(b.status).toBe(201);
    // Desks is the size setting (the map is drawn from the goal tree): the lot follows the headcount (labSize)
    expect(b.body.building).toMatchObject({ name: "Ocean Lab", kind: "lab", headcount: 20, lot: { w: 15, h: 27 } });
    const bid = b.body.building.id;
    // no goal text: the attached goal is its purpose (1:1 mt_n25udpflus decision 3); a sent one is ignored
    expect(b.body.building.goal).toBe("");
    const repatched = await json(app, "PATCH", `/api/buildings/${bid}`, { headers: auth, body: { headcount: 12, goal: "Ocean heat content" } });
    expect(repatched.status).toBe(200);
    expect(repatched.body.building).toMatchObject({ goal: "", headcount: 12, lot: { w: 15, h: 18 } });
    const only = await json(app, "PATCH", `/api/buildings/${bid}`, { headers: auth, body: { headcount: 1 } });
    expect(only.status).toBe(200);
    expect(only.body.building).toMatchObject({ headcount: 1, lot: { w: 13, h: 9 } });

    // the name is optional: blank = the goal's short text
    const unnamed = await json(app, "POST", "/api/buildings", { headers: auth, body: {} });
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.building.name).toBe(world.goalTree.defaultName("gl_town"));
    const bad = await json(app, "POST", "/api/buildings", { headers: auth, body: { name: "x".repeat(81) } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad_request");

    // the new building moves in its one named manager; there is no route to add a resident (1:1 mt_wngibcr98b decision 1)
    const managerId = world.buildings.require(bid).managerAgentId!;
    expect(world.agents.require(managerId)).toMatchObject({ kind: "resident", homeBuildingId: bid });
    expect((await json(app, "POST", "/api/agents/residents", { headers: auth, body: { buildingId: bid, name: "Nia" } })).status).toBe(404);
    expect((await json(app, "GET", "/api/agents/name-suggestion")).status).toBe(404);
    expect((await json(app, "POST", "/api/assignments/as_x/delegate", { headers: auth, body: { agentId: managerId } })).status).toBe(404);
    const r = { body: { agent: world.agents.require(managerId) } };

    const detail = await json(app, "GET", `/api/agents/${r.body.agent.id}`);
    expect(detail.body).toMatchObject({ agent: { id: r.body.agent.id }, currentSession: null, latestReport: null });
    // no queued work: a building with no grant is not blocked (key results belong to grants), so nothing wakes the manager
    expect(detail.body.assignments).toEqual([]);

    const patched = await json(app, "PATCH", `/api/buildings/${bid}`, { headers: auth, body: { name: "Ocean Heat Lab" } });
    expect(patched.body.building.name).toBe("Ocean Heat Lab");

    // a fresh non-admin user cannot create buildings
    const { token } = world.ops.createUser("Guest");
    const denied = await json(app, "POST", "/api/buildings", { headers: { authorization: `Bearer ${token}` }, body: { name: "Nope" } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("forbidden");

    const work = await json(app, "POST", `/api/agents/${r.body.agent.id}/work`, { headers: auth, body: { title: "Start" } });
    expect(work.status).toBe(201);
    expect(work.body.assignment).toMatchObject({ status: "pending", title: "Start" });
  });

  it("registers a visitor with an agent token", async () => {
    const { app, auth, world } = await setup();
    const r = await json(app, "POST", "/api/agents/visitors", { headers: auth, body: { name: "Mitch's Claude", buildingId: "carbon-cycle" } });
    expect(r.status).toBe(201);
    expect(world.tokens.resolve(r.body.token)).toMatchObject({ kind: "agent", id: r.body.agent.id });
  });

  it("the message and proxy-chat routes are gone (1:1 mt_wql34b8gkl); interrupt and meeting start call the runtime when attached", async () => {
    const off = await setup();
    const mei = off.by("Mei");
    expect((await json(off.app, "POST", `/api/agents/${mei.id}/chat`, { headers: off.auth, body: { message: "hi" } })).status).toBe(404);
    expect((await json(off.app, "POST", `/api/agents/${mei.id}/message`, { headers: off.auth, body: { text: "hi" } })).status).toBe(404);

    const calls: unknown[] = [];
    const on = await setup({ runtime: {
      interrupt: async (id, text) => { calls.push(["interrupt", id, text]); },
      onMeetingStart: async (id) => { calls.push(["meeting", id]); },
    } });
    const mei2 = on.by("Mei");
    expect((await json(on.app, "POST", `/api/agents/${mei2.id}/interrupt`, { headers: on.auth, body: { text: "stop that" } })).status).toBe(200);
    const m = await json(on.app, "POST", "/api/meetings", { headers: on.auth, body: { kind: "standup", buildingId: "carbon-cycle" } });
    const started = await json(on.app, "POST", `/api/meetings/${m.body.meeting.id}/start`, { headers: on.auth });
    expect(started.body.meeting.phase).toBe("discussing");
    expect(calls).toEqual([["interrupt", mei2.id, "stop that"], ["meeting", m.body.meeting.id]]);
  });
});

describe("reports: Talk to the author and Archive", () => {
  it("archive (no assignment), permission checks; the reply route is gone; ask is 404", async () => {
    const { app, auth, by, world } = await setup();
    const mei = by("Mei");
    const mk = async (title: string) => (await world.verbs.submit_report(mei, { title, body: "## What I need from you\nMerge PR #3.", verdict: "continue" })).id;
    const a = await mk("A"), b = await mk("B");
    const tomas = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Tomas").id)}` };
    expect((await json(app, "POST", `/api/docs/${a}/archive`, { headers: tomas })).status).toBe(403);
    expect((await json(app, "POST", `/api/docs/${a}/archive`, {})).status).toBe(401);
    expect((await json(app, "POST", `/api/docs/${a}/reply`, { headers: auth, body: { text: "merge" } })).status).toBe(404);
    expect((await json(app, "POST", `/api/docs/${a}/archive`, { headers: auth })).body.doc).toMatchObject({ id: a, decision: "approve" });

    const arc = await json(app, "POST", `/api/docs/${b}/archive`, { headers: auth });
    expect(arc.status).toBe(200);
    expect(arc.body).toMatchObject({ doc: { id: b, decision: "approve" }, assignment: null });
    expect((await json(app, "GET", "/api/buildings/carbon-cycle/intray", { headers: auth })).body.reports.some((d: any) => d.id === a || d.id === b)).toBe(false);

    // "Ask about this" is gone: a report's "Talk to <author>" opens a 1:1 instead
    expect((await json(app, "POST", `/api/docs/${a}/ask`, { headers: auth, body: { question: "what PR?" } })).status).toBe(404);
  });

  it("one-on-one takes agentId and docId: a 1:1 with the report's author, the report presented as the first line", async () => {
    const { app, auth, by, world, seed } = await setup();
    const mei = by("Mei"), noor = by("Noor");
    const { id } = await world.verbs.submit_report(noor, { title: "Ocean sink", body: "## Findings\n2.9 GtC/yr", verdict: "continue" });
    const r = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth, body: { agentId: noor.id, docId: id } });
    expect(r.status).toBe(200);
    expect(r.body.meeting).toMatchObject({ kind: "one-on-one", phase: "discussing", facilitatorId: noor.id, attendeeIds: [noor.id] });
    expect(r.body.meeting.transcript).toHaveLength(1);
    expect(r.body.meeting.transcript[0]).toMatchObject({ speakerKind: "user", attachment: { kind: "doc", ref: id } });
    expect(r.body.meeting.transcript[0].text).toContain(id);
    // opening again about the same report returns the same 1:1 without presenting it twice
    const again = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth, body: { agentId: noor.id, docId: id } });
    expect(again.body.meeting).toMatchObject({ id: r.body.meeting.id });
    expect(again.body.meeting.transcript).toHaveLength(1);
    // no body still means the building's manager
    world.ops.updateBuilding(world.ops.ensureAvatar(seed.admin.id), "carbon-cycle", { managerAgentId: mei.id });
    const mgr = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth });
    expect(mgr.body.meeting).toMatchObject({ facilitatorId: mei.id, transcript: [] });
    expect((await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { body: { agentId: noor.id } })).status).toBe(401);
  });

  it("one-on-one takes grantId: the grant presented to its proposer; an article opens the same way (1:1 mt_u6euky43hg)", async () => {
    const { app, auth, by, world, seed } = await setup();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(world.ops.ensureAvatar(seed.admin.id), "carbon-cycle", { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId("carbon-cycle", "manager"));
    const notes = world.docs.upsert({ ...world.docs.first("1 = 1")!, id: "dc_notes1", type: "meeting-notes", state: "building", buildingId: "carbon-cycle", title: "notes", body: "KR" });
    const { grantId } = await world.verbs.propose_grant(mei, { keyResults: [{ text: "Sink banner", howToCheck: "Open it" }], objective: "Ship the sink banner", stopCondition: "s", askTokens: 1000, findingsDocIds: [notes.id] });
    const kr = world.keyResults.require(world.grants.require(grantId).keyResultId!);
    const r = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth, body: { grantId } });
    expect(r.status).toBe(200);
    expect(r.body.meeting).toMatchObject({ facilitatorId: mei.id });
    expect(r.body.meeting.transcript[0]).toMatchObject({ speakerKind: "user", attachment: { kind: "page", ref: `grant:${grantId}` } });
    expect(r.body.meeting.transcript[0].text).toContain(kr.id);
    expect((await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth, body: { grantId: "gr_nope" } })).status).toBe(404);
    const art = await world.verbs.write(noor, { title: "Primer", body: "x", type: "article", state: "building" });
    const a = await json(app, "POST", "/api/buildings/carbon-cycle/one-on-one", { headers: auth, body: { agentId: noor.id, docId: art.id } });
    expect(a.body.meeting.transcript[0]).toMatchObject({ attachment: { kind: "doc", ref: art.id } });
  });
});

describe("docs & review", () => {
  it("lists Ravi's imported report and reviews it (continue → next assignment; approve → none)", async () => {
    const { app, auth, by, world } = await setup();
    const ravi = by("Ravi");
    expect(ravi).toBeTruthy();
    const list = await json(app, "GET", "/api/docs?type=report&limit=100");
    const report = list.body.docs.find((d: any) => d.authorId === ravi.id);
    expect(report).toBeTruthy();

    // make it reviewable regardless of the decision it was imported with
    world.docs.patch(report.id, { decision: "pending" });
    const before = world.assignments.count("agentId = ?", [ravi.id]);
    const bad = await json(app, "POST", `/api/docs/${report.id}/review`, { headers: auth, body: { decision: "moderate" } });
    expect(bad.status).toBe(400);
    const noNote = await json(app, "POST", `/api/docs/${report.id}/review`, { headers: auth, body: { decision: "redirect" } });
    expect(noNote.status).toBe(400);
    const r = await json(app, "POST", `/api/docs/${report.id}/review`, { headers: auth, body: { decision: "continue", note: "good" } });
    expect(r.status).toBe(200);
    expect(r.body.doc.decision).toBe("continue");
    expect(r.body.assignment).toMatchObject({ agentId: ravi.id, status: "pending", fromReportId: report.id });
    expect(world.assignments.count("agentId = ?", [ravi.id])).toBe(before + 1);

    const again = await json(app, "POST", `/api/docs/${report.id}/review`, { headers: auth, body: { decision: "approve" } });
    expect(again.status).toBe(409);

    const one = await json(app, "GET", `/api/docs/${report.id}`);
    expect(one.body.doc.id).toBe(report.id);
    const search = await json(app, "GET", `/api/docs?q=${encodeURIComponent(report.title.split(/\s+/)[0])}`);
    expect(search.body.docs.length).toBeGreaterThan(0);
  });

  it("human-authored doc; drafts are private", async () => {
    const { app, auth } = await setup();
    const d = await json(app, "POST", "/api/docs", { headers: auth, body: { title: "My note", body: "hello" } });
    expect(d.status).toBe(201);
    expect(d.body.doc).toMatchObject({ state: "draft", authorKind: "user" });
    expect((await json(app, "GET", `/api/docs/${d.body.doc.id}`)).status).toBe(404);
    expect((await json(app, "GET", `/api/docs/${d.body.doc.id}`, { headers: auth })).status).toBe(200);
  });
});

describe("filing cabinet", () => {
  it("filters by type and author, newest first; counts per type and author leave out FYIs and drafts", async () => {
    const { app, world, by } = await setup();
    const mei = by("Mei"), ravi = by("Ravi");
    const n1 = await world.verbs.write(mei, { type: "note", title: "mei note 1", body: "x", state: "building" });
    const n2 = await world.verbs.write(mei, { type: "note", title: "mei note 2", body: "x", state: "building" });
    const rn = await world.verbs.write(ravi, { type: "note", title: "ravi note", body: "x", state: "building" });
    const src = await world.verbs.write(mei, { type: "source", title: "mei source", body: "x", state: "building" });
    await world.verbs.write(mei, { type: "fyi", title: "fyi", body: "x", state: "building" });
    await world.verbs.write(mei, { type: "note", title: "draft", body: "x" });
    world.docs.patch(n1.id, { createdAt: "2026-01-01T00:00:00.000Z" });
    world.docs.patch(n2.id, { createdAt: "2026-01-02T00:00:00.000Z" });
    world.docs.patch(rn.id, { createdAt: "2026-01-03T00:00:00.000Z" });

    const all = await json(app, "GET", "/api/buildings/carbon-cycle/cabinet?type=note&limit=200");
    expect(all.status).toBe(200);
    const ids = all.body.docs.map((d: any) => d.id);
    expect(ids.indexOf(rn.id)).toBeLessThan(ids.indexOf(n2.id));
    expect(ids.indexOf(n2.id)).toBeLessThan(ids.indexOf(n1.id));
    expect(all.body.docs.every((d: any) => d.type === "note" && d.state !== "draft")).toBe(true);

    const mine = await json(app, "GET", `/api/buildings/carbon-cycle/cabinet?type=note&authorId=${mei.id}`);
    expect(mine.body.docs.map((d: any) => d.id)).toEqual([n2.id, n1.id]);
    const meiAll = await json(app, "GET", `/api/buildings/carbon-cycle/cabinet?authorId=${mei.id}&limit=200`);
    expect(meiAll.body.docs.map((d: any) => d.id)).toEqual(expect.arrayContaining([n1.id, n2.id, src.id]));
    expect(meiAll.body.docs.some((d: any) => d.authorId !== mei.id)).toBe(false);

    const counts = all.body.counts as { type: string; authorId: string; n: number }[];
    expect(counts.find((c) => c.type === "note" && c.authorId === mei.id)?.n).toBe(2);
    expect(counts.find((c) => c.type === "note" && c.authorId === ravi.id)?.n).toBeGreaterThanOrEqual(1);
    expect(counts.some((c) => c.type === "fyi")).toBe(false);

    expect((await json(app, "GET", "/api/buildings/carbon-cycle/cabinet?type=nonsense")).status).toBe(400);
  });
});

describe("meetings, roles, budget, events, human moves", () => {
  it("meeting create/say/list", async () => {
    const { app, auth } = await setup();
    const m = await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "standup", buildingId: "carbon-cycle", startNow: true } });
    expect(m.status).toBe(201);
    expect(m.body.meeting).toMatchObject({ phase: "collecting", buildingId: "carbon-cycle" });
    expect((await json(app, "POST", `/api/meetings/${m.body.meeting.id}/say`, { headers: auth, body: { text: "Too early" } })).status).toBe(409);
    await json(app, "POST", `/api/meetings/${m.body.meeting.id}/start`, { headers: auth });
    const said = await json(app, "POST", `/api/meetings/${m.body.meeting.id}/say`, { headers: auth, body: { text: "Hello all" } });
    expect(said.body.meeting.transcript.at(-1)).toMatchObject({ text: "Hello all", speakerKind: "user" });
    const list = await json(app, "GET", "/api/meetings?buildingId=carbon-cycle");
    expect(list.body.meetings.map((x: any) => x.id)).toContain(m.body.meeting.id);
  });

  it("say with attach: the utterance carries it, GET returns it, the notes keep it (docs/meetings.md §8)", async () => {
    const { app, auth, world } = await setup();
    const doc = world.docs.first("state != 'draft'")!;
    const m = await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "standup", buildingId: "carbon-cycle" } });
    const id = m.body.meeting.id;
    await json(app, "POST", `/api/meetings/${id}/start`, { headers: auth });
    const said = await json(app, "POST", `/api/meetings/${id}/say`, { headers: auth, body: { text: "Have a look", attach: doc.id } });
    expect(said.status).toBe(200);
    expect(said.body.meeting.transcript.at(-1).attachment).toMatchObject({ kind: "doc", ref: doc.id, title: doc.title });
    await json(app, "POST", `/api/meetings/${id}/say`, { headers: auth, body: { text: "And the Bank", attach: "bank" } });
    expect((await json(app, "POST", `/api/meetings/${id}/say`, { headers: auth, body: { text: "x", attach: "nowhere" } })).status).toBe(400);
    const got = await json(app, "GET", `/api/meetings/${id}`);
    expect(got.body.meeting.transcript.map((u: any) => u.attachment?.kind)).toEqual(["doc", "page"]);
    const ended = await json(app, "POST", `/api/meetings/${id}/end`, { headers: auth, body: {} });
    const notes = world.docs.require(ended.body.meeting.notesDocId, "doc");
    expect(notes.body).toContain(`(presented: [${doc.title}](${doc.id}))`);
    expect(notes.body).toContain("(page bank)");
  });

  it("meeting create with chosen attendees; bad ids are 4xx", async () => {
    const { app, auth, by } = await setup();
    const ids = [by("Mei").id, by("Noor").id];
    const m = await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: ids } });
    expect(m.status).toBe(201);
    expect(m.body.meeting.attendeeIds).toEqual(ids);
    expect((await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: ["ag_nobody"] } })).status).toBe(404);
    expect((await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: [] } })).status).toBe(400);
  });

  it("donate takes auth and label; town credentials and retiring need admin or town.allocate_budget", async () => {
    const { app, auth, world } = await setup();
    const sub = await json(app, "POST", "/api/donate", { headers: auth, body: { tokens: 5000, buildingId: "carbon-cycle", auth: "subscription", label: "Mitchell's Claude subscription, October" } });
    expect(sub.status).toBe(201);
    expect(sub.body.allocation).toMatchObject({ auth: "subscription", label: "Mitchell's Claude subscription, October", retired: false });

    const { user, token } = world.ops.createUser("Guest");
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    const guest = { authorization: `Bearer ${token}` };
    for (const a of ["subscription", "api-key", undefined]) {
      const r = await json(app, "POST", "/api/donate", { headers: guest, body: { tokens: 10, buildingId: "carbon-cycle", ...(a ? { auth: a } : {}) } });
      expect(r.status).toBe(403);
    }
    const own = await json(app, "POST", "/api/donate", { headers: guest, body: { tokens: 10, buildingId: "carbon-cycle", apiKey: "sk-guest", label: "Guest key" } });
    expect(own.status).toBe(201);
    expect(own.body.allocation.auth).toBe("donor-key");
    expect(JSON.stringify(own.body)).not.toContain("sk-guest");

    const list = await json(app, "GET", "/api/allocations?buildingId=carbon-cycle");
    expect(list.body.allocations.map((a: any) => a.label)).toEqual(["Guest key", "Mitchell's Claude subscription, October", "House budget (placeholder)"]);
    expect(list.body.allocations[1]).toMatchObject({ remainingTokens: 5000, userName: "Mitchell" });

    const id = sub.body.allocation.id;
    expect((await json(app, "POST", `/api/allocations/${id}/retire`)).status).toBe(401);
    expect((await json(app, "POST", `/api/allocations/${id}/retire`, { headers: guest })).status).toBe(403);
    const retired = await json(app, "POST", `/api/allocations/${id}/retire`, { headers: auth });
    expect(retired.status).toBe(200);
    expect(retired.body.allocation).toMatchObject({ retired: true });
    const budget = await json(app, "GET", "/api/budget");
    expect(budget.body.buildings.find((b: any) => b.buildingId === "carbon-cycle").allocated).toBe(world.allocations.where("buildingId = 'carbon-cycle' AND retired = 0").reduce((s, a) => s + a.tokens, 0));

    expect((await json(app, "POST", "/api/allocations/retire-placeholders", { headers: guest, body: {} })).status).toBe(403);
    const dry = await json(app, "POST", "/api/allocations/retire-placeholders", { headers: auth, body: { dryRun: true } });
    expect(dry.body.allocations.map((a: any) => a.label)).toEqual(["House budget (placeholder)"]);
    const done = await json(app, "POST", "/api/allocations/retire-placeholders", { headers: auth, body: {} });
    expect(done.body.allocations).toHaveLength(1);
    expect(world.allocations.require(done.body.allocations[0].id).retired).toBe(true);
  });

  it("roles, budget, events", async () => {
    const { app, auth, by } = await setup();
    const roles = await json(app, "GET", "/api/roles?buildingId=carbon-cycle");
    expect(roles.body.roles.length).toBeGreaterThan(0);
    expect(roles.body.memberships.length).toBeGreaterThan(0);
    const mei = by("Mei");
    const m = { roleId: roles.body.roles.find((r: any) => r.name === "manager" && r.buildingId === "carbon-cycle").id, holderKind: "agent", holderId: mei.id };
    expect((await json(app, "POST", "/api/roles/assign", { headers: auth, body: m })).status).toBe(200);
    expect((await json(app, "DELETE", "/api/roles/assign", { headers: auth, body: m })).status).toBe(200);

    expect((await json(app, "POST", "/api/donate", { headers: auth, body: { tokens: 1000, buildingId: "carbon-cycle" } })).status).toBe(201);
    const budget = await json(app, "GET", "/api/budget");
    expect(budget.body.buildings.find((b: any) => b.buildingId === "carbon-cycle").allocated).toBeGreaterThan(1000);

    const added = await json(app, "POST", "/api/bank/inputs", { headers: auth, body: { label: "Key", source: "api-key", model: "m", tokens: 2000, apiKey: "sk-secret" } });
    expect(added.status).toBe(201);
    expect(JSON.stringify(added.body)).not.toContain("sk-secret");
    const finance = await json(app, "GET", "/api/finance");
    expect(finance.status).toBe(200);
    expect(finance.body).toMatchObject({ credited: 2000, leftBank: 2000, overdrawn: 0, projection: { days: 30 }, sumCheck: { ok: true, diff: 0 } });
    expect(finance.body.projection.dailyInflow).toBe((await json(app, "GET", "/api/bank")).body.dailyInflowTokens);
    expect(["covered", "days", "no-usage"]).toContain(finance.body.projection.runway);
    expect(finance.body.free).toMatchObject({ goalId: "gl_town" });
    expect(typeof finance.body.free.freeTokens).toBe("number");
    expect(finance.body).not.toHaveProperty("pools");
    const sources = await json(app, "GET", "/api/finance/sources");
    expect(sources.status).toBe(200);
    expect(sources.body).toMatchObject({ creditedTokens: 2000, totalReceived: finance.body.total, financeTotal: finance.body.total, matchesFinance: true, sumCheck: { ok: true, diff: 0 } });
    expect(sources.body.inputs.find((r: any) => r.label === "Key")).toMatchObject({ source: "api-key", tokens: 2000, credits: [{ tokens: 2000, expiresAt: null }] });
    expect(sources.body.donations.some((d: any) => d.buildingId === "carbon-cycle" && d.sizeTokens === 1000)).toBe(true);
    // pools were deleted (migration 067): one balance
    expect((await json(app, "GET", "/api/finance/pools")).status).toBe(404);
    const fly = await json(app, "GET", "/api/finance/fly?days=7");
    expect(fly.status).toBe(200);
    expect(fly.body).toMatchObject({ windowDays: 7, capUsdPerDay: 10, sumCheck: { ok: true, diff: 0 }, totals: { deskUsd: 0 } });
    expect(fly.body.days).toHaveLength(7);
    expect(fly.body.rates.source).toContain("fly.io");
    const bank = await json(app, "GET", "/api/bank");
    expect(bank.body).toMatchObject({ balanceTokens: 2000, expiringTokens: 0, durableTokens: 2000, inputs: expect.arrayContaining([expect.objectContaining({ label: "Key", hasApiKey: true })]) });
    expect(bank.body.buildings.find((b: any) => b.buildingId === "carbon-cycle")).toMatchObject({ durableTokens: 2000 });
    expect(bank.body).not.toHaveProperty("pools");
    expect(bank.body.free).toMatchObject({ goalId: "gl_town", generalTokens: 2000, freeTokens: 2000 });
    expect((await json(app, "GET", "/api/bank/pools")).status).toBe(404);
    expect((await json(app, "POST", "/api/bank/pools", { headers: auth, body: { name: "Forty", pct: 40 } })).status).toBe(404);
    // the optional exploration cap is the goal's (inherited down the tree); its funding shows the free tokens under it
    const own = (await json(app, "POST", "/api/goals", { headers: auth, body: { parentId: "gl_town", text: "Carbon's goal" } })).body.goal.id;
    await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: auth, body: { goalId: own } });
    expect((await json(app, "GET", `/api/goals/${own}`)).body.funding).toMatchObject({ exploreCap: null, exploreSpentTodayTokens: 0, free: { goalId: own, freeTokens: 2000 } });
    expect((await json(app, "PATCH", "/api/goals/gl_town", { headers: auth, body: { exploreCapTokensPerDay: 500 } })).body.goal.exploreCapTokensPerDay).toBe(500);
    expect((await json(app, "GET", `/api/goals/${own}`)).body.funding.exploreCap).toEqual({ tokensPerDay: 500, goalId: "gl_town" });
    expect((await json(app, "PATCH", `/api/goals/${own}`, { body: { exploreCapTokensPerDay: 1 } })).status).toBe(401);
    expect((await json(app, "PUT", "/api/bank/shares/carbon-cycle", { headers: auth, body: { pct: 40 } })).status).toBe(404);
    expect(JSON.stringify(bank.body)).not.toContain("sk-secret");
    expect((await json(app, "DELETE", `/api/bank/inputs/${added.body.input.id}`, { headers: auth })).body.input.cancelledAt).toBeTruthy();

    const ev = await json(app, "GET", "/api/events?limit=5");
    expect(ev.body.events.length).toBe(5);
    const since = await json(app, "GET", `/api/events?since=${ev.body.events[0].id}&limit=2`);
    expect(since.body.events[0].id).toBe(ev.body.events[0].id + 1);
  });

  it("moveHuman validates walkability (WS human.move path)", async () => {
    const { world, seed } = await setup();
    const avatar = world.ops.ensureAvatar(seed.admin.id);
    const plaza = world.layout.place("plaza")!.pos;
    expect(world.moveHuman(avatar.id, plaza.x, plaza.y)).toBe(true);
    expect(world.moveHuman(avatar.id, -5, -5)).toBe(false);
  });
});

describe("edit layout", () => {
  it("anyone reads the furniture; a human manager dry-runs and saves; agent tokens are refused", async () => {
    const { app, world, auth } = await setup();
    // the plain tree: labs hang below their goal's street, doors in their top wall
    world.town.set({ mapLayout: "tree" }); world.layout.rebuild();
    const room = await json(app, "GET", "/api/buildings/carbon-cycle/layout");
    expect(room.status).toBe(200);
    expect(room.body.pieces.map((p: any) => p.key)).toEqual(expect.arrayContaining(["board", "desk:0", "meeting", "cabinet"]));
    // a lab's back wall is its bottom one (its door is in the top wall, on its goal's plaza)
    const back = world.buildings.require("carbon-cycle").lot!.h - 1;
    const dry = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 1, y: back } }, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toEqual([]);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
    const bad = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 5, y: 5 } } } });
    expect(bad.status).toBe(400);
    const ok = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 1, y: back } } } });
    expect(ok.status).toBe(200);
    expect(ok.body.building.furniture).toEqual({ board: { x: 1, y: back } });
    const moss = world.agents.first("name = 'Moss'")!;
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", moss.id)}` };
    const refused = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: agent, body: { furniture: {} } });
    expect(refused.status).toBe(403);
  });
});

describe("the map is the goal tree (docs/goals.md, build step 2)", () => {
  it("no plan route; attaching a building draws its goal, its place on the building's doorstep; Desks resizes it (town.manage_buildings), agent tokens 403", async () => {
    const { app, world, auth } = await setup();
    // the plain tree: labs hang below their goal's street, doors in their top wall
    world.town.set({ mapLayout: "tree" }); world.layout.rebuild();
    expect((await json(app, "PUT", "/api/town/plan", { headers: auth, body: { lots: {} } })).status).toBe(404);
    const goal = await json(app, "POST", "/api/goals", { headers: auth, body: { parentId: "gl_town", text: "A goal with a plaza" } });
    expect(goal.status).toBe(201);
    const id = goal.body.goal.id;
    expect(world.layout.place(`plaza:${id}`)).toBeUndefined(); // no building under it yet: nothing on the map
    const attach = await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: auth, body: { goalId: id } });
    expect(attach.status).toBe(200);
    const plaza = world.layout.requirePlace(`plaza:${id}`);
    expect(world.buildings.require("carbon-cycle").lot!.y).toBe(plaza.pos.y + 1); // on the street, its goal's place on its doorstep
    const desks = await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: auth, body: { headcount: 9 } });
    expect(desks.status).toBe(200);
    expect(world.buildings.require("carbon-cycle").lot).toMatchObject({ w: 15, h: 15 });
    const moss = world.agents.first("name = 'Moss'")!;
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", moss.id)}` };
    expect((await json(app, "PATCH", "/api/buildings/carbon-cycle", { headers: agent, body: { headcount: 12 } })).status).toBe(403);
  });
});

describe("desk slots (manager forks step 7, volume adoption)", () => {
  it("GET lists desks and slots; PUT points a slot at a volume (building.manage); bad n is 400; a resident is refused", async () => {
    const { app, auth, by, world } = await setup();
    const empty = await json(app, "GET", "/api/buildings/carbon-cycle/desk-slots", { headers: auth });
    expect(empty.status).toBe(200);
    expect(empty.body.slots).toEqual([]);
    const mei = empty.body.desks.find((d: any) => d.agentId === by("Mei").id);
    expect(mei).toMatchObject({ agentName: "Mei" });

    const put = await json(app, "PUT", `/api/buildings/carbon-cycle/desk-slots/${mei.n}`, { headers: auth, body: { sandboxName: `desk-c-carbon-cycle-${mei.n}`, volumeName: `deskhome-${by("Mei").id}` } });
    expect(put.status).toBe(200);
    expect(put.body.slot).toMatchObject({ buildingId: "carbon-cycle", n: mei.n, volumeName: `deskhome-${by("Mei").id}` });
    expect(put.body.slots).toHaveLength(1);
    expect(world.events.recent({ buildingId: "carbon-cycle", limit: 5 }).some((e) => e.type === "building.updated" && /desk slot/.test(e.text))).toBe(true);

    expect((await json(app, "PUT", "/api/buildings/carbon-cycle/desk-slots/99", { headers: auth, body: { sandboxName: "x", volumeName: "y" } })).status).toBe(400);
    expect((await json(app, "PUT", `/api/buildings/carbon-cycle/desk-slots/${mei.n}`, { headers: auth, body: { sandboxName: "" } })).status).toBe(400);
    const tomas = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Tomas").id)}` };
    expect((await json(app, "GET", "/api/buildings/carbon-cycle/desk-slots", { headers: tomas })).status).toBe(403);
    expect((await json(app, "PUT", `/api/buildings/carbon-cycle/desk-slots/${mei.n}`, { headers: tomas, body: { sandboxName: "a", volumeName: "b" } })).status).toBe(403);
    expect((await json(app, "GET", "/api/buildings/carbon-cycle/desk-slots")).status).toBe(401);
  });
});

describe("the map's shape (1:1 mt_q10xf3bkoq)", () => {
  it("a new collective starts as fountain plazas; an admin or a goal captain picks the shape for everyone (PUT /api/town/map-layout), redrawn at once and logged", async () => {
    const { app, world, auth } = await setup();
    expect((await json(app, "GET", "/api/town")).body.town.mapLayout).toBe("fountain");
    const fountain = world.layout.grid;
    const { user, token } = world.ops.createUser("Octo");
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    const octo = { authorization: `Bearer ${token}` };
    expect((await json(app, "PUT", "/api/town/map-layout", { body: { layout: "tree" } })).status).toBe(401);
    expect((await json(app, "PUT", "/api/town/map-layout", { headers: octo, body: { layout: "tree" } })).status).toBe(403);
    // owning any goal of the town is enough
    const goal = world.goals.first("parentId IS NOT NULL")!;
    world.goals.upsert({ ...goal, ownerId: user.id });
    const radial = await json(app, "PUT", "/api/town/map-layout", { headers: octo, body: { layout: "radial" } });
    expect(radial.status).toBe(200);
    expect(radial.body).toEqual({ mapLayout: "radial" });
    expect(world.town.get().mapLayout).toBe("radial");
    expect(world.layout.grid).not.toEqual(fountain);
    expect(world.events.recent({ limit: 20 }).some((e) => (e.payload as { mapLayout?: string }).mapLayout === "radial")).toBe(true);
    expect((await json(app, "GET", "/api/town")).body.town.mapLayout).toBe("radial");
    expect((await json(app, "PUT", "/api/town/map-layout", { headers: auth, body: { layout: "tree" } })).body.mapLayout).toBe("tree");
    expect((await json(app, "PUT", "/api/town/map-layout", { headers: auth, body: { layout: "hex" } })).status).toBe(400);
    const moss = world.agents.first("name = 'Moss'")!;
    expect((await json(app, "PUT", "/api/town/map-layout", { headers: { authorization: `Bearer ${world.tokens.getOrCreate("agent", moss.id)}` }, body: { layout: "radial" } })).status).toBe(403);
  });
});

describe("the operating reserve (1:1 mt_lb7tm75jgb)", () => {
  it("an admin sets it (PUT /api/town/operating-reserve); GET /api/bank carries it and the free tokens it leaves; logged", async () => {
    const { app, world, auth, seed } = await setup();
    world.bank.addInput(seed.admin.id, { label: "Key", source: "api-key", model: "m", tokens: 2000, apiKey: "sk" });
    const { token } = world.ops.createUser("Octo");
    expect((await json(app, "PUT", "/api/town/operating-reserve", { body: { tokens: 500 } })).status).toBe(401);
    expect((await json(app, "PUT", "/api/town/operating-reserve", { headers: { authorization: `Bearer ${token}` }, body: { tokens: 500 } })).status).toBe(403);
    expect((await json(app, "PUT", "/api/town/operating-reserve", { headers: auth, body: { tokens: -1 } })).status).toBe(400);
    const set = await json(app, "PUT", "/api/town/operating-reserve", { headers: auth, body: { tokens: 500 } });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ operatingReserveTokens: 500, free: { generalTokens: 2000, reserveTokens: 500, freeTokens: 1500 } });
    expect((await json(app, "GET", "/api/bank")).body).toMatchObject({ balanceTokens: 2000, reserveTokens: 500, freeTokens: 1500 });
    expect((await json(app, "GET", "/api/town")).body.town.operatingReserveTokens).toBe(500);
    expect(world.events.recent({ limit: 20 }).some((e) => (e.payload as { operatingReserveTokens?: number }).operatingReserveTokens === 500)).toBe(true);
  });
});
