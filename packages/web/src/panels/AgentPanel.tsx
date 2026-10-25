/**
 * Agent panel: status, model, budget; tabs Talk (live activity; a message box only for the building's manager agent,
 * the one resident humans talk to) | Assignments | Memory (the resident's wiki pages and log: what it knows and did).
 * Reports live in the in-tray and library.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Assignment, Doc, Event, Permission } from "@muster-town/schema";
import { api, type AgentPermissionsView, type ThreadMessage } from "../api";
import { store, useTown, roleOf } from "../state";
import { DismissButton, canDismiss } from "./Dismiss";
import { PanelShell } from "./PanelShell";
import { DocText, Markdown } from "./Markdown";
import { Act, Empty, KV, Pill, Section, StatusPill, clock, fmtTokens, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";
import { SignInNote } from "../auth/auth";
import { slotsFull } from "../redeploy";
import { canOneOnOne, openOneOnOne } from "./oneOnOne";

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
  const tabs = agent.kind === "resident" ? ["Talk", "Assignments", "Memory"] : agent.kind === "visitor" ? ["Talk", "Assignments"] : ["Talk"];
  const building = buildings.find((b) => b.id === (agent.homeBuildingId ?? agent.buildingId));
  const mailbox = detail.data?.agent.id === id ? detail.data.mailbox : undefined;
  const role = [roleOf(agent) || agent.kind, building?.name].filter(Boolean).join(" · ");
  const perms = detail.data?.agent.id === id ? detail.data.permissions : undefined;
  return (
    <PanelShell
      key={id}
      icon={<img className="portrait" src={portraitUrl(agent.sprite)} alt="" />}
      title={<>{agent.name} {building?.managerAgentId === agent.id ? <Pill tone="warn" title={`Set as ${building.name}'s manager in its settings: facilitates its meetings`}>★ manager</Pill> : null} <StatusPill status={agent.status} /></>}
      subtitle={<>
        {agent.kind === "visitor" ? <>{role}<Presence agent={agent} mailbox={mailbox} /></> : role}
        {perms ? <AgentPermissions agent={agent} view={perms} effective={detail.data?.effectivePermissions ?? []} reload={detail.reload} /> : null}
        {perms?.canSetModel ? <AgentModel agent={agent} buildingModel={building?.model} reload={detail.reload} /> : null}
      </>}
      tabs={tabs}
      initialTab={tab && tabs.includes(tab) ? tab : "Talk"}
    >
      {(t) => (
        <>
          {t === "Talk" ? <TalkTab agent={agent} /> : null}
          {t === "Assignments" ? <AssignmentsTab agent={agent} /> : null}
          {t === "Memory" ? <MemoryTab agent={agent} topics={detail.data?.agent.id === id ? detail.data.memoryTopics ?? [] : []} memory={detail.data?.agent.id === id ? detail.data.memory : undefined} loading={!detail.data} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/**
 * v1.5 permissions line: visitors show whether they inherit their owner's permissions (always capped by the owner).
 * The owner or an admin also gets a compact editor: the inherit toggle and a checklist of what the agent can do now
 * (unchecking denies it; the choices come from what the owner holds).
 */
