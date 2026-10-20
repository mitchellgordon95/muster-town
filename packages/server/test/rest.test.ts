import { afterEach, describe, expect, it } from "vitest";
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

  it("dev token route is absent outside dev; unknown api paths 404 as JSON", async () => {
    const { app } = await setup({ dev: false });
    const r = await json(app, "GET", "/api/dev/admin-token");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_found");
  });
});

describe("buildings & agents", () => {
  it("creates a building and a resident; validation and permission errors map to status codes", async () => {
    const { app, auth, world } = await setup();
    const b = await json(app, "POST", "/api/buildings", { headers: auth, body: { name: "Ocean Lab", goal: "Ocean heat", headcount: 4 } });
    expect(b.status).toBe(201);
    expect(b.body.building).toMatchObject({ name: "Ocean Lab", kind: "lab", headcount: 4 });
    const bid = b.body.building.id;

    const bad = await json(app, "POST", "/api/buildings", { headers: auth, body: { goal: "no name" } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad_request");

    const r = await json(app, "POST", "/api/agents/residents", { headers: auth, body: { buildingId: bid, name: "Nia", title: "Oceanographer", direction: "Argo floats" } });
    expect(r.status).toBe(201);
    expect(r.body.agent).toMatchObject({ name: "Nia", kind: "resident", homeBuildingId: bid });

    const detail = await json(app, "GET", `/api/agents/${r.body.agent.id}`);
    expect(detail.body).toMatchObject({ agent: { id: r.body.agent.id }, currentSession: null, latestReport: null, assignments: [] });

    const patched = await json(app, "PATCH", `/api/buildings/${bid}`, { headers: auth, body: { goal: "Ocean heat content" } });
    expect(patched.body.building.goal).toBe("Ocean heat content");

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

  it("chat/interrupt return 503 without a runtime and call it when attached", async () => {
    const off = await setup();
    const mei = off.by("Mei");
    const c = await json(off.app, "POST", `/api/agents/${mei.id}/chat`, { headers: off.auth, body: { message: "hi" } });
    expect(c.status).toBe(503);
    expect(c.body.error).toBe("runtime not available");

    const calls: unknown[] = [];
    const on = await setup({ runtime: {
      chat: async (id, input) => { calls.push(["chat", id, input.message]); return "hello from Mei"; },
      interrupt: async (id, text) => { calls.push(["interrupt", id, text]); },
      onMeetingStart: async (id) => { calls.push(["meeting", id]); },
    } });
    const mei2 = on.by("Mei");
    expect((await json(on.app, "POST", `/api/agents/${mei2.id}/chat`, { headers: on.auth, body: { message: "hi" } })).body.reply).toBe("hello from Mei");
    expect((await json(on.app, "POST", `/api/agents/${mei2.id}/interrupt`, { headers: on.auth, body: { text: "stop that" } })).status).toBe(200);
    const m = await json(on.app, "POST", "/api/meetings", { headers: on.auth, body: { kind: "standup", buildingId: "carbon-cycle" } });
    const started = await json(on.app, "POST", `/api/meetings/${m.body.meeting.id}/start`, { headers: on.auth });
    expect(started.body.meeting.phase).toBe("discussing");
    expect(calls).toEqual([["chat", mei2.id, "hi"], ["interrupt", mei2.id, "stop that"], ["meeting", m.body.meeting.id]]);
  });
});

describe("reports as replies", () => {
  it("reply (text → assignment), archive (no assignment), permission checks; ask is 503 without a runtime", async () => {
    const { app, auth, by, world } = await setup();
    const mei = by("Mei");
    const mk = async (title: string) => (await world.verbs.submit_report(mei, { title, body: "## What I need from you\nMerge PR #3.", verdict: "continue" })).id;
    const a = await mk("A"), b = await mk("B");
    const tomas = { authorization: `Bearer ${world.tokens.getOrCreate("agent", by("Tomas").id)}` };
    expect((await json(app, "POST", `/api/docs/${a}/reply`, { headers: tomas, body: { text: "hi" } })).status).toBe(403);
    expect((await json(app, "POST", `/api/docs/${a}/archive`, { headers: tomas })).status).toBe(403);
    expect((await json(app, "POST", `/api/docs/${a}/reply`, { body: { text: "hi" } })).status).toBe(401);

    const r = await json(app, "POST", `/api/docs/${a}/reply`, { headers: auth, body: { text: "merge" } });
    expect(r.status).toBe(200);
    expect(r.body.doc).toMatchObject({ id: a, decision: "approve", decisionNote: "merge" });
    expect(r.body.doc.body).toContain("## Reply from");
    expect(r.body.assignment).toMatchObject({ agentId: mei.id, title: "Reply on: A", fromReportId: a });
    expect(r.body.assignment.description).toContain("gh pr merge");

    const arc = await json(app, "POST", `/api/docs/${b}/archive`, { headers: auth });
    expect(arc.status).toBe(200);
    expect(arc.body).toMatchObject({ doc: { id: b, decision: "approve" }, assignment: null });
    expect((await json(app, "GET", "/api/buildings/carbon-cycle/intray", { headers: auth })).body.reports.some((d: any) => d.id === a || d.id === b)).toBe(false);

    const ask = await json(app, "POST", `/api/docs/${a}/ask`, { headers: auth, body: { question: "what PR?" } });
    expect(ask.status).toBe(503);
    expect((await json(app, "POST", `/api/docs/${a}/ask`, { body: { question: "what PR?" } })).status).toBe(401);
  });

  it("ask calls runtime.askAbout", async () => {
    const calls: unknown[] = [];
    const { app, auth, by, world, seed } = await setup({ runtime: {
      chat: async () => "", interrupt: async () => undefined,
      askAbout: async (docId, q, userId) => { calls.push([docId, q, userId]); return { reply: "PR #3" }; },
    } });
    const { id } = await world.verbs.submit_report(by("Mei"), { title: "A", body: "PR #3", verdict: "continue" });
    const r = await json(app, "POST", `/api/docs/${id}/ask`, { headers: auth, body: { question: "what PR?" } });
    expect(r).toMatchObject({ status: 200, body: { reply: "PR #3" } });
    expect(calls).toEqual([[id, "what PR?", seed.admin.id]]);
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

  it("meeting create with chosen attendees; bad ids are 4xx", async () => {
    const { app, auth, by } = await setup();
    const ids = [by("Mei").id, by("Noor").id];
    const m = await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: ids } });
    expect(m.status).toBe(201);
    expect(m.body.meeting.attendeeIds).toEqual(ids);
    expect((await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: ["ag_nobody"] } })).status).toBe(404);
    expect((await json(app, "POST", "/api/meetings", { headers: auth, body: { kind: "retro", buildingId: "carbon-cycle", attendeeIds: [] } })).status).toBe(400);
  });

  it("roles, budget, events", async () => {
    const { app, auth, by } = await setup();
    const roles = await json(app, "GET", "/api/roles?buildingId=carbon-cycle");
    expect(roles.body.roles.length).toBeGreaterThan(0);
    expect(roles.body.memberships.length).toBeGreaterThan(0);
    const mei = by("Mei");
    const m = { roleId: roles.body.roles.find((r: any) => r.name === "reviewer" && r.buildingId === "carbon-cycle").id, holderKind: "agent", holderId: mei.id };
    expect((await json(app, "POST", "/api/roles/assign", { headers: auth, body: m })).status).toBe(200);
    expect((await json(app, "DELETE", "/api/roles/assign", { headers: auth, body: m })).status).toBe(200);

    expect((await json(app, "POST", "/api/donate", { headers: auth, body: { tokens: 1000, buildingId: "carbon-cycle" } })).status).toBe(201);
    const budget = await json(app, "GET", "/api/budget");
    expect(budget.body.buildings.find((b: any) => b.buildingId === "carbon-cycle").allocated).toBeGreaterThan(1000);

    const added = await json(app, "POST", "/api/bank/inputs", { headers: auth, body: { label: "Key", source: "api-key", model: "m", tokens: 2000, apiKey: "sk-secret" } });
    expect(added.status).toBe(201);
    expect(JSON.stringify(added.body)).not.toContain("sk-secret");
    const bank = await json(app, "GET", "/api/bank");
    expect(bank.body).toMatchObject({ balanceTokens: 2000, expiringTokens: 0, durableTokens: 2000, inputs: [{ label: "Key", hasApiKey: true }] });
    expect(bank.body.buildings.find((b: any) => b.buildingId === "carbon-cycle")).toMatchObject({ pct: 100, explicit: false, durableTokens: 2000 });
    const shared = await json(app, "PUT", "/api/bank/shares/carbon-cycle", { headers: auth, body: { pct: 40 } });
    expect(shared.body.buildings.find((b: any) => b.buildingId === "carbon-cycle")).toMatchObject({ pct: 40, explicit: true, durableTokens: 800 });
    expect((await json(app, "PUT", "/api/bank/shares/carbon-cycle", { body: { pct: 40 } })).status).toBe(401);
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
    const room = await json(app, "GET", "/api/buildings/carbon-cycle/layout");
    expect(room.status).toBe(200);
    expect(room.body.pieces.map((p: any) => p.key)).toEqual(expect.arrayContaining(["board", "desk:0", "meeting", "cabinet"]));
    const dry = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 1, y: 0 } }, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toEqual([]);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual({});
    const bad = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 5, y: 5 } } } });
    expect(bad.status).toBe(400);
    const ok = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: auth, body: { furniture: { board: { x: 1, y: 0 } } } });
    expect(ok.status).toBe(200);
    expect(ok.body.building.furniture).toEqual({ board: { x: 1, y: 0 } });
    const moss = world.agents.first("name = 'Moss'")!;
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", moss.id)}` };
    const refused = await json(app, "PUT", "/api/buildings/carbon-cycle/layout", { headers: agent, body: { furniture: {} } });
    expect(refused.status).toBe(403);
  });
});

