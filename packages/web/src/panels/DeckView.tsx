/**
 * A deck doc (type "deck", design dc_y7a8g257of §1) one slide at a time: the slide fills the panel (long text
 * scrolls inside it, never clipped), pictures scale to fit, a `3 / 7` counter and a dot strip sit at the bottom.
 * Keys (while the deck has focus): ← → PgUp PgDn space, Home/End, `f` fullscreen (the panel at its maximum width),
 * `n` presenter notes, Esc leaves fullscreen. The URL follows the slide (`#/doc/<id>/<n>`), so back steps through slides.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseDeck, type ParsedDeck } from "@muster-town/schema";
import { Markdown } from "./Markdown";
import { isPanelFull, setPanelFull } from "./panelResize";
import { setShownDeck, slideHash, slideOfHash } from "../route";
import { store } from "../state";

/** The slide (from 1) a key moves to, or null when the key isn't the deck's. */
export function slideForKey(key: string, shift: boolean, n: number, count: number): number | null {
  const last = Math.max(1, count);
  if (key === "ArrowRight" || key === "PageDown" || (key === " " && !shift)) return Math.min(last, n + 1);
  if (key === "ArrowLeft" || key === "PageUp" || (key === " " && shift)) return Math.max(1, n - 1);
  if (key === "Home") return 1;
  if (key === "End") return last;
  return null;
}

export const clampSlide = (n: number, count: number) => Math.min(Math.max(1, count), Math.max(1, Math.floor(n) || 1));

/** The slide itself, the counter and the dot strip; `go` moves (from 1). Pure, so tests render it. */
export function DeckSlides({ deck, n, go, showNotes }: { deck: ParsedDeck; n: number; go: (n: number) => void; showNotes?: boolean }) {
  const count = deck.slides.length;
  if (!count) return <div className="deck-slide empty muted">This deck has no slides yet. Split slides with a line <code>---</code>.</div>;
  const s = deck.slides[n - 1]!;
  return (
    <>
      <div className="deck-slide" key={n}><Markdown text={s.text} /></div>
      {showNotes ? <div className="deck-notes"><b>Notes:</b> {s.notes || <span className="muted">none on this slide</span>}</div> : null}
      <div className="deck-nav">
        <button className="btn sm" disabled={n <= 1} onClick={() => go(n - 1)} aria-label="Previous slide">←</button>
        <span className="deck-count" aria-live="polite">{n} / {count}</span>
        <button className="btn sm" disabled={n >= count} onClick={() => go(n + 1)} aria-label="Next slide">→</button>
        <span className="deck-dots">
          {deck.slides.map((d, i) => <button key={i} className={i + 1 === n ? "deck-dot on" : "deck-dot"} onClick={() => go(i + 1)} aria-label={`Slide ${i + 1}${d.title ? `: ${d.title}` : ""}`} title={d.title || `Slide ${i + 1}`} />)}
        </span>
      </div>
    </>
  );
}

export function DeckView({ id, body }: { id: string; body: string }) {
  const deck = useMemo(() => parseDeck(body), [body]);
  const count = deck.slides.length;
  const [n, setN] = useState(() => clampSlide(slideOfHash(location.hash, id) ?? 1, count));
  const [notes, setNotes] = useState(false);
  const [full, setFull] = useState(isPanelFull);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShownDeck(id);
    box.current?.focus({ preventScroll: true });
    // back and forward step through the slides this viewer pushed
    const follow = () => { const h = slideOfHash(location.hash, id); if (h !== null) setN(clampSlide(h, count)); };
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      setShownDeck(null);
      setPanelFull(false);
      // closed inside another panel (cabinet, in-tray): its slide URL no longer names what is shown
      const p = store.state.panel;
      if (slideOfHash(location.hash, id) !== null && !(p?.kind === "library" && p.docId === id)) history.replaceState(null, "", location.pathname + location.search);
    };
  }, [id, count]);
  useEffect(() => { const f = () => setFull(isPanelFull()); window.addEventListener("musterTown:panel-full", f); return () => window.removeEventListener("musterTown:panel-full", f); }, []);

  const go = (to: number) => {
    const t = clampSlide(to, count);
    if (t === n) return;
    // the first move from a view whose URL isn't this deck's makes it the deck's slide 1, so back returns there
    if (slideOfHash(location.hash, id) === null) history.replaceState(null, "", slideHash(id, n));
    history.pushState(null, "", slideHash(id, t));
    setN(t);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = slideForKey(e.key, e.shiftKey, n, count);
    if (to !== null) go(to);
    else if (e.key === "f" || e.key === "F") setPanelFull(!isPanelFull());
    else if (e.key === "n" || e.key === "N") setNotes((v) => !v);
    else if (e.key === "Escape" && isPanelFull()) setPanelFull(false);
    else return;
    // the map and the app's own keys (walking, F for a flag, Esc closes the panel) stay out of it
    e.preventDefault(); e.stopPropagation();
  };
  return (
    <div className="deck" ref={box} tabIndex={0} onKeyDown={key} aria-roledescription="slide deck" aria-label={deck.title ?? "Deck"}>
      <DeckSlides deck={deck} n={clampSlide(n, count)} go={go} showNotes={notes} />
      <div className="deck-help muted">
        ← → or space to move · Home/End · <button className="link" onClick={() => setPanelFull(!isPanelFull())}>{full ? "f: exit fullscreen" : "f: fullscreen"}</button> · <button className="link" onClick={() => setNotes((v) => !v)}>{notes ? "n: hide notes" : "n: presenter notes"}</button>
      </div>
    </div>
  );
}
