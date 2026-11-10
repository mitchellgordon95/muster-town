/**
 * The ask card's contract and linter (docs/legible-delegation.md §4-5, build step 3). An ask is procedural text, an
 * instruction to a human, so its body is written in a subset of ASD-STE100. The rules are prompted, not enforced: since
 * 1:1 mt_ewxnhs90cq decision 5 (2026-11-10) the server refuses only missing structure (`askStructure`: two branches, a
 * recommendation, the type's hard contract fields) and files every style rule a card breaks as a warning in its history
 * (`askWarnings`). The structure is light: a field on the ask, or a sentence or labelled line in the body ("Spent: …").
 *
 * Both are data (`ASK_CONTRACTS`, `ASK_LINT_RULES`), so the town dictionary step (§11 step 10) can extend them.
 */
import type { AskType } from "./index.ts";

/** What a contract or a lint rule reads: the card's body and its structured fields. */
export interface AskCard {
  body: string;
  /** the ask's one line (the linter reads it for an ellipsis only) */
  title?: string;
  branches?: readonly { label: string }[];
  recommendation?: string;
  claims?: readonly unknown[];
  /** what the ask is about: a money ask on a retainer carries no steps */
  targetKind?: string | null;
  /** the town dictionary's "avoid → use" pairs (core dictionary.ts reads them from the Town Hall doc at vet time); none: the rule passes */
  dictionary?: readonly DictionaryPair[];
}

/** One "avoid → use" line of the town dictionary (§5): a word or phrase the town does not use, and the one it uses instead. */
export interface DictionaryPair { avoid: string; use: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The first avoided word of the dictionary in a sentence (whole words, any case), or null. */
function avoidedIn(sentence: string, pairs: readonly DictionaryPair[]): DictionaryPair | null {
  return pairs.find((p) => p.avoid.trim() && new RegExp(`(?<![A-Za-z0-9-])${escapeRe(p.avoid.trim()).replace(/[ -]/g, "[\\s-]+")}s?(?![A-Za-z0-9-])`, "i").test(sentence)) ?? null;
}

// ---- sentences ----

/** The body's sentences: markdown marks stripped, split at line ends and at . ! ? before a space. */
export function askSentences(body: string): string[] {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // a picture is no sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link reads as its text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+\.)\s+/, "").replace(/\*\*|__|`/g, "").trim())
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=\S)/))
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s));
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));

/** Verbs an instruction to the captain starts with (after an optional "If …:" condition). */
const IMPERATIVE = new Set([
  "fund", "continue", "cut", "approve", "reject", "accept", "decline", "counter", "adjust", "raise", "issue", "reissue", "grant",
  "merge", "click", "open", "run", "read", "check", "say", "reply", "keep", "change", "let", "give", "add", "set", "flip", "create",
  "provide", "hold", "scope", "revoke", "rotate", "close", "stop", "pick", "choose", "decide", "answer", "tell", "send", "go",
]);
/** The sentence (or the part after its "If …:" / "If …," condition) starts with an instruction verb. */
function isInstruction(s: string): boolean {
  const rest = /^if\b[^:,]*[:,]\s*(.*)$/i.exec(s)?.[1] ?? s;
  return IMPERATIVE.has((rest.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, ""));
}

/** The longest sentence STE allows: 20 words for an instruction, 25 for a description. */
export const ASK_MAX_WORDS = { instruction: 20, description: 25 } as const;

/** The town's own ids (a known prefix, an underscore, lowercase letters and digits): not any two letters, so a word like db_path is no id. */
const ASK_ID_PREFIXES = ["gr", "dc", "kr", "as", "mt", "sc", "cr", "ar", "ak", "nt", "us", "ag", "bl", "se", "ob", "gl", "mf", "ev"] as const;
const ID = new RegExp(`\\b(?:${ASK_ID_PREFIXES.join("|")})_[a-z0-9]+\\b`);

// ---- the linter ----

/** One countable rule. A sentence rule tests each sentence; a card rule tests the whole card. */
export type AskLintRule =
  | { name: string; says: string; scope: "sentence"; fails: (sentence: string) => string | null }
  | { name: string; says: string; scope: "card"; fails: (card: AskCard, sentences: string[]) => string | null };

