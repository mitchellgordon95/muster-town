/**
 * Asks as a table (docs/legible-delegation.md §4, build steps 1-2): created where their sources are created, deduped by
 * target, retired by the event that decides the target, decided only by a human, backfilled at boot.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, decideAccess, decideCaptain, decideRetainer, newId, nowIso, requestAccess, requestCaptain, townHallIntray, townRoleId, upsertGithubUser } from "../src/index.ts";
import { asksFor, backfillAsks, createAsk, decideAsk, deferAsk, openAsks, rankedAsks, requestsToDoAsks } from "../src/asks.ts";
import { askAt, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const H = 3_600_000;
/** A manager's money card on a funded grant: it carries the money type's structure. */
const MONEY = "You funded this at 100k on Nov 1. It has spent 10k. One of its steps shipped.\nIf you continue: the deck ships.\nIf you cut: the work stops here.";
const two = [{ label: "Continue" }, { label: "Cut" }];

/** Mei manages the lab (manager agent + role); Noor is a resident. */
async function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const propose = (tokens = 100_000, objective = "Visitors can tell what the lab is for") =>
    askAt(world, world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [{ text: `k ${objective}`, howToCheck: "h" }], objective, steps: [{ title: "Step 1", description: "Do the work", size: "M" }], stopCondition: "s", askTokens: tokens }).id), tokens);
  const fund = (tokens = 100_000, objective?: string) => world.grantDesk.decide(admin, propose(tokens, objective).id, { action: "fund" });
  /** a finished grant-lane session that spent `tokens` on the grant, then the charge that runs the checkpoint */
  const spend = (grantId: string, tokens: number) => {
    world.sessions.upsert({
      id: newId("se"), agentId: noor.id, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId,
    });
    world.budget.charge(noor.id, 0, 0);
  };
  const member = (name: string) => {
    const { user } = world.ops.createUser(name);
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    return user;
  };
  return { ...s, mei, noor, propose, fund, spend, member };
}

describe("the end of the outbox (1:1 mt_msnjkpgwdb decisions 16-17)", () => {
  it("boot repair: a claimed request is open again and its ask offers Done / Decline as a do; a second run changes nothing", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const { id } = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Photograph the slump", body: "From the north side." });
    // as the old outbox left it: claimed, its ask a click with Claim
    world.docs.patch(id, { requestStatus: "claimed", claimedByUserId: "us_x" });
    const ask = world.asks.first("targetKind = 'request' AND targetId = ?", [id])!;
    world.asks.upsert({ ...ask, type: "click", branches: [{ label: "Claim", action: "claim" }, { label: "Decline", action: "decline" }] });
    expect(requestsToDoAsks(world)).toEqual({ reopened: 1, asks: 1 });
    expect(world.docs.require(id)).toMatchObject({ requestStatus: "open", claimedByUserId: "us_x" });
    expect(world.asks.require(ask.id)).toMatchObject({ type: "do", status: "open", branches: [{ label: "Done", action: "done" }, { label: "Decline", action: "decline" }] });
    expect(requestsToDoAsks(world)).toEqual({ reopened: 0, asks: 0 });
  });

  it("an unranked do ask sorts after every other unranked ask, whatever its age", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const { id } = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Photograph the slump", body: "From the north side." });
    const later = createAsk(world, { type: "click", buildingId: "carbon-cycle", sourceDocId: null, title: "Press Let in", body: "Noor has waited since today.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Done" }).ask;
    const order = rankedAsks(world).map((a) => a.id);
    const doAsk = world.asks.first("targetKind = 'request' AND targetId = ?", [id])!;
    expect(order.indexOf(doAsk.id)).toBeGreaterThan(order.indexOf(later.id));
    expect(order.at(-1)).toBe(doAsk.id);
  });
});

