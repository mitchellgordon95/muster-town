/**
 * Presentation mode (gr_jh0lu0w6yj step 5, design dc_y7a8g257of §1/§3): the slide a meeting presents, in a centred
 * modal over the map while the chat stays in the side panel (Mitchell, mt_xywhisvdcm: no scrolling between the two;
 * on a narrow screen, where the panel is the whole width, it stays above the chat).
 * `meeting.deck` = {docId, slide, presenterId} lives on the meeting row, so every attendee's panel follows the slide
 * over the existing meeting websocket updates. Moving a slide (← → while it has focus, or the arrows) calls
 * POST /api/meetings/:id/present, which also posts "— slide n: <title>" to the transcript. The presenter alone sees
 * the Notes line and the next slide's title. On the review deck the slide's own decision buttons are there too, and a
 * decision made on them is also recorded as one of the meeting's decisions.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { REVIEW_DECK_ID, parseDeck, type DeckSlide, type Meeting } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { DeckSlides, clampSlide, slideForKey } from "./DeckView";
import { SlideDecision } from "./ReviewDeck";
import { ErrorLine, Loading, useLoad } from "./ui";

/** The slide strip itself: pure over its props, so tests render it. `go` null = a viewer (the arrows do nothing). */
export function PresentedSlide({ title, slides, n, presenter, go, children }: { title: string; slides: DeckSlide[]; n: number; presenter: boolean; go: ((n: number) => void) | null; children?: ReactNode }) {
  const at = clampSlide(n, slides.length);
  const next = slides[at];
  return (
    <div className="meeting-slide">
      <div className="meeting-slide-head"><b>Presenting:</b> {title}{presenter ? <span className="muted"> · you are presenting</span> : null}</div>
      <DeckSlides deck={{ title, slides }} n={at} go={go ?? (() => undefined)} showNotes={presenter}>{children}</DeckSlides>
      {presenter ? <div className="deck-notes muted">Next: {next ? next.title || `Slide ${at + 1}` : "(last slide)"}</div> : null}
    </div>
  );
}

