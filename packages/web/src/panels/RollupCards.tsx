import { parseRollup, rollupHasCards, type ParsedRollup, type RollupItem } from "@muster-town/schema";
import { Markdown } from "./Markdown";

/**
 * A rollup's Shipped items as cards (the rollup format, 1:1 mt_vcn0e66r1t; parser in packages/schema/src/rollup.ts):
 * what it is, what you'd see, the picture, your call. Null when the body isn't a rollup with every item labelled, so
 * the caller falls back to plain markdown.
 */
export function rollupCardsOf(doc: { body: string; tags: string[] }): ParsedRollup | null {
  if (!doc.tags.includes("rollup")) return null;
  const p = parseRollup(doc.body);
  return rollupHasCards(p) ? p : null;
}

export function RollupCard({ item, n }: { item: RollupItem; n: number }) {
  const none = /^none\b/i.test(item.yourCall.trim());
  return (
    <div className="rollup-card">
      <div className="rollup-card-title"><span className="rollup-card-n">{n}</span><Markdown text={item.title} /></div>
      <div className="rollup-card-field"><span className="rollup-card-label">What it is</span><Markdown text={item.whatItIs} /></div>
      <div className="rollup-card-field"><span className="rollup-card-label">What you'd see</span><Markdown text={item.whatYoudSee || "_Not given._"} /></div>
      {item.pictures.length
        ? <div className="rollup-card-pictures"><Markdown text={item.pictures.map((p) => `![${p.alt}](${p.src})`).join("\n\n")} /></div>
        : null}
      <div className={`rollup-card-call${none ? " none" : ""}`}><span className="rollup-card-label">Your call</span><Markdown text={item.yourCall || "None"} /></div>
      {item.after ? <Markdown text={item.after} className="rollup-card-after" /> : null}
    </div>
  );
}

/** The Shipped section as cards; `full` also renders the rest of the body (intro, Decided, Key results, Needs) around them. */
export function RollupCards({ parsed, full }: { parsed: ParsedRollup; full?: boolean }) {
  return (
    <div className="rollup-cards">
      {full && parsed.before ? <Markdown text={parsed.before} /> : null}
      {full ? <h2>Shipped</h2> : null}
      {parsed.shippedIntro ? <Markdown text={parsed.shippedIntro} /> : null}
      {parsed.items.map((it, i) => <RollupCard key={i} item={it} n={i + 1} />)}
      {full && parsed.after ? <Markdown text={parsed.after} /> : null}
    </div>
  );
}
