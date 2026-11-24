/**
 * What an ask's branch does (Mitchell, 1:1 mt_m6qjva55rh: "buttons should just be connected to API endpoints that get
 * hit when the user makes a decision"). A branch declares its act: a verb on the ask's target (its `action`, else the
 * first word of its label), or `redeploy` on an ask with no target, or `keep` for a branch that changes nothing.
 * `branchAct` resolves it; the server executes it at POST /api/asks/:id/decide (core ask-acts.ts) and the card only
 * draws it. `deadBranches` is the door's check: a click ask whose buttons cannot act is missing structure.
 * Pure: no world, no clock.
 */
import type { AskBranch, AskTargetKind, AskType } from "./index.ts";

/**
 * A branch's act. `form`: the button opens a field first (tokens for adjust, tokens and a note for a grant's counter,
 * tokens per run, an end date and a note for a retainer's counter, a note for a request, new words for a goal proposal).
 */
export type BranchAct =
  | { kind: "grant"; action: "fund" | "counter" | "reject" | "adjust" | "cut"; form?: "tokens" | "counter" }
  /** a retainer's Counter opens the grant counter's shape: tokens per run, an optional end date, a note (any one of them) */
  | { kind: "retainer"; action: "approve" | "counter" | "reject"; form?: "retainer" }
  | { kind: "captain"; action: "accept" | "decline" }
  | { kind: "access"; grant: boolean }
  /** a request for a human to act (a do ask): Done takes the report back, Decline the reason; both are required */
  | { kind: "request"; action: "done" | "decline"; form: "note" }
  /** a goal proposal: Accept, Edit and accept (new words first), Cut (an optional note back to the proposer) */
  | { kind: "goal"; action: "accept" | "edit" | "cut"; form?: "words" | "note" }
  /**
   * a goal's own settings (target kind `goal`): its desks (null = none set here; gr_bre43gflz9 step 2, the one goal
   * number), and for old cards its exploration cap per day (a column nothing reads) or exploration on/off
   */
  | { kind: "goalSetting"; set: { desksTotal: number | null } | { exploreCapTokensPerDay: number | null } | { explore: boolean } }
  /** a key result a human marks met or missed */
  | { kind: "keyResult"; status: "met" | "missed" }
  /** an ask with no target whose branch says redeploy: the server redeploys */
  | { kind: "redeploy" }
  /** records the label (and note) as the human's words, and changes nothing else: policy, meeting and question asks, and a declared `keep` */
  | { kind: "ask"; decision: string; keep?: true }
  /** a branch the server refuses (continue at the ceiling): not drawn */
  | { kind: "none" };

const verbOf = (b: Pick<AskBranch, "label" | "action">) => (b.action ?? b.label).trim().toLowerCase().split(/[\s:]+/)[0] ?? "";

/**
 * A goal branch's setting from its declared action: `desks:<n>`, `desks:none` (gr_bre43gflz9 step 2); old cards'
 * `cap:<tokens per day>`, `cap:none`, `explore:on`, `explore:off` still parse.
 */
function goalSetting(action: string | undefined): BranchAct | null {
  const m = /^\s*(desks|cap|explore)\s*[:=]\s*(\S+)\s*$/i.exec(action ?? "");
  if (!m) return null;
  const v = m[2]!.toLowerCase();
  if (m[1]!.toLowerCase() === "desks") {
    if (v === "none") return { kind: "goalSetting", set: { desksTotal: null } };
    const d = Number(v);
    return Number.isInteger(d) && d >= 0 && d <= 1000 ? { kind: "goalSetting", set: { desksTotal: d } } : null;
  }
  if (m[1]!.toLowerCase() === "explore") return v === "on" || v === "off" ? { kind: "goalSetting", set: { explore: v === "on" } } : null;
  if (v === "none") return { kind: "goalSetting", set: { exploreCapTokensPerDay: null } };
  const n = Number(v.replace(/[,_]/g, ""));
  return Number.isInteger(n) && n >= 0 ? { kind: "goalSetting", set: { exploreCapTokensPerDay: n } } : null;
}

/**
 * The act of a branch on an ask (`grant`: the ask's target grant when known, for a money ask's bare Yes / No). Anything
 * that matches no verb of its target records the label as words (`kind: "ask"`); `keep` declares that on purpose.
 */
