/** Agent panel: status, model, budget; tabs Talk (thread + live activity + one message box) | Assignments. Reports live in the in-tray and library. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Assignment, Event } from "@agent-town/schema";
import { api, type ThreadMessage } from "../api";
import { store, useTown, roleOf } from "../state";
import { DismissButton, canDismiss } from "./Dismiss";
import { PanelShell } from "./PanelShell";
import { Act, Empty, KV, Pill, Section, StatusPill, clock, fmtTokens, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";

type Msg = { role: "user" | "assistant"; text: string; ts: string };
const chats = new Map<string, Msg[]>();

export function AgentPanel({ id, tab }: { id: string; tab?: string }) {
  const agent = useTown((s) => s.agents[id]);
  const rev = useTown((s) => s.rev);
  const buildings = useTown((s) => s.buildings);
  const detail = useLoad(() => api().agent(id), [id]);
  useEffect(() => { if (detail.data) { store.mergeEvents(detail.data.recentEvents); store.putAssignments(detail.data.assignments); if (detail.data.latestReport) store.putDocs([detail.data.latestReport]); } }, [detail.data]);
  useEffect(() => { detail.reload(); }, [rev, detail.reload]); // docs/assignments changed somewhere
  if (!agent) return <PanelShell title="Unknown agent"><Empty>This agent isn't in the town.</Empty></PanelShell>;
  const tabs = agent.kind === "resident" ? ["Talk", "Assignments"] : ["Talk"];
  const building = buildings.find((b) => b.id === (agent.homeBuildingId ?? agent.buildingId));
  return (
    <PanelShell
      key={id}
      icon={<img className="portrait" src={portraitUrl(agent.sprite)} alt="" />}
      title={<>{agent.name} {building?.managerAgentId === agent.id ? <Pill tone="warn" title={`Set as ${building.name}'s manager in its settings: facilitates its meetings`}>★ manager</Pill> : null} <StatusPill status={agent.status} /></>}
      subtitle={[roleOf(agent) || agent.kind, building?.name].filter(Boolean).join(" · ")}
      tabs={tabs}
      initialTab={tab && tabs.includes(tab) ? tab : "Talk"}
    >
      {(t) => (
        <>
          {t === "Talk" ? <TalkTab agent={agent} /> : null}
          {t === "Assignments" ? <AssignmentsTab agent={agent} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/**
 * Talk: your messages and the agent's `tell`s back as a chat thread, with its live session activity (tool calls,
 * thoughts, status) interleaved in a muted style, like a Claude Code transcript. One box sends a message: idle →
 * it starts a session; working → it interrupts now (toggle on) or waits in the inbox for the next pause. "Ask" is a
 * read-only quick question to a cheap-model proxy that answers from the agent's activity.
 */
