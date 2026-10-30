/**
 * The review deck (design dc_y7a8g257of §2, gr_jh0lu0w6yj step 4): "Review as deck" in the Town Hall in-tray opens
 * GET /api/review-deck in the slide viewer. Slide 1 is the state of the town, then one slide per pending decision,
 * blocking-most first. The decision buttons under each slide are the in-tray's own (GrantRow; the report's Talk to
 * and reply box; Approve all on "For the record"), sent with `deckSlide`. Deciding moves on to the next item's slide.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { REVIEW_DECK_ID, type Doc, type GrantView, type IntrayRoute, type ReviewSlide } from "@muster-town/schema";
import { api, type GoalProposalView } from "../api";
import { store } from "../state";
import { DeckSlides, clampSlide, slideForKey } from "./DeckView";
import { ReplyBox, TalkToAuthor } from "./DocView";
import { GrantRow } from "./Places";
import { GoalProposalItem } from "./GoalTreePanel";
import { PresentButtons } from "./MeetingSlide";
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

/**
 * "Mine" (docs/goals.md step 4): slide 1, the For the record slide and every slide whose item is routed to the viewer;
 * "All": every slide.
 */
export function mineSlides(slides: ReviewSlide[], routes: Record<string, IntrayRoute>, view: "mine" | "all"): ReviewSlide[] {
  if (view === "all") return slides;
  return slides.filter((s) => !s.itemId || s.kind === "record" || routes[s.grantId ?? s.docIds?.[0] ?? s.itemId]?.mine);
}

/** The decision buttons for one slide: pure over its props, so tests render it. */
export function SlideDecision({ slide, n, grants, reports, goalProposals = [], routes = {}, onDecided, onOpenDoc, meetingId }: { slide: ReviewSlide; n: number; grants: GrantView[]; reports: Doc[]; goalProposals?: GoalProposalView[]; routes?: Record<string, IntrayRoute>; onDecided: () => void; onOpenDoc: (id: string) => void; meetingId?: string }) {
  // a presented deck keeps a decided item's slide in place (mt_xywhisvdcm): its decision, no buttons
  if (slide.decided) return <div className="review-decide muted">Decided: {slide.decided}. Move on with →.</div>;
  if (slide.grantId) {
    const g = grants.find((x) => x.id === slide.grantId);
    return g ? <div className="review-decide"><GrantRow grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onOpenDoc={onOpenDoc} deckSlide={n} meetingId={meetingId} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "goal-proposal") {
    const p = goalProposals.find((x) => x.id === slide.itemId);
    return p ? <div className="review-decide"><GoalProposalItem p={p} onDone={onDecided} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "record") {
    const ids = slide.docIds ?? [];
    const approveAll = async () => {
      const done = await Promise.all(ids.map((id) => api().archive(id, n, meetingId)));
      store.putDocs(done.map((r) => r.doc));
      store.toast(`Approved ${ids.length} rollup${ids.length === 1 ? "" : "s"} for the record.`, "ok");
      onDecided();
    };
    return <div className="review-decide actions"><Act tone="ok" disabled={!ids.length} run={approveAll} title="Archive every rollup on this slide: they ask nothing of you">Approve all</Act></div>;
  }
  if (slide.kind === "blocked" && slide.buildingId) {
    const id = slide.buildingId;
    return store.can("building.manage", id) ? <div className="review-decide actions"><button className="btn sm" onClick={() => store.open({ kind: "building", id, tab: "Goals" })}>Write its key results →</button></div> : null;
  }
  const docId = slide.docIds?.[0];
  const doc = docId ? reports.find((d) => d.id === docId) : undefined;
  if (!doc) return docId ? <div className="review-decide muted">Already decided.</div> : null;
  return (
    <div className="review-decide">
      <div className="actions"><TalkToAuthor doc={doc} /><button className="link" onClick={() => onOpenDoc(doc.id)}>Open the report</button></div>
      <ReplyBox doc={doc} onDone={onDecided} deckSlide={n} meetingId={meetingId} />
    </div>
  );
}

export function ReviewDeckView({ grants, reports, goalProposals = [], view = "all", onClose, onDecided, onOpenDoc }: { grants: GrantView[]; reports: Doc[]; goalProposals?: GoalProposalView[]; view?: "mine" | "all"; onClose: () => void; onDecided: () => void; onOpenDoc: (id: string) => void }) {
  // reload when the in-tray list changes (the badge moved: a rollup arrived, a grant closed), so slide 1 and the slides match the list
  const listKey = [...grants.map((g) => `${g.id}:${g.status}`), ...reports.map((d) => d.id), ...goalProposals.map((p) => p.id), view].join(",");
  const deck = useLoad(() => api().reviewDeck(), [listKey]);
  const routes = deck.data?.routes ?? {};
  const slides = mineSlides(deck.data?.slides ?? [], routes, view);
  const [n, setN] = useState(1);
  const want = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus({ preventScroll: true }); return () => setPanelFull(false); }, []);
  // the deck reloaded after a decision: land on the next item's slide
  useEffect(() => { if (deck.data) { setN((cur) => landingSlide(mineSlides(deck.data!.slides, deck.data!.routes ?? {}, view), want.current, cur)); want.current = null; } }, [deck.data]);
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
      <div className="review-deck-head"><button className="link back" onClick={onClose}>← In-tray list</button><span className="muted">assembled live from the in-tray · 0 tokens</span> <PresentButtons docId={REVIEW_DECK_ID} slide={clampSlide(n, slides.length)} /></div>
      <ErrorLine error={deck.error} />
      {deck.loading && !deck.data ? <Loading /> : (
        <DeckSlides deck={{ title: deck.data?.title ?? "Review deck", slides }} n={clampSlide(n, slides.length)} go={go}>
          {slide ? <SlideDecision key={slide.key} slide={slide} n={clampSlide(n, slides.length)} grants={grants} reports={reports} goalProposals={goalProposals} routes={routes} onDecided={decided} onOpenDoc={onOpenDoc} /> : null}
        </DeckSlides>
      )}
      <div className="deck-help muted">← → or space to move · Home/End · <button className="link" onClick={() => setPanelFull(!isPanelFull())}>f: fullscreen</button> · Esc: back to the list</div>
    </div>
  );
}
