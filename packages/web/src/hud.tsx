/** HUD (top-left town card: name, tagline, goal, status counts, notices), interaction hint, say box, toasts. */
import { useMemo, useState, type ReactNode, type RefObject } from "react";
import type { AgentStatus } from "@agent-town/schema";
import { store, useTown, type PanelRef } from "./state";
import { STATUS_COLOR } from "./map/overlay";
import { iconUrl, type IconKind } from "./map/sprites";
import type { Target } from "./map/renderer";
import { isMock } from "./api";
import { joinMeeting } from "./panels/Places";

const ORDER: AgentStatus[] = ["working", "in-meeting", "walking", "idle", "out-of-budget", "offline", "stopped", "banned"];

interface Notice { key: string; icon: IconKind; text: ReactNode; cta: string; tone: "warn" | "meet"; go: () => void }

function walkOrOpen(placeId: string, panel: PanelRef) { if (!store.walkTo(placeId, panel)) store.open(panel); }

export function Hud() {
  const town = useTown((s) => s.town);
  const agents = useTown((s) => s.agents);
  const buildings = useTown((s) => s.buildings);
  const meetings = useTown((s) => s.meetings);
  const conn = useTown((s) => s.conn);
  const me = useTown((s) => s.me);
  const [collapsed, setCollapsed] = useState(false);
  const counts = useMemo(() => {
    const c = new Map<AgentStatus, number>();
    for (const a of Object.values(agents)) if (a.kind === "resident" || a.kind === "visitor") c.set(a.status, (c.get(a.status) ?? 0) + 1);
    return ORDER.filter((s) => c.get(s)).map((s) => [s, c.get(s)!] as const);
  }, [agents]);
  const notices = useMemo(() => {
    const out: Notice[] = [];
    // in-trays of buildings I can review (manager, reviewer, admin)
    for (const b of buildings) {
      if (!b.intray || !store.can("building.review", b.id)) continue;
      out.push({
        key: `intray:${b.id}`, icon: "intray", tone: "warn", cta: "Go →",
        text: <><b>{b.intray}</b> report{b.intray === 1 ? "" : "s"} in the {b.name} in-tray</>,
        go: () => walkOrOpen(`intray:${b.id}`, { kind: "intray", id: b.id }),
      });
    }
    // meetings happening now
    for (const m of Object.values(meetings)) {
      if (m.phase !== "collecting" && m.phase !== "discussing") continue;
      const where = m.buildingId ? buildings.find((b) => b.id === m.buildingId)?.name ?? "" : "Town Hall";
      out.push({
        key: `meeting:${m.id}`, icon: "meeting", tone: "meet", cta: "Join →",
        text: <><b>{m.title}</b> {m.phase === "collecting" ? "is collecting summaries" : "is in discussion"}{where && !m.title.includes(where.split(" ")[0]) ? ` · ${where}` : ""}</>,
        go: () => joinMeeting(m),
      });
    }
    return out;
    // `me` changes permissions
  }, [buildings, meetings, me]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!town) return null;
  return (
    <div className={`hud ${collapsed ? "collapsed" : ""}`}>
      <div className="hud-top">
        <div>
          <h1>{town.name}</h1>
          {!collapsed ? <div className="tagline">{town.tagline}</div> : null}
        </div>
        {collapsed && notices.length ? <span className="notice-dot" title={`${notices.length} notice${notices.length === 1 ? "" : "s"}`}>{notices.length}</span> : null}
        <span className={`conn ${conn}`} title={`Server: ${conn}${isMock ? " (mock)" : ""}`} />
        <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "▾" : "▴"}</button>
      </div>
      {collapsed ? null : (
        <>
          <div className="goal" title={town.goalNote}><span>Goal</span>{town.goal}</div>
          <div className="counts">
            {counts.map(([s, n]) => <span key={s} className="count-chip"><i style={{ background: STATUS_COLOR[s] }} />{n} {s.replace(/-/g, " ")}</span>)}
          </div>
          {notices.length ? (
            <div className="hud-block">
              <div className="hud-label">Notices</div>
              {notices.map((n) => (
                <button key={n.key} className={`hud-row ${n.tone}`} onClick={n.go}>
                  <img className="px" src={iconUrl(n.icon)} alt="" /><span className="notice-text">{n.text}</span><em>{n.cta}</em>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function Hint({ target, saying }: { target: Target | null; saying: boolean }) {
  if (saying) return null;
  return (
    <div className="hint">
      {target ? <><kbd>E</kbd> {target.label}{target.count && target.count > 1 ? <><span className="sep" /><kbd>Tab</kbd> next {target.index}/{target.count}</> : null}</> : <><kbd>WASD</kbd> walk <span className="sep" /> <kbd>E</kbd> interact <span className="sep" /> <kbd>Enter</kbd> say <span className="sep" /> <kbd>Esc</kbd> close</>}
    </div>
  );
}

export function SayBox({ inputRef, onSend, onCancel }: { inputRef: RefObject<HTMLInputElement>; onSend: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <form className="saybox" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) onSend(t); setText(""); onCancel(); }}>
      <span>Say</span>
      <input ref={inputRef} value={text} maxLength={2000} placeholder="Heard by everyone within 3 tiles…" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setText(""); onCancel(); } }} onBlur={onCancel} />
    </form>
  );
}

export function Toasts() {
  const toasts = useTown((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone} ${t.panel ? "clickable" : ""}`} onClick={() => t.panel && store.open(t.panel)}>{t.text}</div>
      ))}
    </div>
  );
}