function AgentPermissions({ agent, view, effective, reload }: { agent: Agent; view: AgentPermissionsView; effective: Permission[]; reload: () => void }) {
  const editable = view.canEdit && !!view.ownerUserId && agent.kind !== "human" && agent.status !== "retired";
  if (agent.kind !== "visitor" && !editable) return null;
  const owner = view.ownerName ?? "its owner";
  const line = view.inheritsOwner ? `inherits ${owner}'s permissions` : "own roles only";
  const save = async (patch: { inheritsOwner?: boolean; deniedPermissions?: Permission[] }) => {
    await api().setAgentPermissions(agent.id, patch);
    reload();
  };
  const denied = new Set(view.deniedPermissions);
  const granted = new Set(effective); // `effective` already leaves the denied ones out
  const choices = [...new Set([...(view.ownerPermissions ?? []), ...view.deniedPermissions, ...effective])];
  return (
    <div className="agent-perms" title={effective.length ? `Can: ${effective.join(", ")}` : "No permissions"}>
      <span>{line}{denied.size ? ` · ${denied.size} denied` : ""} · {effective.length} permission{effective.length === 1 ? "" : "s"}</span>
      {editable ? (
        <details>
          <summary>Permissions</summary>
          <label className="perm-row">
            <input type="checkbox" checked={view.inheritsOwner}
              onChange={(e) => { save({ inheritsOwner: e.target.checked }).catch((err) => store.toast((err as Error).message, "bad")); }} />
            Inherit {owner}'s permissions (never more than {owner} has)
          </label>
          {choices.length ? <div className="perm-denies">
            <div className="muted">Can do (uncheck to deny; a denied one can be re-allowed):</div>
            {choices.map((p) => {
              const can = granted.has(p);
              // neither granted nor denied: the agent's roles don't give it (e.g. "own roles only"), so there is nothing to toggle
              const idle = !can && !denied.has(p);
              return (
                <label key={p} className={`perm-row${idle ? " muted" : ""}`} title={idle ? "Not granted by this agent's roles" : denied.has(p) ? "Denied here" : undefined}>
                  <input type="checkbox" checked={can} disabled={idle}
                    onChange={(e) => {
                      const next = e.target.checked ? [...denied].filter((d) => d !== p) : [...denied, p];
                      save({ deniedPermissions: next }).catch((err) => store.toast((err as Error).message, "bad"));
                    }} />
                  <code>{p}</code>{denied.has(p) ? " (denied)" : ""}
                </label>
              );
            })}
          </div> : null}
        </details>
      ) : null}
    </div>
  );
}

const MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** Model picker under the permissions (owner, admin or a manager of its home building). Empty = the building's model; applies from its next session. */
function AgentModel({ agent, buildingModel, reload }: { agent: Agent; buildingModel?: string; reload: () => void }) {
  const current = agent.model ?? "";
  const options = current && !MODELS.includes(current) ? [...MODELS, current] : MODELS;
  const save = async (model: string) => {
    const { agent: updated } = await api().setAgentModel(agent.id, model || null);
    store.receive({ type: "agent", agent: updated });
    store.toast(`${agent.name} will use ${updated.model ?? `the building's model${buildingModel ? ` (${buildingModel})` : ""}`} from their next session`, "ok");
    reload();
  };
  return (
    <label className="agent-model" title="Takes effect from the agent's next session">
      Model
      <select value={current} onChange={(e) => { save(e.target.value).catch((err) => store.toast((err as Error).message, "bad")); }}>
        <option value="">Building default{buildingModel ? ` (${buildingModel})` : ""}</option>
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}

/** "since 14:02", or "since Oct 18, 14:02" when it wasn't today. */
function since(iso: string | null): string {
  if (!iso) return "a while";
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return today ? clock(iso) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(iso)}`;
}

/** v1.4 visitor presence line under the panel title: offline since …, plus what's waiting in the mailbox. */
function Presence({ agent, mailbox }: { agent: Agent; mailbox?: { unread: number; mentions: number; offered: number } }) {
  const offline = agent.status === "offline";
  const counts = mailbox ? [
    `${mailbox.unread} unread message${mailbox.unread === 1 ? "" : "s"}${mailbox.mentions ? ` (${mailbox.mentions} mention${mailbox.mentions === 1 ? "" : "s"})` : ""}`,
    `${mailbox.offered} offered assignment${mailbox.offered === 1 ? "" : "s"}`,
  ] : [];
  return (
    <div className="offline-since" title={agent.lastSeenAt ? `last call ${agent.lastSeenAt}` : "no call yet"}>
      {offline ? <span><b>offline since {since(agent.lastSeenAt ?? agent.createdAt)}</b> ({timeAgo(agent.lastSeenAt ?? agent.createdAt)})</span>
        : <span>online · last call {timeAgo(agent.lastSeenAt)}</span>}
      {counts.length ? <span className="mailbox">Mailbox: {counts.join(" · ")}</span> : null}
    </div>
  );
}

/**
 * Talk: the agent's live session activity (tool calls, thoughts, status) in a muted style, like a Claude Code
 * transcript, with your messages and its `tell`s back as a chat thread where messaging is possible. Residents work
 * from assignments and don't take messages; the one exception is the building's manager agent, the building's
 * conversational surface: idle → a message starts its session; working → it interrupts now (toggle on) or waits in
 * the inbox for the next pause. A building without a manager agent keeps direct messages. "Ask" (service agents) is
 * a read-only quick question to a cheap-model proxy.
 */
function TalkTab({ agent }: { agent: Agent }) {
  const events = useTown((s) => s.events);
  const me = useTown((s) => s.me);
  const avatarId = me?.avatarAgentId ?? null;
  const isService = agent.kind === "service", isHuman = agent.kind === "human", isVisitor = agent.kind === "visitor";
  const home = useTown((s) => s.buildings.find((b) => b.id === agent.homeBuildingId));
  const manager = useTown((s) => (home?.managerAgentId ? s.agents[home.managerAgentId] : undefined));
  /** a resident other than its building's manager agent: no messages, its manager takes requests */
  const viaManager = agent.kind === "resident" && !!manager && manager.id !== agent.id && manager.status !== "retired" && manager.status !== "banned";
  const isManager = agent.kind === "resident" && manager?.id === agent.id;
  const talkable = (agent.kind === "resident" || isVisitor) && !viaManager && agent.status !== "retired" && agent.status !== "banned" && !!me;
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
      {isVisitor ? (
        <KV items={[
          ["Runs", "outside the town (its owner's Claude Code session), through the agent API"],
          ["Last call", agent.lastSeenAt ? `${timeAgo(agent.lastSeenAt)} · ${clock(agent.lastSeenAt)}` : "never"],
        ]} />
      ) : !isHuman && !isService ? (
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
      <Timeline items={timeline} agentName={agent.name} empty={isService ? `Ask ${agent.name} where to find something in the library.` : isVisitor && talkable ? `No messages yet. What you send waits in ${agent.name}'s inbox until their session reads it.` : talkable ? `Say something to ${agent.name}. They reply here.` : `${agent.name} hasn't done anything yet.`} />
      {viaManager && manager ? (
        <div className="callout via-manager">
          <span>{agent.name} works from assignments and doesn't take messages. The Memory tab says what they know.</span>
          {canOneOnOne(home?.id) ? <Act small tone="primary" run={() => openOneOnOne(home!.id)}>Talk to ★ {manager.name}</Act>
            : <button type="button" className="btn sm primary" onClick={() => store.open({ kind: "agent", id: manager.id, tab: "Talk" })}>Talk to ★ {manager.name}</button>}
          {working && canControl ? <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act> : null}
        </div>
      ) : isHuman ? null : !me ? <SignInNote to={`talk to ${agent.name}`} /> : isManager && canOneOnOne(home?.id) ? (
        <div className="callout via-manager">
          <span>{agent.name} is {home!.name}'s manager. Talk in a 1:1: they answer as you go and can assign the work you agree on.</span>
          <Act small tone="primary" run={() => openOneOnOne(home!.id)}>Talk to ★ {agent.name}</Act>
        </div>
      ) : <Composer agent={agent} talkable={talkable} canControl={canControl} outOfBudget={agent.status === "out-of-budget" || (daily > 0 && agent.spentTokensToday >= daily)} log={log} setLog={setLog} />}
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
        if (it.kind === "tell") return <div key={it.key} className={`msg ${it.mine ? "me" : "them"}`}><Markdown text={it.text} className="bubble" breaks /><small>{it.mine ? "you" : agentName} · {clock(it.ts)}</small></div>;
        if (it.kind === "ask") return <div key={`a${i}`} className={`msg ask ${it.msg.role === "user" ? "me" : "them"}`}><Markdown text={it.msg.text} className="bubble" breaks /><small>{it.msg.role === "user" ? "quick question" : "desk assistant (read-only)"} · {clock(it.ts)}</small></div>;
        const e = it.ev, p = (e.payload ?? {}) as { interrupt?: boolean; now?: boolean; text?: string; sessionId?: string | null };
        if (p.interrupt) {
          const note = p.now ? "interrupted the current turn" : p.sessionId === null ? "waiting for the next session" : "queued for the next turn";
          return <div key={e.id} className="ev status"><time title={e.ts}>{clock(e.ts)}</time><span>Message delivered: {note}</span></div>;
        }
        return (
          <div key={e.id} className={`ev ${EVENT_TONE[e.type] ?? ""}`}>
            <time title={e.ts}>{clock(e.ts)}</time>
            <span><DocText text={e.text} /></span>
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
      if (r.mode === "queued" && agent.kind === "visitor") store.toast(agent.status === "offline" ? `${agent.name} is offline: it waits in their mailbox` : `In ${agent.name}'s inbox: they'll see it on their next look`, "ok");
      else if (r.mode === "queued") store.toast(outOfBudget ? `${agent.name} is out of budget: they'll read it when budget returns` : `${agent.name} will see it at their next pause`, "ok");
    } catch (e) { store.toast((e as Error).message || "Request failed", "bad"); }
    finally { setBusy(false); }
  };
  const visitor = agent.kind === "visitor";
  // residents aren't a conversational surface (the server refuses the proxy for them); the quick question is for service agents and visitors
  const canAsk = talkable && agent.kind !== "resident";
  const status = asking ? `Quick question: ${agent.kind === "service" ? agent.name : `${agent.name}'s desk assistant`} answers from their activity and reports. It can't act.`
    : visitor ? (agent.status === "offline" ? "offline: your message waits in their mailbox" : "Online: your message lands in their inbox; they see it on their next look.")
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
        {canAsk ? (
          <button type="button" className="link talk-ask" onClick={() => setAsking((a) => !a)}>
            {asking ? `Back to messaging ${agent.name}` : "Ask (quick question, read-only)"}
          </button>
        ) : null}
        <span className="grow" />
        {talkable && !asking && !visitor ? (
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

/**
 * Memory: what the resident knows (its wiki, one private page per topic, rewritten before each report) and what it did
 * (its log, one dated line per session or decision). Everyone sees the page titles; owners, the building's managers and
 * admins see the pages and the log. This is the whole of a resident's memory between sessions.
 */
function MemoryTab({ agent, topics, memory, loading }: { agent: Agent; topics: string[]; memory?: { wiki: Doc[]; log: Doc | null }; loading: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const logLines = (memory?.log?.body ?? "").split("\n").filter((l) => l.trim()).reverse();
  return (
    <>
      <p className="direction">
        {agent.name} starts every session from these pages and the tail of this log, plus the board and their recent reports. Nothing else carries over.
      </p>
      <Section title={`Knows${topics.length ? ` (${topics.length})` : ""}`}>
        {loading ? <Empty>Loading…</Empty> : !topics.length ? <Empty>No wiki pages yet. {agent.name} writes one per topic as they work.</Empty> : memory ? (
          <div className="wiki">
            {memory.wiki.map((p) => (
              <div key={p.id} className={`wiki-page ${open === p.id ? "open" : ""}`}>
                <button type="button" className="wiki-title" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <span>{p.title}</span><small>updated {timeAgo(p.updatedAt)}</small>
                </button>
                {open === p.id ? <Markdown text={p.body} /> : null}
              </div>
            ))}
          </div>
        ) : (
          <>
            <ul className="topics">{topics.map((t) => <li key={t}>{t}</li>)}</ul>
            <div className="asg-meta">The pages themselves are visible to {agent.name}'s building managers and admins.</div>
          </>
        )}
      </Section>
      {memory ? (
        <Section title="Log">
          {!logLines.length ? <Empty>Nothing logged yet. Each work session adds a line.</Empty> : (
            <ul className="log">{logLines.map((l, i) => <li key={i}><Markdown text={l.replace(/^- /, "")} /></li>)}</ul>
          )}
        </Section>
      ) : null}
    </>
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
  // v1.4: a visitor's assignments are offers it accepts from its own session; nothing here starts them
  const visitor = agent.kind === "visitor";
  const offline = agent.status === "offline";
  const gone = agent.status === "retired" || agent.status === "banned";
  const put = (r: { assignment?: Assignment; assignments?: Assignment[]; agent?: Agent }) => {
    store.putAssignments([...(r.assignments ?? []), ...(r.assignment ? [r.assignment] : [])]);
  };
  /** the queued assignment whose Delegate picker is open */
  const [delegating, setDelegating] = useState<string | null>(null);
  // every session slot on the host is taken: the next assignment waits for one (Planning → System has the cap)
  const noSlot = useTown((s) => slotsFull(s.events, s.health));
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
          <AssignmentRow key={a.id} a={a} offline={visitor && offline} actions={canControl && agent.status === "working" && !visitor ? (
            <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act>
          ) : null} />
        ))}
      </Section>
      <Section title={`${visitor ? "Offered" : "Queue"}${queue.length ? ` (${queue.length})` : ""}`}>
        {!queue.length ? <Empty>{visitor ? `No offers. ${agent.name} accepts assignments from their own session; unaccepted offers are cancelled after 24 h.` : `No queued assignments. A message to ${agent.name} starts one.`}</Empty> : queue.map((a, i) => (
          <AssignmentRow key={a.id} a={a} index={visitor ? undefined : i + 1} slotWait={!visitor && i === 0 && agent.status === "idle" && noSlot} actions={canControl && !gone && visitor ? (
            <Act small tone="bad" run={async () => { put(await api().cancelAssignment(a.id)); }}>Withdraw</Act>
          ) : canControl && !gone ? (
            <>
              <button type="button" className="btn sm icon" title="Move up" disabled={i === 0} onClick={() => void move(i, -1).catch((e: Error) => store.toast(e.message, "bad"))}>▲</button>
              <button type="button" className="btn sm icon" title="Move down" disabled={i === queue.length - 1} onClick={() => void move(i, 1).catch((e: Error) => store.toast(e.message, "bad"))}>▼</button>
              <Act small tone="primary" title={stopped ? `Resume ${agent.name} with this` : "Run this one next"} run={async () => {
                const r = await api().startNext(a.id); put(r);
                store.toast(r.when === "now" ? `${agent.name} is starting "${a.title}"` : `"${a.title}" runs after the current session`, "ok");
              }}>Start next</Act>
              <button type="button" className={`btn sm ${delegating === a.id ? "primary" : ""}`} title="Hand this to another resident instead of waiting" onClick={() => setDelegating(delegating === a.id ? null : a.id)}>Delegate</button>
              <Act small tone="bad" run={async () => { put(await api().cancelAssignment(a.id)); }}>Cancel</Act>
            </>
          ) : null} footer={delegating === a.id ? (
            <DelegatePicker from={agent} onDone={(r) => { setDelegating(null); put({ assignments: [r.from, r.assignment], agent: r.agent }); store.toast(`"${a.title}" is now ${r.agent.name}'s, at the front of their queue`, "ok"); }} run={(toId) => api().delegateAssignment(a.id, toId, true)} />
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

