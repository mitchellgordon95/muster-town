/**
 * A grant's short name (`Grant.title`, migration 105; docs/legible-delegation.md §5): what names it in under a line, on an
 * ask title, an event, the slate, a deck slide, an in-tray row. The objective is one long sentence and stays on the grant
 * page and in the record; nothing quotes it into a card or a one-line name, so nothing has to clip it.
 */
import { z } from "zod";

/** The longest grant title, in characters. */
export const GRANT_TITLE_MAX = 60;
/** The most words a grant title has (and the back-fill keeps). */
export const GRANT_TITLE_WORDS = 8;
/** The fewest words a proposed grant title has. */
export const GRANT_TITLE_MIN_WORDS = 3;

const TITLE_ID = /\b[a-z]{2}_[a-z0-9]{6,}\b/;
const TITLE_HELP = `a short name for the grant: ${GRANT_TITLE_MIN_WORDS}-${GRANT_TITLE_WORDS} words, at most ${GRANT_TITLE_MAX} characters, no trailing period, no ids, no parentheses (e.g. "Self-host image restores from backup")`;

/** `propose_grant` / POST /api/buildings/:id/grants `title`: refused with what a title is when it is missing or malformed. */
export const GrantTitle = z.string({ error: (iss) => (iss.input === undefined ? `A grant needs a title: ${TITLE_HELP}.` : undefined) })
  .trim()
  .superRefine((s, ctx) => {
    const n = s.split(/\s+/).filter(Boolean).length;
    const id = TITLE_ID.exec(s);
    const why = n < GRANT_TITLE_MIN_WORDS || n > GRANT_TITLE_WORDS ? `${n} word${n === 1 ? "" : "s"}`
      : s.length > GRANT_TITLE_MAX ? `${s.length} characters`
      : /\.$/.test(s) ? "a trailing period"
      : /[()]/.test(s) ? "parentheses"
      : s.includes("…") ? "an ellipsis"
      : id ? `an id (${id[0]})`
      : null;
    if (why) ctx.addIssue({ code: "custom", message: `The title "${s}" has ${why}: give ${TITLE_HELP}.` });
  })
  .describe(TITLE_HELP);

/**
 * The back-fill rule (migration 105 does the same in SQL; a test holds the two equal): the objective's first clause, up
 * to the first comma, colon, semicolon or sentence end, parenthesised asides and ellipses dropped, at most
 * GRANT_TITLE_WORDS words and GRANT_TITLE_MAX characters (whole words), no trailing period, the first letter upper case.
 * Nothing marks a cut: it is a name, not a quote.
 */
export function grantTitleOf(objective: string): string {
  let s = objective.replace(/…/g, "");
  for (;;) {
    const i = s.indexOf("(");
    const j = i < 0 ? -1 : s.indexOf(")", i);
    if (j < 0) break;
    s = s.slice(0, i).replace(/ +$/, "") + s.slice(j + 1);
  }
  s = s.replace(/[()]/g, "").replace(/[\n\r\t]/g, " ").replace(/ {2,}/g, " ");
  const cuts = [",", ":", ";", ". "].map((c) => s.indexOf(c)).filter((i) => i >= 0);
  if (cuts.length) s = s.slice(0, Math.min(...cuts));
  s = s.replace(/^ +| +$/g, "").replace(/[.!? ]+$/, "");
  let out = "";
  const words = s ? s.split(" ") : [];
  for (let n = 0; n < words.length && n < GRANT_TITLE_WORDS; n++) {
    const next = n ? `${out} ${words[n]}` : words[n]!;
    if (next.length > GRANT_TITLE_MAX) break;
    out = next;
  }
  out = (out || s.slice(0, GRANT_TITLE_MAX)).replace(/[.!? ]+$/, "");
  return out ? out[0]!.toUpperCase() + out.slice(1) : "";
}

/** What names a grant in a line: its title, else (a grant made before titles, a fixture) the back-fill rule over its objective. */
export function grantName(g: { title?: string | null; objective: string }): string {
  return g.title?.trim() || grantTitleOf(g.objective) || g.objective.slice(0, GRANT_TITLE_MAX);
}

/** A name for a one-line title (a schedule's, a goal's): the text whole when it fits `max` characters, else the first-clause rule. */
export function nameWithin(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/…/g, "").replace(/\.$/, "");
  return t.length <= max ? t : grantTitleOf(t);
}

/**
 * Text cut to `max` characters at a word, with nothing marking the cut (no ask title or body carries an ellipsis): the
 * last whole word that fits, trailing punctuation dropped.
 */
export function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/…/g, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,:;.\-–—]+$/, "");
}

/** The longest title of an ask read from a rollup's prose, in characters. */
const PROSE_ASK_TITLE_MAX = 160;

/**
 * The title of an ask read from a rollup's prose (a "Your call" or a Needs line): its first whole sentence, markdown and
 * parenthesised asides dropped. A sentence that fits is never cut at a colon ("A 1:1 with Juno", "Optional: give …"
 * keep what follows). A first sentence longer than `max` is cut at its last clause boundary that fits: a semicolon, a colon or a dash before
 * a space, else a comma, else before a joining word ("so", "and", "but" …), else at a word;
 * a boundary in the first third is not taken, so the title is never a fragment of a few words.
 */
export function proseAskTitle(call: string, max = PROSE_ASK_TITLE_MAX): string {
  let s = call
    .replace(/…/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // parenthesised asides (ids, examples, file:line) are no part of what is asked; innermost first
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/\s*\([^()]*\)/g, ""); }
  s = s.replace(/[()]/g, "").replace(/ +([.,;:!?])/g, "$1").replace(/ {2,}/g, " ").trim();
  // the first sentence: . ! ? before a space and a capital, a digit or a quote (so "AGENTS.md", "e.g. x" and "1:1" stay whole)
  const end = /[.!?](?=\s+["“'A-Z0-9])/.exec(s);
  if (end) s = s.slice(0, end.index);
  s = s.replace(/[\s.,;:\-–—]+$/, "");
  if (s.length <= max) return s;
  const fits = (re: RegExp) => { let at = -1; for (const m of s.slice(0, max + 1).matchAll(re)) if (m.index! >= max / 3) at = m.index!; return at; };
  for (const re of [/[;:](?= )| [–—](?= )/g, /,(?= )/g, / (?=(?:so|and|but|because|which|while|then|or) )/g]) {
    const at = fits(re);
    if (at > 0) return s.slice(0, at).replace(/[\s.,;:\-–—]+$/, "");
  }
  return clipWords(s, max);
}

/** A source's own words as an ask card carries them: every ellipsis dropped (the record keeps them). */
export function withoutEllipsis(text: string): string {
  return text.replace(/[ \t]*…[ \t]*/g, " ").replace(/ +([.,;:!?])/g, "$1").replace(/[ \t]+$/gm, "").trim();
}

/** Tokens in the short form ask titles use: 180k, 1.2M. */
export function kTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