const hasRecommendation = (card: AskCard, sentences: string[]) => !!card.recommendation?.trim() || sentences.some((s) => /\brecommends?\b/i.test(s));
const ifBranches = (sentences: string[]) => sentences.filter((s) => /^if\b/i.test(s)).length;

/**
 * The 80% STE rules the server counts (§5). Order is the order the failures are listed in. Extend here: a rule is a
 * name, the one line a manager's prompt quotes (`says`), and a test that returns why it failed or null.
 */
export const ASK_LINT_RULES: readonly AskLintRule[] = [
  {
    name: "sentence-length", scope: "sentence", says: `sentences of at most ${ASK_MAX_WORDS.instruction} words (an instruction) or ${ASK_MAX_WORDS.description} (a description)`,
    fails: (s) => {
      const n = words(s).length, max = isInstruction(s) ? ASK_MAX_WORDS.instruction : ASK_MAX_WORDS.description;
      return n > max ? `${n} words, at most ${max} for ${max === ASK_MAX_WORDS.instruction ? "an instruction" : "a description"}` : null;
    },
  },
  {
    name: "no-ids", scope: "sentence", says: "no ids in the body: names there, ids in targetId and claims",
    fails: (s) => { const m = ID.exec(s); return m ? `names ${m[0]}: write its name, the id goes in targetId or a claim` : null; },
  },
  { name: "no-semicolons", scope: "sentence", says: "no semicolons", fails: (s) => s.includes(";") ? "a semicolon: make it two sentences" : null },
  { name: "no-parentheses", scope: "sentence", says: "no parentheses", fails: (s) => /[()]/.test(s) ? "parentheses: make the aside its own sentence or drop it" : null },
  {
    name: "one-instruction", scope: "sentence", says: "one instruction per sentence",
    fails: (s) => s.split(/\s+or\s+/i).filter((part) => isInstruction(part.trim())).length > 1 ? "two instructions joined by \"or\": give each branch its own \"If you …\" sentence" : null,
  },
  {
    name: "condition-first", scope: "sentence", says: "conditions before the actions they affect (\"If you cut: …\")",
    fails: (s) => /,\s*in which case\b/i.test(s) || /,\s*or\s+[a-z]+\s+it\b/i.test(s) || (isInstruction(s) && !/^if\b/i.test(s) && /,\s*if\b/i.test(s))
      ? "the condition comes after the action: start the sentence with \"If …\"" : null,
  },
  {
    // a clipped quote is no name: say it whole or leave it out (the record keeps the full words)
    name: "no-ellipsis", scope: "card", says: "no ellipsis (…) anywhere: say it whole or leave it out",
    fails: (card) => {
      const where = (["title", "body", "recommendation"] as const).filter((k) => card[k]?.includes("…"));
      return where.length ? `an ellipsis in the ${where.join(" and the ")}: say it whole or leave it out` : null;
    },
  },
  {
    name: "recommendation", scope: "card", says: "a recommendation (the field, or a sentence \"<name> recommends …\")",
    fails: (card, sentences) => hasRecommendation(card, sentences) ? null : "no recommendation: say which branch you recommend",
  },
  {
    name: "branches", scope: "card", says: "at least two branches (the buttons, or \"If you …\" sentences)",
    fails: (card, sentences) => (card.branches?.length ?? 0) >= 2 || ifBranches(sentences) >= 2 ? null : "fewer than two branches: name each choice and what follows from it",
  },
  {
    // step 10: one meaning per word; the pairs are data the caller passes (the Town Hall's dictionary doc)
    name: "dictionary", scope: "card", says: "the town dictionary's words (use its word, not the avoided one)",
    fails: (card, sentences) => {
      const hits = sentences.flatMap((s) => { const p = avoidedIn(s, card.dictionary ?? []); return p ? [`"${p.avoid}" in "${s.length > 80 ? `${s.slice(0, 79)}…` : s}": use "${p.use}"`] : []; });
      return hits.length ? `the dictionary avoids ${hits.join("; ")}` : null;
    },
  },
];

