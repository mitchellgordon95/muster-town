/**
 * The review deck (design dc_y7a8g257of §2, gr_jh0lu0w6yj step 4): "Review as deck" in the Town Hall in-tray opens
 * GET /api/review-deck in the slide viewer. Slide 1 is the state of the town, then one slide per pending decision,
 * blocking-most first. The decision buttons under each slide are the in-tray's own (GrantRow; the report's Talk to
 * and reply box; Approve all on "For the record"), sent with `deckSlide`. Deciding moves on to the next item's slide.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Doc, GrantView, ReviewSlide } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { DeckSlides, clampSlide, slideForKey } from "./DeckView";
import { ReplyBox, TalkToAuthor } from "./DocView";
import { GrantRow } from "./Places";
import { isPanelFull, setPanelFull } from "./panelResize";
import { Act, ErrorLine, Loading, useLoad } from "./ui";

/** After deciding on slide `n`: the key of the first later slide about another item (a rollup's other items go with it). */
export function nextSlideKey(slides: ReviewSlide[], n: number): string | null {
  const cur = slides[n - 1];
  return slides.slice(n).find((s) => !cur || s.itemId !== cur.itemId || s.kind === "record")?.key ?? null;
}

/** Where the viewer lands once the deck reloads: the remembered next slide, else the same position (clamped). */
export function landingSlide(slides: ReviewSlide[], wantKey: string | null, n: number): number {
  const i = wantKey ? slides.findIndex((s) => s.key === wantKey) : -1;
  return i >= 0 ? i + 1 : clampSlide(n, slides.length);
}

/** The decision buttons for one slide: pure over its props, so tests render it. */
export function SlideDecision({ slide, n, grants, reports, onDecided, onOpenDoc }: { slide: ReviewSlide; n: number; grants: GrantView[]; reports: Doc[]; onDecided: () => void; onOpenDoc: (id: string) => void }) {
  if (slide.grantId) {
    const g = grants.find((x) => x.id === slide.grantId);
    return g ? <div className="review-decide"><GrantRow grant={g} onDecided={onDecided} onOpenDoc={onOpenDoc} deckSlide={n} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "record") {
    const ids = slide.docIds ?? [];
    const approveAll = async () => {
      const done = await Promise.all(ids.map((id) => api().archive(id, n)));
      store.putDocs(done.map((r) => r.doc));
      store.toast(`Approved ${ids.length} rollup${ids.length === 1 ? "" : "s"} for the record.`, "ok");
      onDecided();
    };
    return <div className="review-decide actions"><Act tone="ok" disabled={!ids.length} run={approveAll} title="Archive every rollup on this slide: they ask nothing of you">Approve all</Act></div>;
  }
  if (slide.kind === "blocked" && slide.buildingId) {
    const id = slide.buildingId;
    return store.can("building.manage", id) ? <div className="review-decide actions"><button className="btn sm" onClick={() => store.open({ kind: "building", id, tab: "Settings" })}>Write its key results →</button></div> : null;
  }
  const docId = slide.docIds?.[0];
  const doc = docId ? reports.find((d) => d.id === docId) : undefined;
  if (!doc) return docId ? <div className="review-decide muted">Already decided.</div> : null;
  return (
    <div className="review-decide">
      <div className="actions"><TalkToAuthor doc={doc} /><button className="link" onClick={() => onOpenDoc(doc.id)}>Open the report</button></div>
      <ReplyBox doc={doc} onDone={onDecided} deckSlide={n} />
    </div>
  );
}

export function ReviewDeckView({ grants, reports, onClose, onDecided, onOpenDoc }: { grants: GrantView[]; reports: Doc[]; onClose: () => void; onDecided: () => void; onOpenDoc: (id: string) => void }) {
  const deck = useLoad(() => api().reviewDeck(), []);
  const slides = deck.data?.slides ?? [];
  const [n, setN] = useState(1);
  const want = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus({ preventScroll: true }); return () => setPanelFull(false); }, []);
  // the deck reloaded after a decision: land on the next item's slide
  useEffect(() => { if (deck.data) { setN((cur) => landingSlide(deck.data!.slides, want.current, cur)); want.current = null; } }, [deck.data]);
  const go = (to: number) => setN(clampSlide(to, slides.length));
  const decided = () => { want.current = nextSlideKey(slides, n); onDecided(); deck.reload(); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = slideForKey(e.key, e.shiftKey, n, slides.length);
    if (to !== null) go(to);
    else if (e.key === "f" || e.key === "F") setPanelFull(!isPanelFull());
    else if (e.key === "Escape") { if (isPanelFull()) setPanelFull(false); else onClose(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  const slide = slides[clampSlide(n, slides.length) - 1];
  return (
    <div className="deck review-deck" ref={box} tabIndex={0} onKeyDown={key} aria-roledescription="slide deck" aria-label="Review deck">
      <div className="review-deck-head"><button className="link back" onClick={onClose}>← In-tray list</button><span className="muted">assembled live from the in-tray · 0 tokens</span></div>
      <ErrorLine error={deck.error} />
      {deck.loading && !deck.data ? <Loading /> : (
        <DeckSlides deck={{ title: deck.data?.title ?? "Review deck", slides }} n={clampSlide(n, slides.length)} go={go}>
          {slide ? <SlideDecision key={slide.key} slide={slide} n={clampSlide(n, slides.length)} grants={grants} reports={reports} onDecided={decided} onOpenDoc={onOpenDoc} /> : null}
        </DeckSlides>
      )}
      <div className="deck-help muted">← → or space to move · Home/End · <button className="link" onClick={() => setPanelFull(!isPanelFull())}>f: fullscreen</button> · Esc: back to the list</div>
    </div>
  );
}
