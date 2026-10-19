/** Agent panel: status, model, budget; tabs Activity | Chat | Session | Reports | Assignments. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Assignment, Doc } from "@agent-town/schema";
import { api, type AgentDetail } from "../api";
import { store, useTown } from "../state";
import { DocRow, DocView } from "./DocView";
import { PanelShell } from "./PanelShell";
import { Act, Empty, Feed, Field, KV, Loading, Pill, Section, StatusPill, fmtTokens, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";

type Msg = { role: "user" | "assistant"; text: string };
const chats = new Map<string, Msg[]>();

export function AgentPanel({ id, tab }: { id: string; tab?: string }) {
  const agent = useTown((s) => s.agents[id]);
  const rev = useTown((s) => s.rev);
  const buildings = useTown((s) => s.buildings);
  const detail = useLoad(() => api().agent(id), [id]);
  useEffect(() => { if (detail.data) { store.mergeEvents(detail.data.recentEvents); store.putAssignments(detail.data.assignments); if (detail.data.latestReport) store.putDocs([detail.data.latestReport]); } }, [detail.data]);
  useEffect(() => { detail.reload(); }, [rev, detail.reload]); // docs/assignments changed somewhere
  if (!agent) return <PanelShell title="Unknown agent"><Empty>This agent isn't in the town.</Empty></PanelShell>;
  const isService = agent.kind === "service", isHuman = agent.kind === "human";
  const tabs = isHuman ? ["Activity"] : isService ? ["Chat", "Activity"] : ["Activity", "Chat", "Session", "Reports", "Assignments"];
  const defaultTab = isService ? "Chat" : agent.status === "awaiting-review" ? "Reports" : agent.status === "working" ? "Session" : "Activity";
  const building = buildings.find((b) => b.id === (agent.homeBuildingId ?? agent.buildingId));
  return (
    <PanelShell
      key={id}
      icon={<img className="portrait" src={portraitUrl(agent.sprite)} alt="" />}
      title={<>{agent.name} <StatusPill status={agent.status} /></>}
      subtitle={[agent.title || agent.kind, building?.name].filter(Boolean).join(" · ")}
      tabs={tabs}
      initialTab={tab && tabs.includes(tab) ? tab : defaultTab}
    >
      {(t) => (
        <>
          {t === "Activity" ? <ActivityTab agent={agent} detail={detail.data} /> : null}
          {t === "Chat" ? <ChatTab agent={agent} /> : null}
          {t === "Session" ? <SessionTab agent={agent} /> : null}
          {t === "Reports" ? <ReportsTab agent={agent} /> : null}
          {t === "Assignments" ? <AssignmentsTab agent={agent} /> : null}
        </>
      )}
    </PanelShell>
  );
}

function ActivityTab({ agent, detail }: { agent: Agent; detail: AgentDetail | null }) {
  const events = useTown((s) => s.events);
  const mine = useMemo(() => events.filter((e) => e.agentId === agent.id), [events, agent.id]);
  const building = store.state.buildings.find((b) => b.id === agent.homeBuildingId);
  const daily = building?.dailyTokensPerAgent ?? 0;
  return (
    <>
      {agent.direction ? <p className="direction">{agent.direction}</p> : null}
      {agent.kind === "service" ? <div className="actions"><button className="btn" onClick={() => store.open({ kind: "library" })}>Browse the library</button></div> : null}
      {agent.kind !== "human" && agent.kind !== "service" ? (
        <KV items={[
          ["Model", agent.model ?? building?.model ?? "default"],
          ["Today", <>{fmtTokens(agent.spentTokensToday)}{daily ? <> / {fmtTokens(daily)} <Meter v={agent.spentTokensToday / daily} /></> : null}</>],
          ["Total", `${fmtTokens(agent.spentTokensTotal)} tokens · ${usd(agent.spentUsdTotal)}`],
          ["Last active", timeAgo(agent.lastActiveAt)],
        ]} />
      ) : null}
      {agent.activity ? <div className="now"><span className="dot" /> {agent.activity}</div> : null}
      {agent.kind === "resident" && agent.status === "idle" && !detail?.assignments.some((a) => a.status === "pending" || a.status === "active") ? (
        <div className="callout">{agent.name} has no assignment. <button className="link" onClick={() => store.open({ kind: "agent", id: agent.id, tab: "Assignments" })}>Start work →</button></div>
      ) : null}
      <Section title="Activity"><Feed events={mine} empty={`${agent.name} hasn't done anything yet.`} /></Section>
    </>
  );
}

export function Meter({ v }: { v: number }) {
  const p = Math.max(0, Math.min(1, v));
  return <span className={`meter ${p > 0.9 ? "bad" : p > 0.7 ? "warn" : ""}`}><i style={{ width: `${p * 100}%` }} /></span>;
}

function ChatTab({ agent }: { agent: Agent }) {
  const [log, setLog] = useState<Msg[]>(() => chats.get(agent.id) ?? []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { chats.set(agent.id, log); end.current?.scrollIntoView({ block: "end" }); }, [log, agent.id]);
  const send = async () => {
    const q = text.trim(); if (!q || busy) return;
    const history = log.slice(-10);
    setLog((l) => [...l, { role: "user", text: q }]); setText(""); setBusy(true);
    try { const reply = await api().chat(agent.id, { message: q, history }); setLog((l) => [...l, { role: "assistant", text: reply }]); }
    catch (e) { setLog((l) => [...l, { role: "assistant", text: `(couldn't reach ${agent.name}: ${(e as Error).message})` }]); }
    finally { setBusy(false); }
  };
  const hint = agent.kind === "service" ? `Ask ${agent.name} where to find something in the library.` : `Chat with ${agent.name}'s desk assistant. It answers from their activity and reports; it can't change their direction.`;
  return (
    <div className="chat-wrap">
      <div className="chat">
        {!log.length ? <Empty>{hint}</Empty> : null}
        {log.map((m, i) => <div key={i} className={`msg ${m.role === "user" ? "me" : "them"}`}>{m.text}</div>)}
        {busy ? <div className="msg them typing"><i /><i /><i /></div> : null}
        <div ref={end} />
      </div>
      <form className="chatbar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea rows={2} value={text} placeholder={`Message ${agent.name}…`} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

function SessionTab({ agent }: { agent: Agent }) {
  const s = useLoad(() => api().session(agent.id), [agent.id, agent.status === "working"]);
  const events = useTown((st) => st.events);
  const started = s.data?.session?.startedAt;
  const live = useMemo(() => {
    const base = s.data?.transcript ?? [];
    const seen = new Set(base.map((e) => e.id));
    const extra = events.filter((e) => e.agentId === agent.id && !seen.has(e.id) && (!started || e.ts >= started));
    return [...base, ...extra].sort((a, b) => a.id - b.id);
  }, [s.data, events, agent.id, started]);
  const [text, setText] = useState("");
  const canAssign = store.can("building.assign", agent.homeBuildingId) || agent.ownerUserId === store.state.me?.user.id;
  if (s.loading && !s.data) return <Loading />;
  const sess = s.data?.session;
  return (
    <>
      {sess ? (
        <KV items={[
          ["Session", <><Pill tone={sess.status === "running" ? "ok" : sess.status === "error" ? "bad" : ""}>{sess.status}</Pill> {sess.purpose} · started {timeAgo(sess.startedAt)}</>],
          ["Usage", `${sess.turns} turns · ${fmtTokens(sess.tokens)} tokens · ${usd(sess.costUsd)}`],
          ["Model", sess.model],
        ]} />
      ) : <Empty>No session running. The transcript of the last session appears here.</Empty>}
      <Section title="Transcript"><Feed events={live} empty="Waiting for the first tool call…" /></Section>
      {canAssign && agent.status === "working" ? (
        <div className="interrupt">
          <Field label="Interrupt" hint="Delivered as the next user message in the running session.">
            <textarea rows={2} value={text} placeholder={`e.g. "Focus on 2015–2024 only"`} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="actions">
            <Act tone="warn" disabled={!text.trim()} run={async () => { await api().interrupt(agent.id, text.trim()); setText(""); store.toast(`Interrupt sent to ${agent.name}`, "ok"); }}>Send interrupt</Act>
            <Act tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop agent</Act>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ReportsTab({ agent }: { agent: Agent }) {
  const rev = useTown((s) => s.rev);
  // The docs API has no author filter, so list the building's reports and filter client-side.
  const list = useLoad(() => api().docs({ type: "report", buildingId: agent.homeBuildingId ?? undefined, limit: 100 }), [agent.id, rev]);
  const [open, setOpen] = useState<Doc | null>(null);
  const reports = (list.data ?? []).filter((d) => d.authorId === agent.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => { if (!open && reports[0]?.decision === "pending") setOpen(reports[0]); }, [reports[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (open) return <DocView doc={open} onBack={() => setOpen(null)} backLabel="All reports" />;
  if (list.loading && !list.data) return <Loading />;
  if (!reports.length) return <Empty>{agent.name} hasn't submitted a report yet. Every work session ends in one.</Empty>;
  return <div className="doc-list">{reports.map((d) => <DocRow key={d.id} doc={d} onOpen={() => setOpen(d)} />)}</div>;
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
      <Field label="Question for the next session" hint="Leave blank to let the agent continue from its pending assignment or standing direction.">
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