/** What a waiting assignment waits on, short (the server's `describeWait` has names; this is enough for a pill). */
function waitLabel(w: NonNullable<Assignment["waitFor"]>): string {
  if ("deploy" in w) return w.deploy === "next" ? "next redeploy" : `redeploy with ${w.deploy.slice(0, 7)}`;
  if ("assignment" in w) return `assignment ${w.assignment} to finish`;
  if ("decision" in w) return `decision on ${w.decision}`;
  return `until ${new Date(w.after).toLocaleString()}`;
}

/** Delegate: pick another resident (same building first) and hand them the queued assignment. */
function DelegatePicker({ from, run, onDone }: { from: Agent; run: (toId: string) => Promise<{ assignment: Assignment; agent: Agent; from: Assignment }>; onDone: (r: { assignment: Assignment; agent: Agent; from: Assignment }) => void }) {
  const agents = useTown((s) => s.agents);
  const buildings = useTown((s) => s.buildings);
  const bname = (id: string | null) => buildings.find((b) => b.id === id)?.name ?? "";
  const options = useMemo(() => Object.values(agents)
    .filter((x) => x.id !== from.id && x.kind === "resident" && x.status !== "retired" && x.status !== "banned")
    .sort((x, y) => Number(y.homeBuildingId === from.homeBuildingId) - Number(x.homeBuildingId === from.homeBuildingId) || bname(x.homeBuildingId).localeCompare(bname(y.homeBuildingId)) || x.name.localeCompare(y.name)), [agents, buildings, from.id, from.homeBuildingId]);
  const [to, setTo] = useState(options[0]?.id ?? "");
  if (!options.length) return <div className="asg-delegate"><Empty>No other resident to hand this to.</Empty></div>;
  return (
    <div className="asg-delegate">
      <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Delegate to">
        {options.map((x) => <option key={x.id} value={x.id}>{x.name}{x.homeBuildingId !== from.homeBuildingId ? ` · ${bname(x.homeBuildingId)}` : ""}{x.status === "working" ? " (working)" : x.status === "stopped" ? " (stopped)" : ""}</option>)}
      </select>
      <Act small tone="primary" disabled={!to} title="Cancel it here and queue it first for them" run={async () => onDone(await run(to))}>Hand over</Act>
    </div>
  );
}