function TalkTab({ agent }: { agent: Agent }) {
  const events = useTown((s) => s.events);
  const me = useTown((s) => s.me);
  const avatarId = me?.avatarAgentId ?? null;
  const isService = agent.kind === "service", isHuman = agent.kind === "human";
  const talkable = agent.kind === "resident" && agent.status !== "retired" && agent.status !== "banned" && !!me;
  const working = agent.status === "working";
  const s = useLoad(() => (isHuman || isService ? Promise.resolve(null) : api().session(agent.id)), [agent.id, working]);
  const th = useLoad(() => (talkable ? api().thread(agent.id) : Promise.resolve([] as ThreadMessage[])), [agent.id, talkable]);
  const [log, setLog] = useState<Msg[]>(() => chats.get(agent.id) ?? []);
  useEffect(() => { chats.set(agent.id, log); }, [log, agent.id]);
  const timeline = useMemo(() => {
    const out: Item[] = [];
    // the thread: fetched, plus `agent.told` events between the agent and my avatar as they stream in
    const seenMsg = new Set<string>();
    for (const m of th.data ?? []) { seenMsg.add(m.id); out.push({ kind: "tell", ts: m.at, mine: m.mine, text: m.body, key: m.id }); }
    const seen = new Set<number>();
    for (const e of [...(s.data?.transcript ?? []), ...events]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const p = (e.payload ?? {}) as { toId?: string; to?: string; messageId?: string; text?: string };
      const to = p.toId ?? p.to;
      if (e.type === "agent.told" && avatarId && ((e.agentId === agent.id && to === avatarId) || (e.agentId === avatarId && to === agent.id))) {
        const key = p.messageId ?? `e${e.id}`;
        if (!seenMsg.has(key)) { seenMsg.add(key); out.push({ kind: "tell", ts: e.ts, mine: e.agentId === avatarId, text: p.text ?? e.text, key }); }
        continue;
      }
      if (e.agentId === agent.id) out.push({ kind: "ev", ts: e.ts, ev: e });
    }
    for (const m of log) out.push({ kind: "ask", ts: m.ts, msg: m });
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [th.data, s.data, events, agent.id, avatarId, log]);
  const building = store.state.buildings.find((b) => b.id === agent.homeBuildingId);
  const daily = building?.dailyTokensPerAgent ?? 0;
  const sess = s.data?.session;
  const canControl = !isHuman && !isService && (store.can("building.assign", agent.homeBuildingId) || agent.ownerUserId === me?.user.id);
  return (
    <div className="chat-wrap">
      {isService ? <div className="actions"><button className="btn" onClick={() => store.open({ kind: "library" })}>Browse the library</button></div> : null}
      {!isHuman && !isService ? (
        <KV items={[
          ["Model", sess?.model ?? agent.model ?? building?.model ?? "default"],
          ["Today", <>{fmtTokens(agent.spentTokensToday)}{daily ? <> / {fmtTokens(daily)} <Meter v={agent.spentTokensToday / daily} /></> : null}</>],
          ["Total", `${fmtTokens(agent.spentTokensTotal)} tokens · ${usd(agent.spentUsdTotal)}`],
          ...(sess ? [["Session", <><Pill tone={sess.status === "running" ? "ok" : sess.status === "error" ? "bad" : ""}>{sess.status}</Pill> {sess.purpose} · started {timeAgo(sess.startedAt)} · {sess.turns} turns · {fmtTokens(sess.tokens)} tokens · {usd(sess.costUsd)}</>] as [string, ReactNode]] : [["Last active", timeAgo(agent.lastActiveAt)] as [string, ReactNode]]),
        ]} />
      ) : null}
      {agent.activity ? <div className="now"><span className="dot" /> {agent.activity}</div> : null}
      {agent.status === "stopped" && canControl ? (
        <div className="callout">{agent.name} is stopped. A message wakes them, or <Act small run={async () => { await api().resume(agent.id); store.toast(`${agent.name} is idle again`, "ok"); }}>Resume</Act> without one.</div>
      ) : null}
      <Timeline items={timeline} agentName={agent.name} empty={isService ? `Ask ${agent.name} where to find something in the library.` : talkable ? `Say something to ${agent.name}. They reply here.` : `${agent.name} hasn't done anything yet.`} />
      {isHuman ? null : <Composer agent={agent} talkable={talkable} canControl={canControl} outOfBudget={agent.status === "out-of-budget" || (daily > 0 && agent.spentTokensToday >= daily)} log={log} setLog={setLog} />}
    </div>
  );
}

type Item =
  | { kind: "ev"; ts: string; ev: Event }
  | { kind: "tell"; ts: string; mine: boolean; text: string; key: string }
  | { kind: "ask"; ts: string; msg: Msg };

const EVENT_TONE: Partial<Record<Event["type"], string>> = {
  "agent.tool": "tool", "agent.thought": "thought", "agent.said": "said", "agent.told": "said", "agent.status": "status",
  "doc.created": "doc", "doc.decision": "status", "session.started": "status", "session.ended": "status", "budget.exhausted": "bad",
  "meeting.utterance": "said", "meeting.phase": "status",
};

function Timeline({ items, empty, agentName }: { items: Item[]; empty: string; agentName: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // pin to the bottom of the panel's scroller (the sticky composer sits below the last line)
    let el: HTMLElement | null = end.current?.parentElement ?? null;
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight; else end.current?.scrollIntoView({ block: "end" });
  }, [items.length]);
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div className="chat timeline talk">
      {items.map((it, i) => {
        if (it.kind === "tell") return <div key={it.key} className={`msg ${it.mine ? "me" : "them"}`}>{it.text}<small>{it.mine ? "you" : agentName} · {clock(it.ts)}</small></div>;
        if (it.kind === "ask") return <div key={`a${i}`} className={`msg ask ${it.msg.role === "user" ? "me" : "them"}`}>{it.msg.text}<small>{it.msg.role === "user" ? "quick question" : "desk assistant (read-only)"} · {clock(it.ts)}</small></div>;
        const e = it.ev, p = (e.payload ?? {}) as { interrupt?: boolean; now?: boolean; text?: string; sessionId?: string | null };
        if (p.interrupt) {
          const note = p.now ? "interrupted the current turn" : p.sessionId === null ? "waiting for the next session" : "queued for the next turn";
          return <div key={e.id} className="ev status"><time title={e.ts}>{clock(e.ts)}</time><span>Message delivered: {note}</span></div>;
        }
        return (
          <div key={e.id} className={`ev ${EVENT_TONE[e.type] ?? ""}`}>
            <time title={e.ts}>{clock(e.ts)}</time>
            <span>{e.text}</span>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Composer({ agent, talkable, canControl, outOfBudget, log, setLog }: { agent: Agent; talkable: boolean; canControl: boolean; outOfBudget: boolean; log: Msg[]; setLog: (f: (l: Msg[]) => Msg[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(true);
  const [asking, setAsking] = useState(!talkable);
  useEffect(() => { if (!talkable) setAsking(true); }, [talkable]);
  const working = agent.status === "working";
  const stamp = () => new Date().toISOString();
  const ask = async (q: string) => {
    const history = log.slice(-10).map(({ role, text }) => ({ role, text }));
    setLog((l) => [...l, { role: "user", text: q, ts: stamp() }]);
    try { const reply = await api().chat(agent.id, { message: q, history }); setLog((l) => [...l, { role: "assistant", text: reply, ts: stamp() }]); }
    catch (e) { setLog((l) => [...l, { role: "assistant", text: `(couldn't reach ${agent.name}'s desk assistant: ${(e as Error).message})`, ts: stamp() }]); }
  };
  const send = async () => {
    const q = text.trim(); if (!q || busy) return;
    setBusy(true);
    try {
      if (asking) { setText(""); await ask(q); return; }
      // your message comes back over the stream as an `agent.told` event and lands in the thread
      const r = await api().message(agent.id, q, now);
      setText("");
      if (r.mode === "queued") store.toast(outOfBudget ? `${agent.name} is out of budget: they'll read it when budget returns` : `${agent.name} will see it at their next pause`, "ok");
    } catch (e) { store.toast((e as Error).message || "Request failed", "bad"); }
    finally { setBusy(false); }
  };
  const status = asking ? `Quick question: ${agent.kind === "service" ? agent.name : `${agent.name}'s desk assistant`} answers from their activity and reports. It can't act.`
    : outOfBudget ? "Out of budget: queued until budget returns."
    : working ? (now ? "Working: your message interrupts now." : "Working: your message waits for the next pause.")
    : agent.status === "stopped" ? "stopped: your message starts a session with it next"
    : "Idle: your message starts a session.";
  const placeholder = asking ? `Ask ${agent.kind === "service" ? agent.name : "a quick question"}…` : `Message ${agent.name}…`;
  return (
    <form className="chatbar composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="talk-status">{status}</div>
      <textarea rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
      <div className="composer-actions">
        {talkable ? (
          <button type="button" className="link talk-ask" onClick={() => setAsking((a) => !a)}>
            {asking ? `Back to messaging ${agent.name}` : "Ask (quick question, read-only)"}
          </button>
        ) : null}
        <span className="grow" />
        {talkable && !asking ? (
          <label className={`talk-now ${working ? "" : "off"}`} title="Only matters while the agent is working: on stops the current turn, off leaves it in their inbox">
            <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} /> interrupt now
          </label>
        ) : null}
        {working && canControl ? <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act> : null}
        <button className="btn primary" disabled={busy || !text.trim()}>{busy ? <span className="spin" /> : null}{asking ? "Ask" : "Send"}</button>
      </div>
    </form>
  );
}

export function Meter({ v }: { v: number }) {
  const p = Math.max(0, Math.min(1, v));
  return <span className={`meter ${p > 0.9 ? "bad" : p > 0.7 ? "warn" : ""}`}><i style={{ width: `${p * 100}%` }} /></span>;
}

/**
 * Assignments: Active (the running one, with Stop), Queue (pending, in run order: reorder, Start next, Cancel), History
 * (done and cancelled, newest first, with Retry). A stopped agent with a queue gets a "Resume queue" banner.
 */
function AssignmentsTab({ agent }: { agent: Agent }) {
  const all = useTown((s) => s.assignments);
  const { active, queue, history } = useMemo(() => {
    const mine = Object.values(all).filter((a) => a.agentId === agent.id);
    return {
      active: mine.filter((a) => a.status === "active"),
      queue: mine.filter((a) => a.status === "pending").sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)),
      history: mine.filter((a) => a.status === "done" || a.status === "cancelled").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }, [all, agent.id]);
  const canControl = store.can("building.assign", agent.homeBuildingId) || agent.ownerUserId === store.state.me?.user.id;
  const stopped = agent.status === "stopped";
  const gone = agent.status === "retired" || agent.status === "banned";
  const put = (r: { assignment?: Assignment; assignments?: Assignment[]; agent?: Agent }) => {
    store.putAssignments([...(r.assignments ?? []), ...(r.assignment ? [r.assignment] : [])]);
  };
  const move = async (i: number, d: -1 | 1) => {
    const ids = queue.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    put(await api().reorderQueue(agent.id, ids));
  };
  return (
    <>
      {stopped && canControl ? (
        queue.length ? (
          <div className="callout queue-banner">
            <span>Stopped with {queue.length} queued.</span>
            <Act small tone="primary" run={async () => { await api().resume(agent.id); store.toast(`${agent.name} resumed: "${queue[0].title}" runs next`, "ok"); }}>Resume queue</Act>
          </div>
        ) : <div className="callout">Stopped. Message the agent to start it again.</div>
      ) : null}
      <Section title="Active">
        {!active.length ? <Empty>{stopped ? "Nothing running: stopped." : "Nothing running."}</Empty> : active.map((a) => (
          <AssignmentRow key={a.id} a={a} actions={canControl && agent.status === "working" ? (
            <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act>
          ) : null} />
        ))}
      </Section>
      <Section title={`Queue${queue.length ? ` (${queue.length})` : ""}`}>
        {!queue.length ? <Empty>No queued assignments. A message to {agent.name} starts one.</Empty> : queue.map((a, i) => (
          <AssignmentRow key={a.id} a={a} index={i + 1} actions={canControl && !gone ? (
            <>
              <button type="button" className="btn sm icon" title="Move up" disabled={i === 0} onClick={() => void move(i, -1).catch((e: Error) => store.toast(e.message, "bad"))}>▲</button>
              <button type="button" className="btn sm icon" title="Move down" disabled={i === queue.length - 1} onClick={() => void move(i, 1).catch((e: Error) => store.toast(e.message, "bad"))}>▼</button>
              <Act small tone="primary" title={stopped ? `Resume ${agent.name} with this` : "Run this one next"} run={async () => {
                const r = await api().startNext(a.id); put(r);
                store.toast(r.when === "now" ? `${agent.name} is starting "${a.title}"` : `"${a.title}" runs after the current session`, "ok");
              }}>Start next</Act>
              <Act small tone="bad" run={async () => { put(await api().cancelAssignment(a.id)); }}>Cancel</Act>
            </>
          ) : null} />
        ))}
      </Section>
      <Section title="History">
        {!history.length ? <Empty>No finished assignments yet.</Empty> : history.map((a) => (
          <AssignmentRow key={a.id} a={a} actions={canControl && !gone ? (
            <Act small title="Queue it again, at the front" run={async () => { put(await api().retryAssignment(a.id, true)); store.toast(`"${a.title}" is queued first again`, "ok"); }}>Retry</Act>
          ) : null} />
        ))}
      </Section>
      {canDismiss(agent) ? (
        <Section title="Manager">
          <p className="direction">Dismissing retires {agent.name}: the desk is freed and they leave the map. Reports and notes stay in the library under their name.</p>
          <DismissButton agent={agent} />
        </Section>
      ) : null}
    </>
  );
}

function AssignmentRow({ a, actions, index }: { a: Assignment; actions?: ReactNode; index?: number }) {
  const [open, setOpen] = useState(false);
  const long = a.description.length > 160;
  return (
    <div className={`asg ${a.status}`}>
      <div className="asg-head">
        <b>{index ? <span className="asg-n">{index}.</span> : null}{a.title}</b>
        <Pill tone={a.status === "active" ? "ok" : a.status === "pending" ? "warn" : a.status === "cancelled" ? "bad" : ""}>{a.status === "pending" ? "queued" : a.status}</Pill>
      </div>
      {a.description ? <div className="asg-desc" onClick={() => long && setOpen((o) => !o)}>{long && !open ? a.description.slice(0, 157) + "…" : a.description}</div> : null}
      <div className="asg-meta">
        {a.fromAssignmentId ? "retried · " : a.fromMeetingId ? "from a meeting · " : a.fromReportId ? "from a report · " : ""}
        {a.status === "done" || a.status === "cancelled" ? `${a.status} ${timeAgo(a.updatedAt)}` : `created ${timeAgo(a.createdAt)}`}
        {a.reportId ? <> · <button type="button" className="link" onClick={() => store.open({ kind: "library", docId: a.reportId! })}>report</button></> : null}
      </div>
      {actions ? <div className="asg-actions">{actions}</div> : null}
    </div>
  );
}
