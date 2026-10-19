/** HUD (top-left town card), interaction hint, say box, toasts. */
import { useMemo, useState, type RefObject } from "react";
import type { AgentStatus } from "@agent-town/schema";
import { store, useTown } from "./state";
import { STATUS_COLOR } from "./map/overlay";
import { portraitUrl } from "./map/sprites";
import type { Target } from "./map/renderer";
import { isMock } from "./api";

const ORDER: AgentStatus[] = ["working", "awaiting-review", "in-meeting", "walking", "idle", "out-of-budget", "stopped", "banned"];

export function Hud() {
  const town = useTown((s) => s.town);
  const agents = useTown((s) => s.agents);
  const assignments = useTown((s) => s.assignments);
  const conn = useTown((s) => s.conn);
  const me = useTown((s) => s.me);
  const [collapsed, setCollapsed] = useState(false);
  const residents = useMemo(() => Object.values(agents).filter((a) => a.kind === "resident" || a.kind === "visitor"), [agents]);
  const counts = useMemo(() => {
    const c = new Map<AgentStatus, number>();
    for (const a of residents) c.set(a.status, (c.get(a.status) ?? 0) + 1);
    return ORDER.filter((s) => c.get(s)).map((s) => [s, c.get(s)!] as const);
  }, [residents]);
  const review = residents.filter((a) => a.status === "awaiting-review");
  const idle = useMemo(() => residents.filter((a) => a.kind === "resident" && a.status === "idle" && !a.currentAssignmentId
    && !Object.values(assignments).some((x) => x.agentId === a.id && (x.status === "pending" || x.status === "active"))), [residents, assignments]);
  if (!town) return null;
  return (
    <div className={`hud ${collapsed ? "collapsed" : ""}`}>
      <div className="hud-top">
        <div>
          <h1>{town.name}</h1>
          {!collapsed ? <div className="tagline">{town.tagline}</div> : null}
        </div>
        <span className={`conn ${conn}`} title={`Server: ${conn}${isMock ? " (mock)" : ""}`} />
        <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "▾" : "▴"}</button>
      </div>
      {collapsed ? null : (
        <>
          <div className="goal" title={town.goalNote}><span>Goal</span>{town.goal}</div>
          <div className="counts">
            {counts.map(([s, n]) => <span key={s} className="count-chip"><i style={{ background: STATUS_COLOR[s] }} />{n} {s.replace(/-/g, " ")}</span>)}
          </div>
          {review.length ? (
            <div className="hud-block">
              <div className="hud-label">Needs your review</div>
              {review.map((a) => (
                <button key={a.id} className="hud-row warn" onClick={() => store.open({ kind: "agent", id: a.id, tab: "Reports" })}>
                  <img src={portraitUrl(a.sprite, 1)} alt="" /><b>{a.name}</b><span>report ready</span><em>Review →</em>
                </button>
              ))}
            </div>
          ) : null}
          {idle.length ? (
            <div className="hud-block">
              <div className="hud-label">Idle, no assignment</div>
              {idle.map((a) => (
                <button key={a.id} className="hud-row" onClick={() => store.open({ kind: "agent", id: a.id, tab: "Assignments" })}>
                  <img src={portraitUrl(a.sprite, 1)} alt="" /><b>{a.name}</b><span>{a.title}</span><em>Start work</em>
                </button>
              ))}
            </div>
          ) : null}
          <div className="hud-nav">
            <button onClick={() => store.open({ kind: "library" })}>Library</button>
            <button onClick={() => store.open({ kind: "outbox" })}>Outbox</button>
            <button onClick={() => store.open({ kind: "trophy" })}>Trophies</button>
            {me?.isAdmin ? <button onClick={() => store.open({ kind: "admin" })}>Admin</button> : null}
          </div>
        </>
      )}
    </div>
  );
}

export function Hint({ target, saying }: { target: Target | null; saying: boolean }) {
  if (saying) return null;
  return (
    <div className="hint">
      {target ? <><kbd>E</kbd> {target.label}</> : <><kbd>WASD</kbd> walk <span className="sep" /> <kbd>E</kbd> interact <span className="sep" /> <kbd>Enter</kbd> say <span className="sep" /> <kbd>Esc</kbd> close</>}
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