function AssignmentRow({ a, actions, index, offline, footer, slotWait }: { a: Assignment; actions?: ReactNode; index?: number; offline?: boolean; footer?: ReactNode; slotWait?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = a.description.length > 160;
  return (
    <div className={`asg ${a.status}`}>
      <div className="asg-head">
        <b>{index ? <span className="asg-n">{index}.</span> : null}{a.title}</b>
        {a.offered && a.status === "pending" ? <Pill tone="offered" title="Offered to a visitor: it starts when they accept it">offered</Pill>
          : a.waitFor && a.status === "pending" ? <Pill tone="offered" title={`Starts by itself once this happens (cancelled into the in-tray if not within 24 h). Start next overrides it.${a.parked ? " Parked by the agent's own report." : ""}`}>{a.parked ? "parked" : "waiting"}: {waitLabel(a.waitFor)}</Pill>
          : slotWait && a.status === "pending" ? <Pill tone="warn" title="Every session slot on the host is taken (Planning → System sets the cap). It starts when one frees up.">waiting for a slot</Pill>
          : <Pill tone={a.status === "active" ? (offline ? "" : "ok") : a.status === "pending" ? "warn" : a.status === "cancelled" ? "bad" : ""}>{a.status === "pending" ? "queued" : a.status === "active" && offline ? "active, visitor offline" : a.status}</Pill>}
      </div>
      {a.description ? <div className="asg-desc" onClick={() => long && setOpen((o) => !o)}><DocText text={long && !open ? a.description.slice(0, 157) + "…" : a.description} /></div> : null}
      <div className="asg-meta">
        {a.fromAssignmentId ? "retried or delegated · " : a.fromMeetingId ? "from a meeting · " : a.fromReportId ? "from a report · " : ""}
        {a.status === "done" || a.status === "cancelled" ? `${a.status} ${timeAgo(a.updatedAt)}` : `created ${timeAgo(a.createdAt)}`}
        {a.reportId ? <> · <button type="button" className="link" onClick={() => store.open({ kind: "library", docId: a.reportId! })}>report</button></> : null}
      </div>
      {actions ? <div className="asg-actions">{actions}</div> : null}
      {footer}
    </div>
  );
}
