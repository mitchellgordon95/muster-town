/**
 * A building's "?" help sign (Mitchell's flag dc_8dwch9z5pi; place `help:<buildingId>`, just inside every door):
 * a short paper card on what this building is, what each thing in the room is and what to do here, for whoever is
 * reading. It reuses the operating manual's paper sheet (style guide §6) at the card's width; "What's here" rows walk
 * to the thing and open it. Copy comes from helpCard.ts, generated from the building's live data.
 */
import { useEffect, useRef } from "react";
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
  useEffect(() => { sheet.current?.focus(); }, []);
  const close = () => store.open(null);
  if (!b) return null;
  const viewer: HelpViewer = auth.guest || !me ? "guest" : me.canInteract === false ? "pending"
    : store.can("building.review", b.id) ? "reviewer" : "member";
  const signedIn = viewer === "member" || viewer === "reviewer";
  const card = helpCard(b, places, agents, viewer, {
    talk: signedIn && canTalkToManager(b.id),
    flag: signedIn && store.canFlag(b.id),
    touch: TOUCH,
  });
  const go = (placeId: string) => {
    const p = places.find((x) => x.id === placeId);
    close();
    if (p) store.walkTo(placeId, placePanel(p) ?? undefined);
  };
  const person = (id: string) => { close(); mapRenderer()?.teleportTo(id); store.open({ kind: "agent", id }); };
  return (
    <div className="hiw-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={sheet} className="paper manual help-card" role="dialog" aria-modal="true" aria-label={`Help: ${card.title}`} tabIndex={-1}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <div className="manual-head">
          <div>
            <div className="hiw-pre">What this building is</div>
            <h2>{card.title}</h2>
          </div>
          <button className="close" onClick={close} aria-label="Close">×</button>
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
            <ul className="help-list">
              {card.things.map((t) => (
                <li key={t.placeId}><button className="help-name" onClick={() => go(t.placeId)}>{t.name}</button>: {t.line}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3>What you can do</h3>
            <ul className="help-list">{card.todo.map((t) => <li key={t}>{t}</li>)}</ul>
            {viewer === "guest" ? <SignInButtons compact /> : null}
          </section>
          <p className="manual-note">More in the <a href="#/manual">operating manual</a>.</p>
        </div>
      </div>
    </div>
  );
}