export function MeetingSlide({ m }: { m: Meeting & { deck: NonNullable<Meeting["deck"]> } }) {
  const me = useTown((s) => s.me);
  const hallId = useTown((s) => s.buildings.find((b) => b.kind === "town-hall")?.id ?? null);
  const review = m.deck.docId === REVIEW_DECK_ID;
  // the review deck is assembled live: reload it when the slide moves or a slide decision lands
  // review deck: the meeting's pinned slide list (a decided item's slide stays at its number, marked decided)
  const deck = useLoad(() => (review ? api().reviewDeck(m.id).then((d) => ({ title: d.title, slides: d.slides as DeckSlide[] })) : api().doc(m.deck.docId).then((d) => { const p = parseDeck(d.body); return { title: p.title ?? d.title, slides: p.slides }; })), [m.deck.docId, review ? m.deck.slide : 0, review ? m.decisions.length : 0]);
  const intray = useLoad(() => (review && me && hallId ? api().intray(hallId) : Promise.resolve(null)), [review, !!me, hallId, m.decisions.length]);
  const reviewSlides = useMemo(() => (review ? (deck.data?.slides ?? []) : []), [review, deck.data]);
  const box = useRef<HTMLDivElement>(null);
  const live = m.phase === "collecting" || m.phase === "discussing";
  const presenter = !!me && me.user.id === m.deck.presenterId;
  const count = deck.data?.slides.length ?? 0;
  const go = me && live ? (to: number) => {
    const t = clampSlide(to, count);
    if (t === m.deck.slide) return;
    api().presentMeeting(m.id, m.deck.docId, t).then((x) => store.putMeeting(x), (e: Error) => store.toast(e.message, "bad"));
  } : null;
  const [hidden, setHidden] = useState(false);
  const narrow = useNarrow();
  useEffect(() => { if (presenter && !hidden) box.current?.focus({ preventScroll: true }); }, [presenter, hidden]);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (!go || el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const to = slideForKey(e.key, e.shiftKey, m.deck.slide, count);
    if (to === null) return;
    go(to);
    e.preventDefault(); e.stopPropagation();
  };
  const slide = reviewSlides[clampSlide(m.deck.slide, reviewSlides.length) - 1] as Parameters<typeof SlideDecision>[0]["slide"] | undefined;
  const openDoc = (id: string) => store.open({ kind: "library", docId: id });
  const at = clampSlide(m.deck.slide, count);
  const bar = (
    <div className="meeting-slide-bar">
      <b>Presenting:</b> {deck.data?.title ?? "…"}{count ? ` · slide ${at} of ${count}` : ""}{slide?.decided ? ` · decided: ${slide.decided}` : ""}
      {narrow ? null : <> · <button className="link" onClick={() => setHidden(!hidden)}>{hidden ? "Show slides" : "Hide slides"}</button></>}
    </div>
  );
  const body = (
    <div className={`deck meeting-deck${narrow ? "" : " slide-modal"}`} ref={box} tabIndex={0} onKeyDown={key} role={narrow ? undefined : "dialog"} aria-roledescription="slide deck" aria-label={deck.data?.title ?? "Presented deck"}>
      {narrow ? null : <button className="slide-modal-close link" onClick={() => setHidden(true)} title="Hide the slides (the meeting keeps presenting; Show slides in the panel brings them back)">Hide ✕</button>}
      <ErrorLine error={deck.error} />
      {deck.loading && !deck.data ? <Loading /> : deck.data ? (
        <PresentedSlide title={deck.data.title} slides={deck.data.slides} n={m.deck.slide} presenter={presenter} go={go}>
          {review && live && slide && intray.data ? <SlideDecision key={slide.key} slide={slide} n={clampSlide(m.deck.slide, reviewSlides.length)} grants={intray.data.grants} reports={intray.data.reports} onDecided={() => { deck.reload(); intray.reload(); }} onOpenDoc={openDoc} meetingId={m.id} /> : null}
        </PresentedSlide>
      ) : null}
      {go && live ? <div className="deck-help muted">← → or space to move the slide for everyone · <button className="link" onClick={() => api().presentMeeting(m.id, null).then((x) => store.putMeeting(x), (e: Error) => store.toast(e.message, "bad"))}>Stop presenting</button></div> : null}
    </div>
  );
  if (narrow) return body;
  return <>{bar}{hidden ? null : createPortal(<div className="slide-modal-wrap">{body}</div>, document.body)}</>;
}

/** The side panel takes the whole width at ≤760px (panelResize): there the slide stays inline above the chat. */
function useNarrow(): boolean {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 760px)") : null;
  const [narrow, setNarrow] = useState(() => q?.matches ?? false);
  useEffect(() => {
    if (!q) return;
    const f = () => setNarrow(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return narrow;
}

/** Live meetings a signed-in human can present in (not 1:1s), newest first. */
export function useLiveMeetings(): Meeting[] {
  const meetings = useTown((s) => s.meetings);
  const me = useTown((s) => s.me);
  return useMemo(() => (me ? Object.values(meetings).filter((m) => (m.phase === "collecting" || m.phase === "discussing") && m.kind !== "one-on-one").sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt)) : []), [meetings, me]);
}

/** "Present in <meeting>" on a deck doc or the review deck: shows it above that meeting's chat and opens the meeting. */
export function PresentButtons({ docId, slide }: { docId: string; slide: number }) {
  const live = useLiveMeetings();
  if (!live.length) return null;
  const present = (m: Meeting) => api().presentMeeting(m.id, docId, slide).then((x) => { store.putMeeting(x); store.open({ kind: "meeting", id: x.id }); }, (e: Error) => store.toast(e.message, "bad"));
  return (
    <span className="present-buttons">
      {live.slice(0, 3).map((m) => <button key={m.id} className="btn sm" onClick={() => void present(m)} title={`Show this deck above the chat of "${m.title}", from slide ${slide}`}>Present in {m.title}</button>)}
    </span>
  );
}