/**
 * Lint an ask's body (with its card fields, when it has them) against `ASK_LINT_RULES`. Each failure is
 * `<rule>: "<the offending sentence>" — <why>` (a card rule names no sentence). [] = it passes.
 */
export function lintAskBody(body: string, card: Omit<AskCard, "body"> = {}): string[] {
  const sentences = askSentences(body);
  const out: string[] = [];
  for (const r of ASK_LINT_RULES) {
    if (r.scope === "sentence") {
      for (const s of sentences) { const why = r.fails(s); if (why) out.push(`${r.name}: "${s.length > 120 ? `${s.slice(0, 119)}…` : s}" (${why})`); }
    } else {
      const why = r.fails({ ...card, body }, sentences);
      if (why) out.push(`${r.name}: ${why}`);
    }
  }
  return out;
}

// ---- the contract per type ----

/** One field a type's card must carry: present on the ask, or as a labelled line or a sentence in the body. */
interface ContractField {
  name: string; needs: string; has: (card: AskCard, sentences: string[]) => boolean;
  /** structure (1:1 mt_ewxnhs90cq decision 5): a card missing it is refused; the rest only warn */
  hard?: true;
}

const label = (name: string) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:`, "im");
const either = (lab: string, re: RegExp) => (c: AskCard, sentences: string[]) => label(lab).test(c.body) || sentences.some((s) => re.test(s));
const claimsCount = (c: AskCard) => c.claims?.length ?? 0;

/** §4's table, one line per field. `needs` is the message a card missing it gets. */
export const ASK_CONTRACTS: Record<AskType, readonly ContractField[]> = {
  money: [
    {
      name: "prior-decision", hard: true, needs: "the human's own prior decision on it and when (\"You funded this at 600k on Oct 31.\", or \"You have not decided on it before.\")",
      has: either("prior decision", /\byou (?:have |had )?(?:not |never )?(?:funded|countered|rejected|continued|adjusted|cut|approved|decided|declined|asked|seen)\b|\bnew proposal\b/i),
    },
    { name: "spent", hard: true, needs: "spent against funded (\"It has spent 474k of 600k.\", or \"Nothing is spent yet.\")", has: either("spent", /\bspent\b/i) },
    {
      name: "steps", hard: true, needs: "steps done and left (\"Three of four steps shipped. One step is left.\")",
      has: (c, s) => c.targetKind === "retainer" || either("steps", /\bsteps?\b.*\b(?:done|left|shipped|remain\w*|finished|to go|none)\b|\b(?:done|left|shipped|none)\b.*\bsteps?\b/i)(c, s),
    },
    { name: "branches", hard: true, needs: "each branch as a button (at least two: Fund and Reject, Continue and Cut)", has: (c) => (c.branches?.length ?? 0) >= 2 },
    { name: "recommendation", hard: true, needs: "your recommendation (the recommendation field)", has: (c) => !!c.recommendation?.trim() },
    { name: "claims", needs: "1-2 load-bearing claims, each with its check (claims: text and check kind pr, url, api, kr or manual)", has: (c) => claimsCount(c) >= 1 && claimsCount(c) <= 2 },
  ],
  click: [
    { name: "parked", hard: true, needs: "who is parked on it and since when (\"Pix has waited on this since Nov 6.\")", has: either("parked", /\b(?:parked|waits?|waited|waiting|blocked|stuck|held)\b/i) },
    {
      name: "permission", needs: "the one-time permission that would stop this ask recurring (\"If you give the test account admin once, this never comes back.\")",
      has: either("permission", /\bpermission\b|\bnever (?:comes? back|recurs?|again)\b|\bstops? (?:it|this) recurring\b|\bonce\b.*\b(?:always|again|for good)\b/i),
    },
  ],
  credential: [
    { name: "scope", hard: true, needs: "the exact scope of the token or key (\"Scope: repo and workflow on the test account.\")", has: either("scope", /\bscopes?\b/i) },
    { name: "fallback", hard: true, needs: "the fallback if you refuse (\"If you decline: the check stays manual.\")", has: either("fallback", /\bfallback\b|^if you (?:decline|refuse|say no)\b|\bwithout it\b/i) },
  ],
  meeting: [
    { name: "question", hard: true, needs: "the one question to settle, as a question", has: (c, s) => label("question").test(c.body) || s.some((x) => x.endsWith("?")) },
    { name: "recommended-answer", hard: true, needs: "your recommended answer (the recommendation field), so the human can reply in a line", has: (c) => !!c.recommendation?.trim() },
  ],
  policy: [
    { name: "rule", hard: true, needs: "the rule as a sentence (\"Rule: a plain member may not 1:1 a manager.\")", has: either("rule", /\brule\b/i) },
    { name: "what-i-did", needs: "what the manager did under it", has: either("what I did", /\b(?:I|we)\s+(?:applied|did|decided|chose|kept|made|let|refused|treated|used)\b|\bapplied\b/i) },
    { name: "reversing-cost", needs: "what reversing it costs (\"Reversing it means …\")", has: either("reversing", /\brevers\w*|\bundo\w*|\bto change it\b/i) },
  ],
};

/** The fields `type`'s card is missing: one message per field, `<type> card needs <what>`. [] = it carries them all. */
export function checkAskContract(type: AskType, card: AskCard): string[] {
  const sentences = askSentences(card.body);
  return ASK_CONTRACTS[type].filter((f) => !f.has(card, sentences)).map((f) => `contract ${f.name}: a ${type} card needs ${f.needs}`);
}

/** The contract, one line per type, for a manager's prompt. */
export const ASK_CONTRACT_LINES: Record<AskType, string> = {
  money: "your human's prior decision on it, spent against funded, steps done and left, two branches, your recommendation, 1-2 claims with checks",
  click: "who is parked on it since when, and the one-time permission that would stop it recurring",
  credential: "the exact scope, and the fallback if refused",
  meeting: "the one question, and your recommended answer",
  policy: "the rule as a sentence, what you did under it, what reversing costs",
};

/** Everything wrong with a card: its type's contract, then the lint rules. [] = it passes. */
export function vetAsk(type: AskType, card: AskCard): string[] {
  return [...checkAskContract(type, card), ...lintAskBody(card.body, card)];
}

/** Lint rules that are structure, not style: the card-level check is `askStructure`'s, so they never also warn. */
const STRUCTURE_LINT = new Set(["recommendation", "branches"]);

/**
 * What a card must carry or be refused (1:1 mt_ewxnhs90cq decision 5, Mitchell 2026-11-10: "i don't think we need the
 * linter for text"): at least two branches as buttons, a recommendation in its field, and its type's hard contract
 * fields. A card with no buttons cannot be clicked, so these stay refusals. [] = it may be filed.
 */
export function askStructure(type: AskType, card: AskCard): string[] {
  const sentences = askSentences(card.body);
  const out: string[] = [];
  if ((card.branches?.length ?? 0) < 2) out.push("structure branches: at least two branches as buttons (Fund and Reject, Continue and Cut)");
  if (!card.recommendation?.trim()) out.push("structure recommendation: the recommendation field, naming the branch you recommend and why");
  const seen = new Set(["branches", "recommendation", "recommended-answer"]);
  for (const f of ASK_CONTRACTS[type]) if (f.hard && !seen.has(f.name) && !f.has(card, sentences)) out.push(`contract ${f.name}: a ${type} card needs ${f.needs}`);
  return out;
}

/**
 * The style rules a card breaks, filed as warnings in its history (never refused): the soft contract fields and every
 * `ASK_LINT_RULES` rule except the structural ones. [] = it is clean.
 */
export function askWarnings(type: AskType, card: AskCard): string[] {
  const sentences = askSentences(card.body);
  const soft = ASK_CONTRACTS[type].filter((f) => !f.hard && !f.has(card, sentences)).map((f) => `contract ${f.name}: a ${type} card should carry ${f.needs}`);
  return [...soft, ...lintAskBody(card.body, card).filter((p) => !STRUCTURE_LINT.has(p.split(":")[0]!))];
}
