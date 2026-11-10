import { parseRollup, rollupAsks, rollupHasCards, type ParsedRollup, type RollupItem } from "@muster-town/schema";
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

function RollupCard({ item, n }: { item: RollupItem; n: number }) {
  const none = /^none\b/i.test(item.yourCall.replace(/[*_`]/g, "").trim());
  return (
    <div className="rollup-card">
      <div className="rollup-card-title"><span className="rollup-card-n">{n}</span><Markdown text={item.title} /></div>
      <div className="rollup-card-field"><span className="rollup-card-label">What it is</span><Markdown text={item.whatItIs} /></div>
      <div className="rollup-card-field"><span className="rollup-card-label">What you'd see</span><Markdown text={item.whatYoudSee || "_Not given._"} /></div>
      {item.pictures.length
        ? <div className="rollup-card-pictures"><Markdown text={item.pictures.map((p) => `![${p.alt}](${p.src})`).join("\n\n")} /></div>
        : null}
      {/* a real call is the gold line under the card; "None" says nothing, so it shows nothing (the Your call block above the cards says "for the record") */}
      {none || !item.yourCall ? null : <div className="rollup-card-call"><span className="rollup-card-label">Your call</span><Markdown text={item.yourCall} /></div>}
      {item.after ? <Markdown text={item.after} className="rollup-card-after" /> : null}
    </div>
  );
}

/** The Shipped section as cards (the in-tray row). */
export function RollupCards({ parsed }: { parsed: ParsedRollup }) {
  return (
    <div className="rollup-cards">
      {parsed.shippedIntro ? <Markdown text={parsed.shippedIntro} /> : null}
      {parsed.items.map((it, i) => <RollupCard key={i} item={it} n={i + 1} />)}
    </div>
  );
}

/** How many lines a folded section holds ("Decided · 8 reports"): its list items, else its table rows, else 0. */
function countOf(md: string): number {
  const lines = md.split("\n");
  const items = lines.filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)).length;
  if (items) return items;
  const rows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
  return rows > 1 ? rows - 1 : 0;
}

function Fold({ summary, text }: { summary: string; text: string }) {
  if (!text.trim()) return null;
  return <details className="rollup-fold"><summary>{summary}</summary><Markdown text={text} /></details>;
}

/**
 * A whole rollup as the human reads it (Mitchell, 1:1 mt_i50xwu4z2t: "the reports themselves are still hard to read",
 * under the progressive-disclosure goal gl_1ds3wl2n78): what he must decide first (every Shipped item's real "Your
 * call" and the Needs lines, in one block), then what is new (the Shipped cards), and the record folded under one
 * click each: Decided, Key results, anything else. The intro line (the live commit) stays one small line on top.
 */
export function RollupReport({ parsed }: { parsed: ParsedRollup }) {
  const asks = rollupAsks(parsed);
  const waiting = /_(?:Already waiting|Nothing else waiting)[^\n]*_/.exec(parsed.sections.needs)?.[0] ?? "";
  const decided = countOf(parsed.sections.decided);
  return (
    <div className="rollup-report">
      {parsed.before ? <Markdown text={parsed.before} className="rollup-intro" /> : null}
      <div className={`rollup-top${asks.length ? "" : " none"}`}>
        <div className="rollup-top-head">{asks.length ? `Your call${asks.length === 1 ? "" : `s (${asks.length})`}` : "Nothing to decide"}</div>
        {asks.length
          ? <ol className="rollup-top-list">{asks.map((a, i) => <li key={i}>{a.n ? <span className="rollup-top-ref" title={a.title}>item {a.n}</span> : null}<Markdown text={a.call} /></li>)}</ol>
          : <div className="muted">For the record: every item's call is None and the building needs nothing from you.</div>}
        {waiting ? <Markdown text={waiting} className="rollup-top-waiting" /> : null}
      </div>
      <h3 className="rollup-h">Shipped{parsed.items.length ? ` (${parsed.items.length})` : ""}</h3>
      <RollupCards parsed={parsed} />
      <Fold summary={`Decided${decided ? ` · ${decided} report${decided === 1 ? "" : "s"}`: ""}`} text={parsed.sections.decided} />
      <Fold summary="Key results and spend" text={parsed.sections.keyResults} />
      <Fold summary="More" text={parsed.sections.other} />
    </div>
  );
}