describe("asks as a table (docs/legible-delegation.md §4)", () => {
  it("a proposal files one money ask; a second ask on its grant folds in as a source line; funding retires it with the event's text", async () => {
    const { world, admin, propose } = await setup();
    const g = propose(250_000);
    const [ask] = asksFor(world, { kind: "grant", id: g.id });
    expect(asksFor(world, { kind: "grant", id: g.id })).toHaveLength(1);
    expect(ask).toMatchObject({ type: "money", status: "open", targetKind: "grant", targetId: g.id, buildingId: LAB, sourceDocId: g.id, recommendation: expect.stringContaining("Fund it"), tags: [] });
    expect(ask!.id).toMatch(/^ak_/);
    expect(ask!.branches.map((b) => b.label)).toEqual(["Fund", "Counter", "Reject"]);
    // the same target again folds in: one ask, two sources; the same source line again changes nothing
    const again = { type: "money" as const, targetKind: "grant" as const, targetId: g.id, buildingId: LAB, sourceDocId: "dc_rollup1", title: "Fund it", branches: [{ label: "Fund" }] };
    expect(createAsk(world, again)).toMatchObject({ folded: true, ask: { id: ask!.id } });
    createAsk(world, again);
    expect(world.asks.require(ask!.id).sources.map((s) => s.docId)).toEqual([g.id, "dc_rollup1"]);
    expect(asksFor(world, { kind: "grant", id: g.id })).toHaveLength(1);
    expect(townHallIntray(world).asks.map((a) => a.id)).toContain(ask!.id);
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(world.asks.require(ask!.id)).toMatchObject({ status: "retired", retiredBy: expect.stringMatching(/^Funded: /) });
    expect(townHallIntray(world).asks.map((a) => a.id)).not.toContain(ask!.id);
    expect(world.events.recent({ types: ["ask.created", "ask.folded", "ask.retired"] }).map((e) => e.type)).toEqual(["ask.created", "ask.folded", "ask.retired"]);
  }, 30_000);

  it("a checkpoint, a retainer, an outbox request, a captain ask and an access request each file one ask, and the event that decides each retires it", async () => {
    const { world, admin, seed, mei, noor, fund, spend, member } = await setup();
    const live = (kind: Parameters<typeof asksFor>[1]["kind"], id: string) => asksFor(world, { kind, id }).filter((a) => a.status === "open");
    // checkpoint (held only at its ceiling): adjust / cut, retired by the adjust
    const g = fund(100_000);
    spend(g.id, 100_000);
    expect(world.grants.require(g.id).status).toBe("checkpoint");
    expect(live("grant", g.id)).toEqual([expect.objectContaining({ type: "money", title: expect.stringContaining("is held at its ceiling") })]);
    expect(live("grant", g.id)[0]!.branches.map((b) => b.label)).toEqual(["Adjust", "Cut"]);
    world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 150_000 });
    expect(live("grant", g.id)).toEqual([]);
    expect(asksFor(world, { kind: "grant", id: g.id }).at(-1)!.retiredBy).toMatch(/^Adjusted: /);
    // retainer: approve / counter / reject, retired by the decision
    const t0 = Date.now();
    const sc = (await world.verbs.schedule(mei, { title: "Sweep", description: "d", runsAt: new Date(t0 + H).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * H).toISOString() }, tokensPerRun: 3_000 })).scheduleId as string;
    expect(live("retainer", sc)).toEqual([expect.objectContaining({ type: "money", targetKind: "retainer" })]);
    decideRetainer(world, admin, sc, { action: "reject", note: "not now" });
    expect(live("retainer", sc)).toEqual([]);
    // requests: a token is a credential ask, anything else a do; Done / Decline (no Claim); done and withdraw retire them
    const pat = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Reissue the test account's PAT", body: "The token expired.", kind: "other" });
    const photo = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Photograph the slump", body: "From the north side.", kind: "observation" });
    expect(live("request", pat.id)).toEqual([expect.objectContaining({ type: "credential", branches: [{ label: "Done", action: "done" }, { label: "Decline", action: "decline" }] })]);
    expect(live("request", photo.id)).toEqual([expect.objectContaining({ type: "do" })]);
    world.ops.requestAction(admin, pat.id, "done", "Reissued; it is in the Secrets tab.");
    await world.verbs.withdraw_request(noor, { docId: photo.id, note: "Not needed after all." });
    expect([...live("request", pat.id), ...live("request", photo.id)]).toEqual([]);
    expect(asksFor(world, { kind: "request", id: photo.id })[0]!.retiredBy).toMatch(/is withdrawn/);
    // captain: accept retires it
    const ana = member("Ana");
    const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
    const cr = requestCaptain(world, ana.id, goal.id, "I run this work");
    expect(live("captain", cr.id)).toEqual([expect.objectContaining({ type: "click", title: expect.stringContaining("captain of") })]);
    decideCaptain(world, admin, cr.id, true);
    expect(live("captain", cr.id)).toEqual([]);
    // access: let in retires it (the 2026-11-08 Let-in case: no ask left pending after the click)
    const { user } = upsertGithubUser(world, { id: 4242, login: "stranger" });
    const ar = requestAccess(world, user.id);
    requestAccess(world, user.id); // still pending: the same request, the same ask
    expect(live("access", ar.id)).toEqual([expect.objectContaining({ type: "click", title: "Let @stranger in" })]);
    decideAccess(world, { kind: "user", id: seed.admin.id }, ar.id, true);
    expect(live("access", ar.id)).toEqual([]);
    expect(asksFor(world, { kind: "access", id: ar.id })[0]!.retiredBy).toBe("@stranger was let in as a member");
  }, 30_000);

  it("only a human who can fund decides an ask; a deferred ask stays listed until decided", async () => {
    const { world, admin, mei, noor } = await setup();
    const req = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Hold a 1:1 about the deck", body: "Ten minutes.", kind: "other" });
    const ask = asksFor(world, { kind: "request", id: req.id })[0]!;
    expect(() => decideAsk(world, mei, ask.id, "Done")).toThrow(/Only a human/);
    expect(() => deferAsk(world, mei, ask.id, "gr_x ships")).toThrow(/Only a human/);
    expect(deferAsk(world, admin, ask.id, "gr_x ships")).toMatchObject({ status: "deferred", deferredUntil: "gr_x ships" });
    expect(openAsks(world).map((a) => a.id)).toContain(ask.id);
    expect(() => decideAsk(world, admin, ask.id, "  ")).toThrow(/Say what you decided/);
    expect(decideAsk(world, admin, ask.id, "Done")).toMatchObject({ status: "decided", decision: "Done", decidedBy: admin.ownerUserId });
    expect(openAsks(world).map((a) => a.id)).not.toContain(ask.id);
    expect(() => decideAsk(world, admin, ask.id, "Done")).toThrow(/already decided/);
    expect(world.asks.require(ask.id).history.map((h) => h.action)).toEqual(["create", "lint", "defer", "decide"]); // the town wrote this card from the request: vetted and flagged
  }, 30_000);

  it("a click ask's note rides with its label as the decision's words, and the building's manager hears them", async () => {
    const { world, admin, noor } = await setup();
    const req = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Create the repo for the bot", body: "One repo.", kind: "other" });
    const ask = asksFor(world, { kind: "request", id: req.id })[0]!;
    const managerId = world.buildings.get(ask.buildingId!)!.managerAgentId ?? "";
    expect(managerId).not.toBe("");
    const decided = decideAsk(world, admin, ask.id, "Decline", "  I edited the token instead of creating a repo. ");
    expect(decided.decision).toBe("Decline. I edited the token instead of creating a repo.");
    const heard = world.messages.where("toId = ?", [managerId as string], "ORDER BY createdAt, rowid").map((m) => m.body);
    expect(heard.at(-1)).toContain(`"Create the repo for the bot" (${ask.id}): Decline. I edited the token instead of creating a repo.`);
  }, 30_000);

  it("a deferred ask opens again when the ask or the target it waits behind is decided or retired", async () => {
    const { world, admin, noor, propose } = await setup();
    const asked = async (title: string) => {
      const req = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title, body: "Ten minutes.", kind: "other" });
      return asksFor(world, { kind: "request", id: req.id })[0]!;
    };
    const first = await asked("Hold a 1:1 about the deck");
    const second = await asked("Book the deck review");
    const g = propose();
    // behind an ask: deciding that ask reopens it
    deferAsk(world, admin, second.id, `after ${first.id} is answered`);
    // behind a target: the grant's ask retiring (it is funded) reopens it; a deferral naming a longer id doesn't match
    const third = await asked("Tell the lab what shipped");
    deferAsk(world, admin, third.id, `${g.id} is decided`);
    const fourth = await asked("Something unrelated");
    deferAsk(world, admin, fourth.id, `${g.id}x ships`);
    decideAsk(world, admin, first.id, "Done");
    expect(world.asks.require(second.id)).toMatchObject({ status: "open", deferredUntil: null });
    expect(world.asks.require(second.id).history.at(-1)).toMatchObject({ action: "reopen", by: "system" });
    expect(world.asks.require(third.id).status).toBe("deferred");
    world.grantDesk.decide(admin, g.id, { action: "fund" });
    expect(world.asks.require(third.id).status).toBe("open");
    expect(world.asks.require(fourth.id).status).toBe("deferred");
    expect(world.events.list({ types: ["ask.reopened"] })).toHaveLength(2);
  }, 30_000);

  it("backfill files the asks of everything already open, and a second run creates nothing", async () => {
    const { world, admin, noor, propose, member } = await setup();
    const g = propose();
    const countered = propose(50_000, "A second plan");
    world.grantDesk.decide(admin, countered.id, { action: "counter", note: "smaller" });
    const req = await world.verbs.request_human(noor, { worth: "Only a human can do this; the work waits on it.", title: "Create a GitHub repo for the test account", body: "Public, empty.", kind: "other" });
    const ana = member("Ana");
    const cr = requestCaptain(world, ana.id, world.goalTree.create(admin, { parentId: "gl_trust", text: "Grant pages show sessions" }).id);
    const ar = requestAccess(world, upsertGithubUser(world, { id: 77, login: "newcomer" }).user.id);
    // as if the asks table had just been added: everything open is there, no ask yet
    world.db.prepare("DELETE FROM asks").run();
    expect(backfillAsks(world)).toBe(4);
    expect(asksFor(world, { kind: "grant", id: g.id })).toEqual([expect.objectContaining({ type: "money", status: "open" })]);
    expect(asksFor(world, { kind: "grant", id: g.id })[0]!.sources.map((s) => s.docId)).toEqual([g.id]);
    expect(asksFor(world, { kind: "grant", id: countered.id })).toEqual([]); // a countered proposal waits on its manager
    expect(asksFor(world, { kind: "request", id: req.id })).toHaveLength(1);
    expect(asksFor(world, { kind: "captain", id: cr.id })).toHaveLength(1);
    expect(asksFor(world, { kind: "access", id: ar.id })).toHaveLength(1);
    expect(backfillAsks(world)).toBe(0);
    expect(world.asks.count()).toBe(4);
  }, 30_000);

  it("a manager's ask: refused when a money ask names no grant or retainer, or its target is not one of this town; a money ask folds into its grant's ask; one with no target is an ask of its own", async () => {
    const { world, mei, propose } = await setup();
    const g = propose();
    const fundIt = { type: "money" as const, targetId: g.id, title: "Fund the deck grant", body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the deck ships.", claims: [{ text: "The deck builds", check: { kind: "manual" as const } }], branches: [{ label: "Fund" }, { label: "Reject" }], recommendation: "Fund" };
    const redeploy = { type: "policy" as const, title: "May forks redeploy?", body: "Rule: forks may redeploy on green CI.\nI applied it twice this week.\nReversing it means a human redeploys each change.", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" };
    const grantAsk = asksFor(world, { kind: "grant", id: g.id })[0]!;
    const before = world.asks.count();
    await expect(world.verbs.ask(mei, { ...fundIt, targetId: undefined })).rejects.toThrow(/money ask: name the grant or retainer/);
    await expect(world.verbs.ask(mei, { ...fundIt, targetId: "gr_nothere" })).rejects.toThrow(/gr_nothere is not a grant/);
    expect(world.asks.count()).toBe(before);
    // the grant's proposal already has a live ask: the manager's money ask on it is that ask, not a second one
    const folded = await world.verbs.ask(mei, fundIt);
    expect(folded).toMatchObject({ askId: grantAsk.id, folded: true });
    expect(asksFor(world, { kind: "grant", id: g.id })).toHaveLength(1);
    expect(world.asks.require(grantAsk.id).status).toBe("open");
    // an ask with no target is a card of its own in the queue
    const own = await world.verbs.ask(mei, redeploy);
    expect(own).toMatchObject({ askId: expect.stringMatching(/^ak_/), folded: false });
    expect(own.askId).not.toBe(grantAsk.id);
    expect(world.asks.count()).toBe(before + 1);
    expect(townHallIntray(world).asks.map((a) => a.id)).toEqual(expect.arrayContaining([grantAsk.id, own.askId]));
  }, 30_000);

  it("the event that decides a target retires every live ask on it, a manager's own ask included", async () => {
    const { world, admin, mei, propose, fund, spend } = await setup();
    const toFund = propose(100_000, "Fund case");
    const held = fund(100_000, "Checkpoint case");
    spend(held.id, 100_000);
    const toClose = fund(100_000, "Close case");
    const withKr = fund(100_000, "Key result case");
    const kr = world.grantDesk.keyResultsOf(withKr.id)[0]!;
    const toStop = fund(100_000, "Stop case");
    const t0 = Date.now();
    const sc = (await world.verbs.schedule(mei, { title: "Sweep", description: "d", runsAt: new Date(t0 + H).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * H).toISOString() }, tokensPerRun: 3_000 })).scheduleId as string;
    const money = (targetId: string, title: string) => ({ type: "money" as const, targetId, title, body: MONEY, branches: two, recommendation: "Continue" });
    // the manager asks about each: a proposal, a held grant and an asked retainer already have a live ask (its ask folds in); the rest are new asks
    const asked = [
      await world.verbs.ask(mei, { ...money(toFund.id, "Fund the fund case"), body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the deck ships." }),
      await world.verbs.ask(mei, money(held.id, "Raise the checkpoint case")),
      await world.verbs.ask(mei, money(toClose.id, "Keep the close case going")),
      await world.verbs.ask(mei, { type: "click", targetId: kr.id, title: "Mark the key result met", body: "Noor has waited on this since Nov 6.\nIf you mark it met once, this never comes back.", branches: [{ label: "Met" }, { label: "Missed" }], recommendation: "Met" }),
      await world.verbs.ask(mei, { ...money(sc, "Approve the sweep's retainer"), body: "You approved it last week. It has spent 9k.\nIf you approve: the sweep runs every six hours.\nIf you reject: it stays held." }),
      await world.verbs.ask(mei, money(toStop.id, "Stop the stop case if the PR stays red")),
    ];
    expect(asked.map((a) => a.folded)).toEqual([true, true, false, false, true, false]);
    const targets = [["grant", toFund.id], ["grant", held.id], ["grant", toClose.id], ["keyResult", kr.id], ["retainer", sc], ["grant", toStop.id]] as const;
    targets.forEach(([kind, id], i) => expect(asksFor(world, { kind, id }).filter((a) => a.status === "open").map((a) => a.id)).toEqual([asked[i]!.askId]));
    world.grantDesk.decide(admin, toFund.id, { action: "fund" });
    world.grantDesk.decide(admin, held.id, { action: "adjust", tokens: 150_000 });
    world.grantDesk.closeDone(mei, toClose.id, { note: "shipped" });
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "met", note: "seen live" });
    decideRetainer(world, admin, sc, { action: "approve", note: "" });
    world.grantDesk.stop(admin, toStop.id, { reason: "PR stayed red" });
    // the hooks retired every ask on those targets
    for (const [kind, id] of targets) expect(asksFor(world, { kind, id }).filter((a) => a.status === "open" || a.status === "deferred")).toEqual([]);
    for (const a of asked) expect(world.asks.require(a.askId)).toMatchObject({ status: "retired", retiredBy: expect.any(String) });
  }, 30_000);
});
