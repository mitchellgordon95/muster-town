/**
 * A human presses a branch on an ask, and the server does what the branch says (Mitchell, 1:1 mt_m6qjva55rh: "buttons
 * should just be connected to API endpoints that get hit when the user makes a decision"). The branch's act is
 * resolved by schema `branchAct` (a verb on the ask's target, `redeploy`, or `keep`) and executed here through the
 * target's own verb, as the human, so its own permission rule applies and its own hook retires the ask. An ask the
 * target's hook leaves live (a click card on a grant, a goal setting) is then decided with the branch's words, so the
 * record holds what was pressed. The card only draws the buttons. Before this, the client chose the endpoint from a
 * switch and anything it did not parse only recorded the label (findings dc_4b0ehher46: ak_52xdmgycz5, ak_3l51us2os7).
 *
 * The stateful shell: the act is computed by the pure `branchAct`; this gathers the ask and its target and applies it.
 */
import { branchAct, type Agent, type Ask, type BranchAct, type DecideAskInput } from "@muster-town/schema";
import { decideAccess } from "./access.ts";
import { decideAsk } from "./asks.ts";
import { decideCaptain } from "./captain.ts";
import { AppError, badRequest } from "./errors.ts";
import { decideRetainer } from "./retainers.ts";
import type { World } from "./world.ts";

/** The branch a decision names (its label, any case), if it names one. */
const branchNamed = (a: Ask, decision: string) => a.branches.find((b) => b.label.trim().toLowerCase() === decision.trim().toLowerCase());

/** The act a decision on an ask would do (no side effect): the route reads it first, to refuse a redeploy it cannot do. */
export function actOf(world: World, a: Ask, decision: string): BranchAct {
  const b = branchNamed(a, decision);
  if (!b) return { kind: "ask", decision };
  const grant = a.targetKind === "grant" && a.targetId ? world.grants.get(a.targetId) : undefined;
  return branchAct(a, b, grant);
}

const live = (a: Ask | undefined) => !!a && (a.status === "open" || a.status === "deferred");

/**
 * Decide an ask by doing its branch's act. Returns the ask after (retired by the target's hook, or decided) and the
 * act done; a `redeploy` act is the route's (it needs the runtime): this only records it. One transaction: a target
 * verb that refuses leaves the ask as it was.
 */
export function actOnAsk(world: World, actor: Agent | null, id: string, input: DecideAskInput): { ask: Ask; act: BranchAct } {
  const a = world.asks.require(id, "ask");
  if (!live(a)) throw new AppError("conflict", `This ask is already ${a.status}.`);
  const act = actOf(world, a, input.decision);
  if (act.kind === "none") throw badRequest(`The branch "${input.decision}" cannot be pressed on this ask (a held grant is adjusted or cut, never continued).`);
  if (act.kind === "ask" || act.kind === "redeploy") return { ask: decideAsk(world, actor, id, input.decision, input.note), act };
  if (!actor) throw new AppError("forbidden", "Only a signed-in human decides an ask.", 403, "building.fund");
  const target = a.targetId ?? "";
  const note = input.note?.trim() ?? "";
  return world.transaction(() => {
    switch (act.kind) {
      case "grant": {
        const g = world.grants.require(target, "grant");
        const tokens = act.action === "fund" ? input.tokens ?? g.askTokens : input.tokens;
        if (act.action === "adjust" && !tokens) throw badRequest("Adjust needs the new ceiling (tokens).");
        world.grantDesk.decide(actor, target, { action: act.action, note, ...(tokens ? { tokens } : {}), ...(input.deckSlide ? { deckSlide: input.deckSlide } : {}) });
        if (input.meetingId) world.ops.slideGrantDecision(actor, input.meetingId, target, act.action);
        break;
      }
      case "retainer":
        decideRetainer(world, actor, target, { action: act.action, note, ...(input.tokensPerRun ? { tokensPerRun: input.tokensPerRun } : {}), ...(input.until ? { until: input.until } : {}), ...(input.deckSlide ? { deckSlide: input.deckSlide } : {}) });
        break;
      case "captain": decideCaptain(world, actor, target, act.action === "accept", note); break;
      case "access": decideAccess(world, actor, target, act.grant, null); break;
      case "request":
        if (!note) throw badRequest(act.action === "done" ? "Done needs your report back (note): what you did and what you saw." : "Decline needs your reason (note).");
        world.ops.requestAction(actor, target, act.action, note);
        break;
      case "goal":
        if (act.action === "edit" && !input.words?.trim()) throw badRequest("Edit and accept needs the new words (words).");
        // a goal proposal's ask is decided on the proposal, which edits the tree and retires the ask
        world.goalTree.decideProposal(actor, target, { action: act.action === "cut" ? "cut" : "accept", note, ...(act.action === "edit" ? { text: input.words!.trim() } : {}) });
        return { ask: world.asks.require(id, "ask"), act };
      case "goalSetting": world.goalTree.update(actor, target, act.set); break;
      case "keyResult": world.grantDesk.updateKeyResult(actor, target, { status: act.status, note }); break;
    }
    // the target's hook retired it, or (a card its hook leaves live) the branch's words decide it
    const after = world.asks.require(id, "ask");
    return { ask: live(after) ? decideAsk(world, actor, id, input.decision, input.note) : after, act };
  });
}
