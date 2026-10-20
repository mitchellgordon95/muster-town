/** Agent panel: status, model, budget; tabs Activity (timeline + composer) | Assignments. Reports live in the in-tray and library. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Assignment, Event } from "@agent-town/schema";
import { api, type AgentDetail } from "../api";
import { store, useTown, roleOf } from "../state";
import { DismissButton, canDismiss } from "./Dismiss";
import { PanelShell } from "./PanelShell";
import { Act, Empty, Field, KV, Pill, Section, StatusPill, clock, fmtTokens, timeAgo, usd, useLoad } from "./ui";
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
  const tabs = agent.kind === "resident" ? ["Activity", "Assignments"] : ["Activity"];
  const building = buildings.find((b) => b.id === (agent.homeBuildingId ?? agent.buildingId));
  return (
    <PanelShell
      key={id}
      icon={<img className="portrait" src={portraitUrl(agent.sprite)} alt="" />}
      title={<>{agent.name} <StatusPill status={agent.status} /></>}
      subtitle={[roleOf(agent) || agent.kind, building?.name].filter(Boolean).join(" · ")}
      tabs={tabs}
      initialTab={tab && tabs.includes(tab) ? tab : "Activity"}
    >
      {(t) => (
        <>
          {t === "Activity" ? <ActivityTab agent={agent} detail={detail.data} /> : null}
          {t === "Assignments" ? <AssignmentsTab agent={agent} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/**
 * One timeline for everything about the agent: its events, the running (or last) session's transcript, messages
 * you sent it, and desk-assistant replies. The composer at the bottom works like Claude Code's: while the agent
 * works, Enter queues your message for the next turn boundary and "Interrupt & send" stops the current turn so it
 * runs right away. While idle, Enter asks the desk assistant, and you can leave a message for the next session.
 */
function ActivityTab({ agent, detail }: { agent: Agent; detail: AgentDetail | null }) {
  const events = useTown((s) => s.events);
  const isService = agent.kind === "service", isHuman = agent.kind === "human";
  const working = agent.status === "working";
  const s = useLoad(() => (isHuman || isService ? Promise.resolve(null) : api().session(agent.id)), [agent.id, working]);
  const [log, setLog] = useState<Msg[]>(() => chats.get(agent.id) ?? []);
  useEffect(() => { chats.set(agent.id, log); }, [log, agent.id]);
  const timeline = useMemo(() => {
    const seen = new Set<number>();
    const evs = [...(s.data?.transcript ?? []), ...events.filter((e) => e.agentId === agent.id)]
      .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
      .sort((a, b) => a.id - b.id);
    // chat lines have no event id: slot each one after the last event at or before its time
    const out: Item[] = evs.map((e) => ({ kind: "ev", ts: e.ts, ev: e }));
    for (const m of log) {
      let i = out.length;
      while (i > 0 && out[i - 1].ts > m.ts) i--;
      out.splice(i, 0, { kind: "msg", ts: m.ts, msg: m });
    }
    return out;
  }, [s.data, events, agent.id, log]);
  const building = store.state.buildings.find((b) => b.id === agent.homeBuildingId);
  const daily = building?.dailyTokensPerAgent ?? 0;
  const sess = s.data?.session;
  useTown((st) => st.me); // re-render when permissions arrive
  const canControl = !isHuman && !isService && (store.can("building.assign", agent.homeBuildingId) || agent.ownerUserId === store.state.me?.user.id);
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
      {agent.kind === "resident" && agent.status === "idle" && !detail?.assignments.some((a) => a.status === "pending" || a.status === "active") ? (
        <div className="callout">{agent.name} has no assignment. <button className="link" onClick={() => store.open({ kind: "agent", id: agent.id, tab: "Assignments" })}>Start work →</button></div>
      ) : null}
      <Timeline items={timeline} empty={isService ? `Ask ${agent.name} where to find something in the library.` : `${agent.name} hasn't done anything yet.`} />
      {isHuman ? null : <Composer agent={agent} canControl={canControl} log={log} setLog={setLog} />}
    </div>
  );
}

type Item = { kind: "ev"; ts: string; ev: Event } | { kind: "msg"; ts: string; msg: Msg };

const EVENT_TONE: Partial<Record<Event["type"], string>> = {
  "agent.tool": "tool", "agent.thought": "thought", "agent.said": "said", "agent.told": "said", "agent.status": "status",
  "doc.created": "doc", "doc.decision": "status", "session.started": "status", "session.ended": "status", "budget.exhausted": "bad",
  "meeting.utterance": "said", "meeting.phase": "status",
};

