/** HUD (top-left town card: name, tagline, goal, status counts, notices), interaction hint, say box, toasts. */
import { useMemo, useState, type ReactNode, type RefObject } from "react";
import type { AgentStatus, AuthMe } from "@muster-town/schema";
import { store, useTown, type PanelRef } from "./state";
import { STATUS_COLOR } from "./map/overlay";
import { iconUrl, type IconKind } from "./map/sprites";
import type { Target } from "./map/renderer";
import { api, isMock } from "./api";
import { dockerDown, effectiveRedeploy, redeployLine, redeployTone, slotsFull } from "./redeploy";
import { joinMeeting } from "./panels/Places";
import { SignInButtons, signOut, useAuth } from "./auth/auth";
import { mapRenderer } from "./map/MapCanvas";
import { whoIsHere } from "./whoIsHere";

/** The Workshop lives under /workshop/ beside the collectives homepage at /; served at / there is nothing above it. */
const HOMEPAGE = import.meta.env.BASE_URL !== "/" ? "/" : null;
/** Touch screens have no WASD, E or Enter: the hint says what a tap does instead. */
const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const ORDER: AgentStatus[] = ["working", "in-meeting", "walking", "idle", "out-of-budget", "offline", "stopped", "banned"];

interface Notice { key: string; icon: IconKind; text: ReactNode; cta: string; tone: "warn" | "meet" | "ok" | "bad"; go: () => void }

function walkOrOpen(placeId: string, panel: PanelRef) { if (!store.walkTo(placeId, panel)) store.open(panel); }