export function branchAct(ask: { targetKind?: AskTargetKind | null; type?: AskType }, b: Pick<AskBranch, "label" | "action">, grant?: { status: string }): BranchAct {
  const v = verbOf(b);
  if (v === "keep") return { kind: "ask", decision: b.label, keep: true };
  switch (ask.targetKind) {
    case "grant":
      if (v === "fund") return { kind: "grant", action: "fund" };
      if (v === "counter") return { kind: "grant", action: "counter", form: "counter" };
      if (v === "reject") return { kind: "grant", action: "reject" };
      if (v === "cut") return { kind: "grant", action: "cut" };
      if (v === "adjust" || v === "raise" || v === "top") return { kind: "grant", action: "adjust", form: "tokens" };
      // continue is refused at the ceiling: a held grant is adjusted (a new ceiling) or cut
      if (v === "continue") return { kind: "none" };
      // a money ask on a grant never records a bare label (a "Yes" would decide the ask and leave the grant as it was):
      // Yes / No act on the grant by its status, and anything else isn't drawn
      if (ask.type === "money") {
        const yes = v === "yes" || v === "approve", no = v === "no";
        if (grant?.status === "proposed" && (yes || no)) return yes ? { kind: "grant", action: "fund" } : { kind: "grant", action: "reject" };
        if ((grant?.status === "funded" || grant?.status === "checkpoint") && (yes || no)) return yes ? { kind: "grant", action: "adjust", form: "tokens" } : { kind: "grant", action: "cut" };
        return { kind: "none" };
      }
      break;
    case "retainer":
      if (v === "approve" || v === "fund") return { kind: "retainer", action: "approve" };
      if (v === "counter") return { kind: "retainer", action: "counter", form: "retainer" };
      if (v === "reject") return { kind: "retainer", action: "reject" };
      break;
    case "captain":
      if (v === "accept") return { kind: "captain", action: "accept" };
      if (v === "decline") return { kind: "captain", action: "decline" };
      break;
    case "access":
      if (v === "grant" || v === "let") return { kind: "access", grant: true };
      if (v === "decline") return { kind: "access", grant: false };
      break;
    case "request":
      if (v === "done") return { kind: "request", action: "done", form: "note" };
      if (v === "decline") return { kind: "request", action: "decline", form: "note" };
      break;
    case "goalProposal":
      if (v === "accept") return { kind: "goal", action: "accept" };
      if (v === "edit") return { kind: "goal", action: "edit", form: "words" };
      if (v === "cut") return { kind: "goal", action: "cut", form: "note" };
      // the server refuses any other decision on a goal proposal's ask: not drawn
      return { kind: "none" };
    case "goal": {
      const s = goalSetting(b.action);
      if (s) return s;
      break;
    }
    case "keyResult":
      if (v === "met" || v === "missed") return { kind: "keyResult", status: v };
      break;
    case null:
    case undefined:
      if (v === "redeploy" && b.action) return { kind: "redeploy" };
      break;
  }
  return { kind: "ask", decision: b.label };
}

/** The acts a target kind offers, as `action` values an author may give a branch (the door's message names them). */
export const TARGET_ACTS: Record<AskTargetKind | "none", string> = {
  grant: "fund, counter, reject, adjust, cut",
  retainer: "approve, counter, reject",
  captain: "accept, decline",
  access: "grant (let in), decline",
  request: "done, decline",
  goalProposal: "accept, edit, cut",
  goal: "desks:<n>, desks:none (old cards: cap:<tokens per day>, cap:none, explore:on, explore:off)",
  keyResult: "met, missed",
  rule: "",
  meeting: "",
  none: "redeploy",
};

/**
 * The door's check on a click ask (1:1 mt_m6qjva55rh): a click ask is "press this", so every button must do something.
 * Each branch must act on the target (or redeploy), or declare `keep` (it changes nothing; the human's words are kept),
 * and at least one must act. Returns one structure problem per dead branch, [] for any other type or a live card.
 */
export function deadBranches(type: AskType, card: { branches?: readonly Pick<AskBranch, "label" | "action">[]; targetKind?: string | null }): string[] {
  if (type !== "click" || !card.branches?.length) return [];
  const kind = (card.targetKind ?? null) as AskTargetKind | null;
  const acts = card.branches.map((b) => ({ b, act: branchAct({ targetKind: kind, type }, b) }));
  const offered = TARGET_ACTS[kind ?? "none"];
  const how = offered
    ? `give it an action ${kind ? `the ${kind} target can do (${offered})` : `(${offered}), or name the target it acts on (targetId)`}, or action keep for a branch that changes nothing`
    : `a ${kind} has no verb a button can press`;
  const fallback = "If no button can do it, file it as a do ask (request_human) instead.";
  const out = acts.filter(({ act }) => act.kind === "none" || (act.kind === "ask" && !act.keep))
    .map(({ b }) => `structure act: the button "${b.label}" does nothing on ${kind ? `this ${kind}` : "an ask with no target"}: ${how}. ${fallback}`);
  if (!out.length && acts.every(({ act }) => act.kind === "ask")) out.push(`structure act: every button only keeps things as they are: give at least one branch an action that acts. ${fallback}`);
  return out;
}
