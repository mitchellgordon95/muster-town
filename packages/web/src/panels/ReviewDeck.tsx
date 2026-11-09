/**
 * The review deck (design dc_y7a8g257of §2, gr_jh0lu0w6yj step 4): GET /api/review-deck, presented in a meeting
 * (MeetingSlide.tsx; the decision queue at the hydrant has no "Review as deck"). Slide 1 is the state of the town, then one slide per pending decision,
 * blocking-most first. The decision buttons under each slide are the in-tray's own (GrantRow; the report's Talk to
 * and Archive; Approve all on "For the record"), sent with `deckSlide`. Deciding moves on to the next item's slide.
 */
import { type CaptainRequestView, type Doc, type ScheduleView, type GrantView, type IntrayRoute, type ReviewSlide } from "@muster-town/schema";
import { api, type AskView, type FunderWeekView, type GoalProposalView } from "../api";
import { AskButtons } from "./AskCard";
import { fundedSlides, type IntrayView } from "./funderFilter";
import { store } from "../state";
import { clampSlide } from "./DeckView";
import { ReportActions } from "./DocView";
import { CaptainRow, GrantRow, RetainerRow } from "./Places";
import { GoalProposalItem } from "./GoalTreePanel";
import { Act } from "./ui";

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
 * "All": every slide. "Funded by me" (step 8): the funder's slide in place of slide 1, then the slides under the goals their money reached.
 */
export function mineSlides(slides: ReviewSlide[], routes: Record<string, IntrayRoute>, view: IntrayView, funder?: FunderWeekView | null): ReviewSlide[] {
  if (view === "funded") return funder ? fundedSlides(slides, routes, funder) : slides;
  if (view === "all") return slides;
  return slides.filter((s) => !s.itemId || s.kind === "record" || routes[s.grantId ?? s.docIds?.[0] ?? s.itemId]?.mine);
}

/** The decision buttons for one slide: pure over its props, so tests render it. */
export function SlideDecision({ slide, n, grants, reports, goalProposals = [], captains = [], retainers = [], asks = [], routes = {}, onDecided, onMarked, onOpenDoc, meetingId }: { slide: ReviewSlide; n: number; grants: GrantView[]; reports: Doc[]; goalProposals?: GoalProposalView[]; captains?: CaptainRequestView[]; retainers?: ScheduleView[]; /** the in-tray's asks: an "ask" slide's buttons (legible delegation step 5) */ asks?: AskView[]; routes?: Record<string, IntrayRoute>; onDecided: () => void; onMarked?: () => void; onOpenDoc: (id: string) => void; meetingId?: string }) {
  // a presented deck keeps a decided item's slide in place (mt_xywhisvdcm): its decision, no buttons
  if (slide.decided) return <div className="review-decide muted">Decided: {slide.decided}. Move on with →.</div>;
  // the money slate (slide 1 when the Secretary filed one): nothing to decide on it, each ask has its own slide
  if (slide.kind === "slate") return <div className="review-decide muted">The slate funds nothing. Decide each money ask on its own slide.</div>;
  // an ask with no item slide of its own (a policy, a meeting, a request, an access ask): its branches as the buttons
  if (slide.kind === "ask") {
    const a = asks.find((x) => x.id === (slide.askId ?? slide.itemId));
    return a ? <div className="review-decide"><AskButtons ask={a} grant={grants.find((g) => g.id === a.targetId)} onDecided={onDecided} deckSlide={n} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.grantId) {
    const g = grants.find((x) => x.id === slide.grantId);
    return g ? <div className="review-decide"><GrantRow grant={g} canDecide={routes[g.id]?.canDecide} route={routes[g.id]} onDecided={onDecided} onMarked={onMarked} onOpenDoc={onOpenDoc} deckSlide={n} meetingId={meetingId} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "goal-proposal") {
    const p = goalProposals.find((x) => x.id === slide.itemId);
    return p ? <div className="review-decide"><GoalProposalItem p={p} onDone={onDecided} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "retainer") {
    const x = retainers.find((y) => y.id === slide.itemId);
    return x ? <div className="review-decide"><RetainerRow x={x} route={routes[x.id]} onDecided={onDecided} deckSlide={n} onOpenDoc={onOpenDoc} /></div> : <div className="review-decide muted">Already decided.</div>;
  }
  if (slide.kind === "captain") {
    const r = captains.find((x) => x.id === slide.itemId);
    return r ? <div className="review-decide"><CaptainRow req={r} route={routes[r.id]} onDecided={onDecided} /></div> : <div className="review-decide muted">Already decided.</div>;
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
      <ReportActions doc={doc} onDone={onDecided} deckSlide={n} meetingId={meetingId}><button className="link" onClick={() => onOpenDoc(doc.id)}>Open the report</button></ReportActions>
    </div>
  );
}
