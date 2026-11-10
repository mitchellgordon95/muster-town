/**
 * Asks as a table (docs/legible-delegation.md §4, build steps 1-2): created where their sources are created, deduped by
 * target, retired by the event that decides the target, decided only by a human, backfilled at boot.
 */
import { parseRollup } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId, decideAccess, decideCaptain, decideRetainer, newId, nowIso, requestAccess, requestCaptain, townHallIntray, townRoleId, upsertGithubUser } from "../src/index.ts";
import { asksFor, backfillAsks, createAsk, decideAsk, deferAsk, openAsks } from "../src/asks.ts";
import { overtakenReason, rollupCalls } from "../src/secretary.ts";
import { askAt, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const H = 3_600_000;
const later = () => new Promise((r) => setTimeout(r, 5));
const rollup = (shipped: string, needs = "Nothing needed.") => `## Shipped\n${shipped}\n\n## Decided\n- dc_a → approved\n\n## Key results\non track\n\n## Needs from Mitchell\n${needs}`;
const item = (n: number, title: string, call: string) => `**${n}. ${title}**\n**What it is:** a change.\n**What you'd see:** a page.\n**Your call:** ${call}\n`;

/** Mei manages the lab (manager agent + role); Noor is a resident whose report a rollup covers. */
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
  const report = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
  const roll = (title: string, body: string, extra: Record<string, unknown> = {}) =>
    world.verbs.submit_report(mei, { title, body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] }, ...extra });
  const member = (name: string) => {
    const { user } = world.ops.createUser(name);
    world.permissions.grant({ kind: "user", id: user.id }, townRoleId("member"));
    return user;
  };
  return { ...s, mei, noor, propose, fund, spend, roll, member };
}

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
    // outbox requests: a token is a credential ask, anything else a click; claim and withdraw retire them
    const pat = await world.verbs.request_human(noor, { title: "Reissue the test account's PAT", body: "The token expired.", kind: "other" });
    const photo = await world.verbs.request_human(noor, { title: "Photograph the slump", body: "From the north side.", kind: "observation" });
    expect(live("request", pat.id)).toEqual([expect.objectContaining({ type: "credential", branches: [{ label: "Claim", action: "claim" }, { label: "Decline", action: "decline" }] })]);
    expect(live("request", photo.id)).toEqual([expect.objectContaining({ type: "click" })]);
    world.ops.requestAction(admin, pat.id, "claim");
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
    const req = await world.verbs.request_human(noor, { title: "Hold a 1:1 about the deck", body: "Ten minutes.", kind: "other" });
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
    const req = await world.verbs.request_human(noor, { title: "Create the repo for the bot", body: "One repo.", kind: "other" });
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
      const req = await world.verbs.request_human(noor, { title, body: "Ten minutes.", kind: "other" });
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

  it("backfill files the asks of everything already open, a pending rollup's calls included, and a second run creates nothing", async () => {
    const { world, admin, noor, propose, roll, member } = await setup();
    const g = propose();
    const countered = propose(50_000, "A second plan");
    world.grantDesk.decide(admin, countered.id, { action: "counter", note: "smaller" });
    const req = await world.verbs.request_human(noor, { title: "Create a GitHub repo for the test account", body: "Public, empty.", kind: "other" });
    const ana = member("Ana");
    const cr = requestCaptain(world, ana.id, world.goalTree.create(admin, { parentId: "gl_trust", text: "Grant pages show sessions" }).id);
    const ar = requestAccess(world, upsertGithubUser(world, { id: 77, login: "newcomer" }).user.id);
    const r = await roll("Rollup 5", rollup(item(1, "Deck", `Fund ${g.id} so the deck ships.`), "- Forks redeploy on green CI, unless you'd rather keep it manual."));
    // as if the asks table had just been added: everything open is there, no ask yet
    world.db.prepare("DELETE FROM asks").run();
    expect(backfillAsks(world)).toBe(5);
    expect(asksFor(world, { kind: "grant", id: g.id })).toEqual([expect.objectContaining({ type: "money", status: "open" })]);
    // the rollup's call on the grant folded into the grant's own ask as a second source
    expect(asksFor(world, { kind: "grant", id: g.id })[0]!.sources.map((s) => s.docId)).toEqual([g.id, r.id]);
    expect(asksFor(world, { kind: "grant", id: countered.id })).toEqual([]); // a countered proposal waits on its manager
    expect(asksFor(world, { kind: "request", id: req.id })).toHaveLength(1);
    expect(asksFor(world, { kind: "captain", id: cr.id })).toHaveLength(1);
    expect(asksFor(world, { kind: "access", id: ar.id })).toHaveLength(1);
    expect(world.asks.where("sourceDocId = ? AND targetId IS NULL", [r.id])).toEqual([expect.objectContaining({ type: "policy", title: expect.stringContaining("unless you'd rather") })]);
    expect(backfillAsks(world)).toBe(0);
    expect(world.asks.count()).toBe(5);
  }, 30_000);

  it("a rollup's typed asks: refused when a Needs or Your call id is not a target; a money ask folds into its grant's ask; without the list it is tagged and reads the prose", async () => {
    const { world, propose, roll } = await setup();
    const g = propose();
    const body = rollup(item(1, "Deck", `Fund ${g.id}.`), "- Decide whether forks may redeploy.");
    const fundIt = { type: "money" as const, targetId: g.id, title: "Fund the deck grant", body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the deck ships.", claims: [{ text: "The deck builds", check: { kind: "manual" as const } }], branches: [{ label: "Fund" }, { label: "Reject" }], recommendation: "Fund" };
    const redeploy = { type: "policy" as const, title: "May forks redeploy?", body: "Rule: forks may redeploy on green CI.\nI applied it twice this week.\nReversing it means a human redeploys each change.", branches: [{ label: "Keep" }, { label: "Change" }], recommendation: "Keep" };
    await expect(roll("R1", body, { asks: [redeploy] })).rejects.toThrow(new RegExp(`asks about ${g.id}.*no entry of \`asks\` has it`));
    await expect(roll("R1", body, { asks: [] })).rejects.toThrow(/asks about/);
    await expect(roll("R1", body, { asks: [{ ...fundIt, targetId: undefined }, redeploy] })).rejects.toThrow(/money ask: name the grant or retainer/);
    await expect(roll("R1", body, { asks: [{ ...fundIt, targetId: "gr_nothere" }, redeploy] })).rejects.toThrow(/gr_nothere is not a grant/);
    await expect(roll("R1", rollup("None.", "- Decide whether forks may redeploy."), { asks: [] })).rejects.toThrow(/asks "Decide whether forks may redeploy\." but `asks` is empty/);
    const grantAsk = asksFor(world, { kind: "grant", id: g.id })[0]!;
    const filed = await roll("R1", body, { asks: [fundIt, redeploy] });
    expect(filed.decision).toBe("pending"); // it has a Shipped card of its own
    expect(filed.asks).toEqual([{ id: grantAsk.id, folded: true }, { id: expect.stringMatching(/^ak_/), folded: false }]);
    expect(world.asks.require(grantAsk.id).sources.map((s) => s.docId)).toEqual([g.id, filed.id]);
    expect(world.docs.require(filed.id).tags).not.toContain("untyped-asks");
    // an ask-only rollup whose every ask folds is acknowledged on submit (the Needs line names the grant: allowed, it is a target)
    const only = await roll("R2", rollup("Nothing new live.", `- Fund ${g.id}: it ships the deck.`), { asks: [fundIt] });
    expect(only.decision).toBe("approve");
    expect(world.docs.require(only.id).tags).toContain("folded");
    // without the list: today's behaviour, a tag and a line in the note, and the prose read into asks; one asking nothing gets neither
    const legacy = await roll("R3", rollup("None.", "- Decide whether the deck needs a dark theme."));
    expect(legacy.note).toMatch(/Next rollup, also file what you ask the humans as `asks`/);
    expect(world.docs.require(legacy.id).tags).toContain("untyped-asks");
    const quiet = await roll("R4", rollup("None."));
    expect(world.docs.require(quiet.id).tags).not.toContain("untyped-asks");
    expect(quiet.note).not.toMatch(/as `asks`/);
    expect(world.asks.where("sourceDocId = ?", [legacy.id])).toEqual([expect.objectContaining({ type: "click", targetId: null, title: "Decide whether the deck needs a dark theme" })]);
  }, 30_000);

  it("every case overtakenReason detects is also retired by a hook", async () => {
    const { world, admin, mei, propose, fund, spend, roll } = await setup();
    const toFund = propose(100_000, "Fund case");
    const held = fund(100_000, "Checkpoint case");
    spend(held.id, 100_000);
    const toClose = fund(100_000, "Close case");
    const withKr = fund(100_000, "Key result case");
    const kr = world.grantDesk.keyResultsOf(withKr.id)[0]!;
    const toStop = fund(100_000, "Stop case");
    const t0 = Date.now();
    const sc = (await world.verbs.schedule(mei, { title: "Sweep", description: "d", runsAt: new Date(t0 + H).toISOString(), repeat: { everyHours: 6, until: new Date(t0 + 30 * H).toISOString() }, tokensPerRun: 3_000 })).scheduleId as string;
    const body = rollup([
      item(1, "Fund", `Fund ${toFund.id}.`),
      item(2, "Checkpoint", `Raise ${held.id} at its checkpoint.`),
      item(3, "Close", `${toClose.id} closed: mark its key results met.`),
      item(4, "Key result", `Mark ${kr.id} met if you agree.`),
      item(5, "Retainer", `Approve the retainer ${sc}.`),
    ].join("\n"), `- Stop ${toStop.id} if the PR stays red.`);
    const r = await roll("Overtaken cases", body);
    const doc = world.docs.require(r.id);
    const targets = [["grant", toFund.id], ["grant", held.id], ["grant", toClose.id], ["keyResult", kr.id], ["retainer", sc], ["grant", toStop.id]] as const;
    for (const [kind, id] of targets) expect(asksFor(world, { kind, id }).some((a) => a.status === "open" && a.sources.some((s) => s.docId === r.id))).toBe(true);
    expect(rollupCalls(world, doc).every((c) => !c.overtaken)).toBe(true);
    await later(); // the deciding events come after the rollup (overtakenReason compares times)
    world.grantDesk.decide(admin, toFund.id, { action: "fund" });
    world.grantDesk.decide(admin, held.id, { action: "adjust", tokens: 150_000 });
    world.grantDesk.closeDone(mei, toClose.id, { note: "shipped" });
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "met", note: "seen live" });
    decideRetainer(world, admin, sc, { action: "approve", note: "" });
    world.grantDesk.stop(admin, toStop.id, { reason: "PR stayed red" });
    // the digest's regex calls every one overtaken; the hooks retired every ask on those targets
    for (const it of parseRollup(doc.body).items) expect(overtakenReason(world, it, doc)).not.toBeNull();
    expect(rollupCalls(world, doc).every((c) => c.overtaken)).toBe(true);
    for (const [kind, id] of targets) expect(asksFor(world, { kind, id }).filter((a) => a.status === "open" || a.status === "deferred")).toEqual([]);
  }, 30_000);
});
