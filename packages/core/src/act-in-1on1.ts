/**
 * `act_in_1on1` (the Secretary, gr_kdlogzzo5s step 1; design dc_8gbluwrdgi §3): in a 1:1 a human opened, its agent does a
 * decision the human just said, AS that human. The agent cites the human's own line (by its `at`, from the last 30 min);
 * the town resolves the human's avatar and calls the same `Grants.decide` / `decideRetainer` the buttons call with the
 * human as the actor, so the human's own gates (`canFund`, `canDecideRetainer`) decide: the agent can never do what the
 * human couldn't. The grant's history entry is the human's (`byId`), with `viaAgentId` / `viaMeetingId` and the note
 * `by <Human> via <Agent> in mt_…: "<their words>"`; an event `grant.decided-via` and a line in the 1:1 record it.
 * An open outbox request (dc_…) is declined the same way (1:1 mt_pr3347g2w2 decision 7): `Ops.requestAction` as the
 * human, who needs town.approve_request as on the button; the request records the human as the decider via the agent
 * and meeting, and the author hears why. Stop stays a button (it cancels work), delete a request is the admin's own
 * move, and Bank inputs are out of reach: all refused.
 */
import type { Agent } from "@muster-town/schema";
import { grantName } from "@muster-town/schema";
import { decideRetainer } from "./retainers.ts";
import { badRequest, forbidden, notFound } from "./errors.ts";
import { focusTarget } from "./meeting-focus.ts";
import { meetingNotice } from "./meetings.ts";
import { oneLine } from "./text.ts";
import type { VerbIn } from "./verbs/types.ts";
import type { World } from "./world.ts";

/** How far back a human's line may be cited. */
const ACT_WINDOW_MS = 30 * 60_000;
const GRANT_ACTIONS = ["fund", "counter", "reject", "continue", "adjust", "cut"] as const;
const RETAINER_ACTIONS = ["approve", "counter", "reject"] as const;

