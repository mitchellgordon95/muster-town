/**
 * Deck docs (type "deck", design dc_y7a8g257of §1): the body is markdown and slides are split on a line `---`
 * (outside code fences). The first slide's `#` heading is the deck's title. A slide's optional last line
 * `Notes: …` is presenter-only: it is cut from the shown text. Pictures stay in the text (the viewer renders them).
 */

export interface DeckPicture { alt: string; src: string }
export interface DeckSlide {
  /** The markdown shown on the slide (the Notes line cut). */
  text: string;
  /** The presenter-only Notes line without its "Notes:" label, or "" when there is none. */
  notes: string;
  /** The slide's first heading (any level), or "" when it has none. */
  title: string;
  pictures: DeckPicture[];
}
export interface ParsedDeck {
  /** The first slide's `#` heading, or null. */
  title: string | null;
  slides: DeckSlide[];
}

const SPLIT = /^ {0,3}---\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const NOTES = /^\s*notes:\s*/i;
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function slideOf(lines: string[]): DeckSlide {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  let notes = "";
  if (end > 0 && NOTES.test(lines[end - 1]!)) { notes = lines[end - 1]!.replace(NOTES, "").trim(); end--; }
  const text = lines.slice(0, end).join("\n").trim();
  let title = "";
  let fence: string | null = null;
  for (const l of lines.slice(0, end)) {
    const f = FENCE.exec(l);
    if (f) { if (!fence) fence = f[1]![0]!; else if (f[1]![0] === fence) fence = null; continue; }
    const h = !fence && HEADING.exec(l);
    if (h) { title = h[2]!.replace(/\*\*|__/g, ""); break; }
  }
  const pictures = [...text.matchAll(IMAGE)].map((m) => ({ alt: m[1]!, src: m[2]! }));
  return { text, notes, title, pictures };
}

/** Split a deck body into slides. Never throws; empty slides (e.g. a trailing `---`) are dropped. */
export function parseDeck(body: string): ParsedDeck {
  const chunks: string[][] = [[]];
  let fence: string | null = null;
  for (const l of body.replace(/\r\n?/g, "\n").split("\n")) {
    const f = FENCE.exec(l);
    if (f) { if (!fence) fence = f[1]![0]!; else if (f[1]![0] === fence) fence = null; }
    if (!fence && !f && SPLIT.test(l)) { chunks.push([]); continue; }
    chunks[chunks.length - 1]!.push(l);
  }
  const slides = chunks.map(slideOf).filter((s) => s.text || s.notes);
  const first = slides[0];
  const h1 = first ? /^ {0,3}#\s+(.+?)\s*#*\s*$/m.exec(first.text) : null;
  return { title: h1 ? h1[1]!.replace(/\*\*|__/g, "") : null, slides };
}

/**
 * The review deck (design dc_y7a8g257of §2, gr_jh0lu0w6yj step 4): GET /api/review-deck, assembled in code from the
 * Town Hall in-tray and key results on every request (zero tokens). Each slide is a DeckSlide (DeckView renders it)
 * plus what its decision buttons need. Slide 1 is the state of the town; then one slide per pending decision,
 * blocking-most first; rollups with no call collapse into one closing "For the record" slide.
 */
export type ReviewSlideKind = "town" | "checkpoint" | "blocked" | "proposal" | "goal-proposal" | "captain" | "rollup" | "report" | "close" | "record" | "funder";
export interface ReviewSlide extends DeckSlide {
  /** stable across reloads: what the viewer moves to after a decision */
  key: string;
  kind: ReviewSlideKind;
  /** the decision the slide is for: a grant (gr_…), a goal proposal (gp_…), a report (dc_…) or a building id (blocked); null on slide 1 */
  itemId: string | null;
  /** 0 also = the funder slide (the funder filter's slide 1, goal tree step 8) · 1 checkpoint · 2 blocked · 3 work parked on it · 4 proposal (grant proposals, then goal proposals) · 5 rollup with a call (or another report) · 6 closed as done · 7 for the record; 0 = slide 1 */
  group: number;
  buildingId: string | null;
  /** when the item started waiting on a human (ISO), and how many assignments are parked on its decision */
  since: string | null;
  waiters: number;
  /** one line of what was decided before ("" when nothing applies) */
  history: string;
  /** grant slides: the grant (GrantView) whose buttons the slide shows */
  grantId?: string;
  /** report slides: the report the buttons decide; "For the record": every report Approve all archives */
  docIds?: string[];
  /** a presented deck only: the slide's item was decided during the presentation ("cut", "approved"…); it stays in place, buttons off */
  decided?: string;
}
export interface ReviewDeck { title: string; generatedAt: string; slides: ReviewSlide[] }

/** "None", "None.", "**None**", "none needed": a rollup item with nothing for the human to decide. */
export const isNoCall = (call: string) => !call.trim() || /^none\b/i.test(call.replace(/[*_`]/g, "").trim());