describe("town planning", () => {
  it("an admin dry-runs and saves a move plus a new building; illegal plans are 400, agent tokens 403", async () => {
    const { app, world, auth } = await setup();
    const lot = world.buildings.require("carbon-cycle").lot!;
    const moved = { ...lot, y: lot.y - 3 };
    const dry = await json(app, "PUT", "/api/town/plan", { headers: auth, body: { lots: { "carbon-cycle": moved }, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.body.errors).toEqual([]);
    expect(world.buildings.require("carbon-cycle").lot).toEqual(lot);
    const th = world.buildings.require("town-hall").lot!;
    const bad = await json(app, "PUT", "/api/town/plan", { headers: auth, body: { lots: { "carbon-cycle": th } } });
    expect(bad.status).toBe(400);
    const right = Math.max(...world.buildings.all().map((b) => b.lot!.x + b.lot!.w));
    const ok = await json(app, "PUT", "/api/town/plan", { headers: auth, body: { lots: { "carbon-cycle": moved }, create: { name: "Kelp Lab", headcount: 1, lot: { x: right + 2, y: 20, w: 13, h: 9 } } } });
    expect(ok.status).toBe(200);
    expect(ok.body.buildings[0].lot).toEqual(moved);
    expect(ok.body.created.name).toBe("Kelp Lab");
    const moss = world.agents.first("name = 'Moss'")!;
    const agent = { authorization: `Bearer ${world.tokens.getOrCreate("agent", moss.id)}` };
    expect((await json(app, "PUT", "/api/town/plan", { headers: agent, body: { lots: {}, dryRun: true } })).status).toBe(403);
  });
});