export function actForHuman(world: World, agent: Agent, given: VerbIn<"act_in_1on1">, now = new Date()) {
  if (given.action === "stop") throw forbidden("building.fund", "Stopping a grant stays the human's own button (Stop grant… on the grant): it cancels running work. Tell them where it is.");
  if (given.targetId?.startsWith("bi_")) throw forbidden("building.fund", "Bank inputs are out of reach of a 1:1: the human changes them at the Bank themselves.");
  const m = world.meetings.get(given.meetingId);
  if (!m) throw notFound("Meeting", given.meetingId);
  if (m.kind !== "one-on-one" || !m.withUserId) throw badRequest(`${m.id} is not a 1:1: act_in_1on1 only acts on what a human said to you in their 1:1.`);
  // no target named: the item open on the human's screen ("fund it"), still only on their cited words and their own gates
  const targetId = given.targetId ?? focusTarget(world, m);
  if (!targetId) throw badRequest(m.focus ? `The item open on ${world.nameOf(m.withUserId)}'s screen (${m.focus.id}) is not a grant, retainer or outbox request act_in_1on1 can decide: name the targetId, or tell them which button does it.` : "Name the targetId: nothing is open on the human's screen.");
  const input = { ...given, targetId };
  if (m.phase !== "discussing") throw badRequest(`The 1:1 ${m.id} is ${m.phase}, not discussing: act only while it is open.`);
  if (m.facilitatorId !== agent.id) throw forbidden("meeting.facilitate", `You are not the agent of the 1:1 ${m.id}: only the agent the human is talking to acts on their words.`);
  const said = m.transcript.filter((u) => u.at === input.utteranceAt);
  if (!said.length) throw notFound("Utterance", `${input.utteranceAt} in ${m.id} (cite the exact \`at\` of their line, as meeting status shows it)`);
  const u = said.find((x) => x.speakerKind === "user" && x.speakerId === m.withUserId);
  if (!u) throw forbidden("meeting.facilitate", `The line at ${input.utteranceAt} is not ${world.nameOf(m.withUserId)}'s: only the human's own words count.`);
  const age = now.getTime() - new Date(u.at).getTime();
  if (age > ACT_WINDOW_MS) throw badRequest(`That line is ${Math.round(age / 60_000)} min old: only what the human said in the last 30 min counts. Ask them to say it again.`);
  const human = world.agents.first("kind = 'human' AND ownerUserId = ?", [m.withUserId]);
  if (!human || human.status === "banned" || human.status === "retired") throw forbidden("building.fund", `${world.nameOf(m.withUserId)} can't decide anything now.`);

  const quote = oneLine(u.text, 200);
  const via = `by ${human.name} via ${agent.name} in ${m.id}: "${quote}"`;
  const note = input.note.trim() ? `${via}\n${input.note.trim()}` : via;
  const base = { meetingId: m.id, agentId: agent.id, utteranceAt: u.at, byId: m.withUserId, action: input.action };
  let result: { targetId: string; status: string };
  let did: string;
  if (input.targetId.startsWith("gr_")) {
    const action = GRANT_ACTIONS.find((a) => a === input.action);
    if (!action) throw badRequest(`"${input.action}" is not a grant decision: fund / counter / reject a proposal, continue / adjust / cut a checkpoint.`);
    const g = world.grantDesk.decide(human, input.targetId, { action, note, ...(input.tokens && { tokens: input.tokens }) }, { agentId: agent.id, meetingId: m.id });
    world.events.append({ type: "grant.decided-via", agentId: agent.id, buildingId: g.buildingId, text: `${agent.name} did "${action}" on ${g.id} for ${human.name} in ${m.id}: "${quote}"`, payload: { ...base, grantId: g.id, status: g.status } });
    result = { targetId: g.id, status: g.status };
    did = `${action} ${g.id} ("${grantName(g)}"), now ${g.status}`;
  } else if (input.targetId.startsWith("sc_")) {
    const action = RETAINER_ACTIONS.find((a) => a === input.action);
    if (!action) throw badRequest(`"${input.action}" is not a retainer decision: approve, counter or reject.`);
    const v = decideRetainer(world, human, input.targetId, { action, note, ...(action === "counter" && input.tokens && { tokensPerRun: input.tokens }) }, now);
    world.events.append({ type: "grant.decided-via", agentId: agent.id, buildingId: v.buildingId, text: `${agent.name} did "${action}" on the retainer ${v.id} for ${human.name} in ${m.id}: "${quote}"`, payload: { ...base, scheduleId: v.id, retainer: v.retainer } });
    result = { targetId: v.id, status: v.retainer };
    did = `${action} the retainer ${v.id} ("${oneLine(v.title, 80)}"), now ${v.retainer}`;
  } else if (input.targetId.startsWith("dc_")) {
    if (input.action !== "decline") throw badRequest(`"${input.action}" is not a move on an outbox request: decline (delete stays the admin's own button).`);
    const d = world.docs.get(input.targetId);
    if (!d || d.type !== "request") throw notFound("Request", input.targetId);
    const { request } = world.ops.requestAction(human, d.id, "decline", note, { agentId: agent.id, meetingId: m.id });
    world.events.append({ type: "grant.decided-via", agentId: agent.id, buildingId: d.buildingId, text: `${agent.name} declined the request ${d.id} for ${human.name} in ${m.id}: "${quote}"`, payload: { ...base, docId: d.id, requestStatus: request?.requestStatus } });
    result = { targetId: d.id, status: request?.requestStatus ?? "declined" };
    did = `decline the request ${d.id} ("${oneLine(d.title, 80)}"), now ${result.status}; its author was told`;
  } else {
    throw badRequest(`${input.targetId} is neither a grant (gr_…), a schedule with a retainer ask (sc_…) nor an outbox request (dc_…).`);
  }
  meetingNotice(world, m.id, `${agent.name} did this for ${human.name}: ${did}. Citing: "${quote}"`);
  // no ledger ask from a bare act: a rule is proposed only when a human asks for a standing rule (mt_msnjkpgwdb decisions 6, 8)
  return { ...result, recorded: note, note: `Done as ${human.name}; the record says it was you, in this 1:1, quoting them. Say in the 1:1 what you did.` };
}
