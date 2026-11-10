/**
 * A building's "?" help sign (Mitchell's flag dc_8dwch9z5pi; place `help:<buildingId>`, just inside every door):
 * a short paper card on what this building is, what each thing in the room is and what to do here, for whoever is
 * reading. Since flag dc_qppl7741ci it is a tour: the card is a slim paper sheet at the side (a strip at the bottom on
 * a phone), the map frames the building and shadows the rest (map/tour.ts), and each "What's here" row is a numbered
 * hotspot on the map: hover (or a first tap) shows its line, a click walks there and opens it. Esc, ×, the shadowed
 * town or walking away ends it. Copy comes from helpCard.ts, generated from the building's live data.
 */
import { useEffect, useRef, useState } from "react";
import { store, useTown } from "../state";
import { useAuth, SignInButtons } from "../auth/auth";
import { mapRenderer } from "../map/MapCanvas";
import { placePanel } from "../map/renderer";
import { canTalkToManager } from "./oneOnOne";
import { helpCard, type HelpViewer } from "./helpCard";
import "./hiw.css";

const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function HelpSignCard({ buildingId }: { buildingId: string }) {
  const b = useTown((s) => s.buildings.find((x) => x.id === buildingId));
  const places = useTown((s) => s.places);
  const agents = useTown((s) => s.agents);
  const me = useTown((s) => s.me);
  const auth = useAuth();
  const sheet = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  /** the hotspot lit on the map and in the legend: hovered, focused or tapped */
  const [hot, setHot] = useState<string | null>(null);
  useEffect(() => { sheet.current?.focus(); }, []);
  const close = () => store.open(null);
  const viewer: HelpViewer = auth.guest || !me ? "guest" : me.canInteract === false ? "pending"
    : b && store.can("building.review", b.id) ? "reviewer" : "member";
  const signedIn = viewer === "member" || viewer === "reviewer";
  const card = b ? helpCard(b, places, agents, viewer, {
    talk: signedIn && canTalkToManager(b.id),
    flag: signedIn && store.canFlag(b.id),
    touch: TOUCH,
  }) : null;
  const go = (placeId: string) => {
    const p = places.find((x) => x.id === placeId);
    close();
    if (p) store.walkTo(placeId, placePanel(p) ?? undefined);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const spotsKey = card ? card.things.map((t) => t.placeId).join(" ") : "";
  // the tour: while this card is open the map frames the building, shadows the rest and shows its things as hotspots;
  // it ends with the card (unmount), so the map is never left dimmed
  useEffect(() => {
    const r = mapRenderer();
    if (!r || !spotsKey) return;
    r.tour = {
      buildingId, hot: null,
      spots: spotsKey.split(" ").map((placeId, i) => ({ placeId, n: i + 1 })),
      setHot: (id) => { if (r.tour) r.tour.hot = id; setHot(id); },
      go: (id) => goRef.current(id),
      leave: () => store.open(null),
    };
    return () => { r.tour = null; };
  }, [buildingId, spotsKey]);
  const light = (id: string | null) => { const t = mapRenderer()?.tour; if (t) t.hot = id; setHot(id); };
  // the hot thing's tooltip follows its hotspot on the map (the camera eases, so every frame)
  useEffect(() => {
    if (!hot) return;
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = tip.current, rect = mapRenderer()?.tourRect(hot);
      if (!el) return;
      if (!rect) { el.style.visibility = "hidden"; return; }
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth;
      const x = Math.max(6, Math.min(vw - w - 6, rect.x + rect.w / 2 - w / 2));
      const above = rect.y - h - 10;
      const y = above > 6 ? above : rect.y + rect.h + 10;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.visibility = "visible";
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [hot]);
  useEffect(() => {
    if (hot) sheet.current?.querySelector(`[data-spot="${CSS.escape(hot)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hot]);
  if (!b || !card) return null;
  const person = (id: string) => { close(); mapRenderer()?.teleportTo(id); store.open({ kind: "agent", id }); };
  const hotThing = hot ? card.things.find((t) => t.placeId === hot) : undefined;
  return (
    <>
      {hotThing ? (
        <div ref={tip} className={`paper help-tip${TOUCH ? " touch" : ""}`} role="tooltip" style={{ visibility: "hidden" }}>
          <b>{card.things.indexOf(hotThing) + 1}. {hotThing.name}</b>
          <span>{hotThing.line}</span>
          {TOUCH ? <button className="btn primary" onClick={() => go(hotThing.placeId)}>Walk there</button> : null}
        </div>
      ) : null}
      <div ref={sheet} className="paper manual help-sheet" role="dialog" aria-label={`Help: ${card.title}`} tabIndex={-1}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <div className="manual-head">
          <div>
            <div className="hiw-pre">What this building is</div>
            <h2>{card.title}</h2>
          </div>
          <button className="close" onClick={close} aria-label="Close the tour">×</button>
        </div>
        <div className="manual-body">
          {card.goal ? <p className="help-goal">Working on: {card.goal}</p> : null}
          <p className="help-who">
            {card.manager ? <>Manager <button className="help-name" onClick={() => person(card.manager!.id)}>★ {card.manager.name}</button>. </> : null}
            {card.working.length ? <>Working now: {card.working.slice(0, 4).map((a, i) => <span key={a.id}>{i ? ", " : ""}<button className="help-name" onClick={() => person(a.id)}>{a.name}</button></span>)}{card.working.length > 4 ? ` and ${card.working.length - 4} more` : ""}.</> : <>No agent working here right now.</>}
            {card.resting ? <> {card.resting} resting.</> : null}
          </p>
          <section>
            <h3>What's here</h3>
            <ol className="help-legend">
              {card.things.map((t, i) => (
                <li key={t.placeId} data-spot={t.placeId} className={t.placeId === hot ? "on" : undefined}
                  onMouseEnter={() => light(t.placeId)} onMouseLeave={() => light(null)}>
                  <button className="help-row" onClick={() => go(t.placeId)} onFocus={() => light(t.placeId)} onBlur={() => light(null)}>
                    <span className="help-n">{i + 1}</span><span><b>{t.name}</b>: {t.line}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h3>What you can do</h3>
            <ul className="help-list">{card.todo.map((t) => <li key={t}>{t}</li>)}</ul>
            {viewer === "guest" ? <SignInButtons compact /> : null}
          </section>
          <p className="manual-note">More in the <a href="#/manual">operating manual</a>.</p>
        </div>
      </div>
    </>
  );
}