function Timeline({ items, empty }: { items: Item[]; empty: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [items.length]);
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div className="chat timeline">
      {items.map((it, i) => {
        if (it.kind === "msg") return <div key={`m${i}`} className={`msg ${it.msg.role === "user" ? "me" : "them"}`}>{it.msg.text}</div>;
        const e = it.ev, p = (e.payload ?? {}) as { interrupt?: boolean; now?: boolean; text?: string; sessionId?: string | null };
        if (p.interrupt && typeof p.text === "string") {
          const note = p.now ? "sent now · current turn stopped" : p.sessionId === null ? "waiting for the next session" : "queued for the next turn";
          return <div key={e.id} className="msg me">{p.text}<small>{clock(e.ts)} · {note}</small></div>;
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

function Composer({ agent, canControl, log, setLog }: { agent: Agent; canControl: boolean; log: Msg[]; setLog: (f: (l: Msg[]) => Msg[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const steer = canControl && agent.status === "working";
  const nowIso = () => new Date().toISOString();
  const ask = async (q: string) => {
    const history = log.slice(-10).map(({ role, text }) => ({ role, text }));
    setLog((l) => [...l, { role: "user", text: q, ts: nowIso() }]);
    try { const reply = await api().chat(agent.id, { message: q, history }); setLog((l) => [...l, { role: "assistant", text: reply, ts: nowIso() }]); }
    catch (e) { setLog((l) => [...l, { role: "assistant", text: `(couldn't reach ${agent.name}: ${(e as Error).message})`, ts: nowIso() }]); }
  };
  const run = async (how: "ask" | "queue" | "now") => {
    const q = text.trim(); if (!q || busy) return;
    setBusy(true);
    try {
      if (how === "ask") { setText(""); await ask(q); }
      else {
        // the interrupt event comes back over the stream and shows up in the timeline as your message
        await api().interrupt(agent.id, q, how === "now");
        setText("");
        if (agent.status !== "working") store.toast(`${agent.name} gets this when their next session starts`, "ok");
      }
    } catch (e) { store.toast((e as Error).message || "Request failed", "bad"); }
    finally { setBusy(false); }
  };
  const enter = steer ? "queue" : "ask";
  const placeholder = steer ? `Message ${agent.name}. Enter queues it for the next turn.`
    : agent.kind === "service" ? `Ask ${agent.name}…`
    : `Ask ${agent.name}'s desk assistant. It answers from their activity and reports.`;
  return (
    <form className="chatbar composer" onSubmit={(e) => { e.preventDefault(); void run(enter); }}>
      <textarea rows={2} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(enter); } }} />
      <div className="composer-actions">
        {steer ? (
          <>
            <button className="btn primary" disabled={busy || !text.trim()} title="Delivered when the current turn ends">Queue</button>
            <button type="button" className="btn warn" disabled={busy || !text.trim()} title="Stop the current turn and deliver this right away" onClick={() => void run("now")}>Interrupt &amp; send</button>
            <Act tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={busy || !text.trim()}>{busy ? <span className="spin" /> : null}Ask</button>
            {canControl ? <button type="button" className="btn" disabled={busy || !text.trim()} title="Queued; delivered when their next work session starts" onClick={() => void run("queue")}>Leave for next session</button> : null}
          </>
        )}
      </div>
    </form>
  );
}

export function Meter({ v }: { v: number }) {
  const p = Math.max(0, Math.min(1, v));
  return <span className={`meter ${p > 0.9 ? "bad" : p > 0.7 ? "warn" : ""}`}><i style={{ width: `${p * 100}%` }} /></span>;
}

function AssignmentsTab({ agent }: { agent: Agent }) {
  const all = useTown((s) => s.assignments);
  const list = useMemo(() => Object.values(all).filter((a) => a.agentId === agent.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [all, agent.id]);
  const canAssign = store.can("building.assign", agent.homeBuildingId) || agent.ownerUserId === store.state.me?.user.id;
  return (
    <>
      {canAssign ? <WorkForm agent={agent} /> : null}
      <Section title="Assignments">
        {!list.length ? <Empty>No assignments yet.</Empty> : list.map((a) => <AssignmentRow key={a.id} a={a} />)}
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

function AssignmentRow({ a }: { a: Assignment }) {
  return (
    <div className="asg">
      <div className="asg-head"><b>{a.title}</b><Pill tone={a.status === "active" ? "ok" : a.status === "pending" ? "warn" : a.status === "cancelled" ? "bad" : ""}>{a.status}</Pill></div>
      <div className="asg-desc">{a.description}</div>
      <div className="asg-meta">{a.fromMeetingId ? "from a meeting · " : a.fromReportId ? "from a report · " : ""}{timeAgo(a.createdAt)}</div>
    </div>
  );
}

export function WorkForm({ agent, onDone }: { agent: Agent; onDone?: () => void }) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const busy = agent.status === "working";
  return (
    <form className="work-form" onSubmit={(e) => e.preventDefault()}>
      <Field label="Question for the next session" hint="Leave blank to let the agent continue from its pending assignment, or check in if it has none.">
        <input value={title} placeholder="e.g. Is the land sink weakening?" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Details"><textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Context, scope, sources to start from…" /></Field>
      <div className="actions">
        <Act tone="primary" disabled={busy} title={busy ? "Already working" : undefined} run={async () => {
          await api().work(agent.id, { title: title.trim() || undefined, description: desc.trim() || undefined });
          setTitle(""); setDesc("");
          store.toast(`${agent.name} is starting work`, "ok");
          onDone?.();
        }}>Start work</Act>
      </div>
    </form>
  );
}