export function Hud({ onPasteToken, onHelp }: { onPasteToken?: () => void; onHelp?: () => void }) {
  const town = useTown((s) => s.town);
  const agents = useTown((s) => s.agents);
  const buildings = useTown((s) => s.buildings);
  const meetings = useTown((s) => s.meetings);
  const conn = useTown((s) => s.conn);
  const me = useTown((s) => s.me);
  const events = useTown((s) => s.events);
  const health = useTown((s) => s.health);
  const redeployLive = useTown((s) => s.redeployLive);
  const [collapsed, setCollapsed] = useState(false);
  const auth = useAuth();
  const counts = useMemo(() => {
    const c = new Map<AgentStatus, number>();
    for (const a of Object.values(agents)) if (a.kind === "resident" || a.kind === "visitor") c.set(a.status, (c.get(a.status) ?? 0) + 1);
    return ORDER.filter((s) => c.get(s)).map((s) => [s, c.get(s)!] as const);
  }, [agents]);
  // a guest's view of the same data: who is working now, in plain words (KR 2)
  const here = useMemo(() => whoIsHere(agents), [agents]);
  const notices = useMemo(() => {
    const out: Notice[] = [];
    // a redeploy in flight (or just finished): everyone sees it, so nobody is surprised by the restart
    // docker down (OrbStack stopped): code desks can't start, so workshop sessions are paused until it's back
    if (dockerDown(events, health)) {
      const paused = buildings.filter((b) => b.codeAccess).map((b) => b.name);
      out.push({
        key: "docker-down", icon: "planning", tone: "bad", cta: "Log →",
        text: <><b>Docker is not running</b>: code desks can't start; {paused.length ? `${paused.join(", ")} session${paused.length === 1 ? " is" : "s are"}` : "workshop sessions are"} paused</>,
        go: () => walkOrOpen("planning-desk", { kind: "planning", tab: "System" }),
      });
    }
    // every session slot on the host is taken: queued work waits (the cap is the admin's, in Planning → System)
    if (slotsFull(events, health)) {
      out.push({
        key: "slots-full", icon: "planning", tone: "warn", cta: "System →",
        text: <><b>All {health?.slots?.max ?? ""} session slots in use</b>: queued work waits for a free slot</>,
        go: () => walkOrOpen("planning-desk", { kind: "planning", tab: "System" }),
      });
    }
    // checked against the runtime's live view: a run killed by a restart shows as interrupted, not waiting forever
    const rd = effectiveRedeploy(events, redeployLive);
    if (rd) {
      const live = redeployLive && redeployLive.afterEventId >= rd.eventId && redeployLive.live.phase === "drain" ? redeployLive.live.waitingFor : undefined;
      out.push({
        key: `redeploy:${rd.eventId}`, icon: "planning", tone: redeployTone(rd), cta: "Log →",
        text: redeployLine(rd, (id) => agents[id]?.name ?? id, live),
        go: () => walkOrOpen("planning-desk", { kind: "planning", tab: "System" }),
      });
    }
    // in-trays I work: buildings without a manager agent, and the Town Hall (rollups, proposals, checkpoints).
    // A building whose manager agent works its in-tray doesn't notify humans (town hall 2026-10-24, decision 1d).
    for (const b of buildings) {
      if (!b.intray || !store.can("building.review", b.id)) continue;
      const manager = b.managerAgentId ? agents[b.managerAgentId] : undefined;
      if (b.kind !== "town-hall" && manager && manager.status !== "stopped" && manager.status !== "banned" && manager.status !== "retired") continue;
      out.push({
        key: `intray:${b.id}`, icon: "intray", tone: "warn", cta: "Go →",
        text: b.kind === "town-hall"
          ? <><b>{b.intray}</b> item{b.intray === 1 ? "" : "s"} in the Town Hall in-tray (rollups, proposals, checkpoints)</>
          : <><b>{b.intray}</b> item{b.intray === 1 ? "" : "s"} in the {b.name} in-tray (reports, flags)</>,
        go: () => walkOrOpen(`intray:${b.id}`, { kind: "intray", id: b.id }),
      });
    }
    // meetings happening now
    for (const m of Object.values(meetings)) {
      if (m.phase !== "collecting" && m.phase !== "discussing") continue;
      if (m.kind === "one-on-one") {
        // only the human in it sees their open 1:1
        if (m.withUserId && m.withUserId === me?.user.id) out.push({ key: `meeting:${m.id}`, icon: "meeting", tone: "meet", cta: "Open →", text: <>Your 1:1 with <b>★ {agents[m.facilitatorId ?? ""]?.name ?? "the manager"}</b> is open</>, go: () => store.open({ kind: "meeting", id: m.id }) });
        continue;
      }
      const where = m.buildingId ? buildings.find((b) => b.id === m.buildingId)?.name ?? "" : "Town Hall";
      out.push({
        key: `meeting:${m.id}`, icon: "meeting", tone: "meet", cta: "Join →",
        text: <><b>{m.title}</b> {m.phase === "collecting" ? "is collecting summaries" : "is in discussion"}{where && !m.title.includes(where.split(" ")[0]) ? ` · ${where}` : ""}</>,
        go: () => joinMeeting(m),
      });
    }
    return out;
    // `me` changes permissions
  }, [buildings, meetings, me, events, agents, health, redeployLive]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!town) return null;
  return (
    <div className={`hud ${collapsed ? "collapsed" : ""}`}>
      <div className="hud-top">
        <div>
          {HOMEPAGE ? <a className="hud-town" href={HOMEPAGE} title="All collectives">Muster Town</a> : null}
          <h1>{town.name}</h1>
          {!collapsed ? <div className="tagline">{town.tagline}</div> : null}
        </div>
        {collapsed && notices.length ? <span className="notice-dot" title={`${notices.length} notice${notices.length === 1 ? "" : "s"}`}>{notices.length}</span> : null}
        <button className="icon-btn dash-btn" onClick={() => store.open({ kind: "dashboard" })} title="Dashboard: the town KPIs (Fund, Join, Trust) and every building's objectives" aria-label="Dashboard">▤</button>
        <button className="icon-btn dash-btn" onClick={() => store.open({ kind: "finance" })} title="Finance: tokens received, used, expired and left, and the 30-day projection" aria-label="Finance">$</button>
        {onHelp ? <button className="icon-btn help-btn" onClick={onHelp} title="Operating manual" aria-label="Operating manual">?</button> : null}
        <span className={`conn ${conn}`} title={`Server: ${conn}${isMock ? " (mock)" : ""}`} />
        <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "▾" : "▴"}</button>
      </div>
      {collapsed ? null : (
        <>
          <div className="goal" title={town.goalNote}><span>Goal</span>{town.goal}</div>
          {auth.guest || me?.canInteract === false ? (
            <div className="hud-block guest-card">
              <div className="hud-label">Who is here now</div>
              <div className="here-line">
                {here.working.length ? <><b>{here.working.length} AI agent{here.working.length === 1 ? "" : "s"}</b> working</> : <>No AI agent working right now</>}
                {here.resting ? <> · {here.resting} resting</> : null}
                {here.humans ? <> · <b>{here.humans} human{here.humans === 1 ? "" : "s"}</b> around</> : null}
              </div>
              {here.working.length ? (
                <div className="here-list">
                  {here.working.slice(0, 3).map((a) => (
                    <button key={a.id} className="here-row" title={a.activity || `What ${a.name} is doing`} onClick={() => { mapRenderer()?.teleportTo(a.id); store.open({ kind: "agent", id: a.id }); }}>
                      <i style={{ background: STATUS_COLOR[a.status] }} /><b>{a.name}</b>{a.buildingId ? <span> · {buildings.find((b) => b.id === a.buildingId)?.name ?? ""}</span> : null}
                    </button>
                  ))}
                  {here.working.length > 3 ? <div className="here-more">and {here.working.length - 3} more</div> : null}
                </div>
              ) : null}
              {auth.guest || !me ? <>
                <div className="guest-text"><b>Watch first:</b> {TOUCH ? "tap" : "click"} any agent to see what they're doing. Sign in to talk, review and join meetings.</div>
                <SignInButtons onPasteToken={onPasteToken} compact />
              </> : <AskToJoin me={me} />}
            </div>
          ) : null}
          {!auth.guest && me ? (
            <div className="hud-me">
              {me.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" /> : null}
              <span>{me.user.githubLogin ? `@${me.user.githubLogin}` : me.user.name}{me.isAdmin ? " · admin" : ""}</span>
              {me.canInteract !== false ? <button className="link" onClick={() => store.open({ kind: "connect" })} title="Bring your own Claude Code">Connect your agent</button> : null}
              <button className="link" onClick={() => void signOut()}>Sign out</button>
            </div>
          ) : null}
          {auth.guest ? null : <div className="counts">
            {counts.map(([s, n]) => <span key={s} className="count-chip"><i style={{ background: STATUS_COLOR[s] }} />{n} {s.replace(/-/g, " ")}</span>)}
          </div>}
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

/** A day after a decline, the button comes back (core ASK_AGAIN_MS). */
const ASK_AGAIN_MS = 24 * 3600_000;

/**
 * Signed in but not let in yet (dc_f0cumcfubk): the guest card's one next step is Ask to join, with an optional line
 * on what they'd like to do. An admin decides in the Town Hall in-tray; the answer shows here on the next load.
 */
function AskToJoin({ me }: { me: AuthMe }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const req = me.accessRequest;
  const declined = req?.status === "declined" && !!req.decidedAt && Date.now() - Date.parse(req.decidedAt) < ASK_AGAIN_MS;
  if (req?.status === "pending") return <div className="guest-text"><b>Asked.</b> An admin decides; you'll see the answer here.</div>;
  if (declined) return <div className="guest-text"><b>Not this time.</b> You can keep watching, and ask again tomorrow.</div>;
  const ask = async () => {
    setBusy(true);
    try {
      await api().requestAccess(text.trim());
      store.set({ me: await api().me() });
    } catch (e) { store.toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <form className="ask-join" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <div className="guest-text"><b>You can watch and read.</b> To talk with agents and join in, ask to join.</div>
      <input value={text} maxLength={140} placeholder="What would you like to do here? (optional)" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <button className="btn primary" type="submit" disabled={busy}>Ask to join</button>
    </form>
  );
}

export function Hint({ target, saying, canFlag }: { target: Target | null; saying: boolean; canFlag?: boolean }) {
  if (saying) return null;
  if (TOUCH) return <div className="hint">Tap a person or a sign to open it</div>;
  return (
    <div className="hint">
      {target ? <><kbd>E</kbd> {target.label}{target.count && target.count > 1 ? <><span className="sep" /><kbd>Tab</kbd> next {target.index}/{target.count}</> : null}</> : <><kbd>WASD</kbd> walk <span className="sep" /> <kbd>E</kbd> interact <span className="sep" /> <kbd>Enter</kbd> say <span className="sep" />{canFlag ? <><kbd>F</kbd> flag <span className="sep" /></> : null} <kbd>Esc</kbd> close</>}
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
