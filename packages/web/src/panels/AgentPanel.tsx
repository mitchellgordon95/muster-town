/**
 * Agent panel: status, model, budget; tabs Talk (live activity and tells; a building's manager agent is talked to in a
 * 1:1) | Assignments | Memory (the resident's wiki pages and log: what it knows and did).
 * Reports live in the in-tray and library.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent, Assignment, BlockedBy, Doc, Event, Permission } from "@muster-town/schema";
import { api, type AgentPermissionsView, type ForkSummary, type ThreadMessage } from "../api";
import { forkTip } from "../forks";
import { store, useTown, roleOf } from "../state";
import { PanelShell } from "./PanelShell";
import { DocText, Markdown } from "./Markdown";
import { ADJ, Act, Empty, ErrorLine, KV, Loading, Pill, Section, ShowMore, StatusPill, breakdownTitle, clock, fmtTokens, nameOf, timeAgo, usd, useLoad } from "./ui";
import { portraitUrl } from "../map/sprites";
import { SignInNote } from "../auth/auth";
import { slotsFull } from "../redeploy";
import { canOneOnOne, openOneOnOne, openPlanner } from "./oneOnOne";
import { fmtPerf, runsAtLabel } from "../format";


export function AgentPanel({ id, tab }: { id: string; tab?: string }) {
  const live = useTown((s) => s.agents[id]);
  const rev = useTown((s) => s.rev);
  const buildings = useTown((s) => s.buildings);
  const detail = useLoad(() => api().agent(id), [id]);
  useEffect(() => { if (detail.data) { store.mergeEvents(detail.data.recentEvents); store.putAssignments(detail.data.assignments); if (detail.data.latestReport) store.putDocs([detail.data.latestReport]); } }, [detail.data]);
  useEffect(() => { detail.reload(); }, [rev, detail.reload]); // docs/assignments changed somewhere
  // a retired fork isn't in the snapshot: its panel comes from GET /api/agents/:id
  const agent = live ?? (detail.data?.agent.id === id && detail.data.agent.forkOf ? detail.data.agent : undefined);
  if (!agent) return <PanelShell title="Unknown agent">{detail.loading ? <Loading /> : <Empty>This agent isn't in the town.</Empty>}</PanelShell>;
  const building = buildings.find((b) => b.id === (agent.homeBuildingId ?? agent.buildingId));
  const fork = detail.data?.agent.id === id ? detail.data.fork : undefined;
  // a fork has no private memory (it writes topic pages); a building's manager gets its Forks tab
  const tabs = agent.forkOf ? ["Fork", "Talk", "Assignments"]
    : agent.kind === "resident" ? ["Talk", "Assignments", "Memory", ...(building?.managerAgentId === agent.id && building.kind !== "town-hall" ? ["Forks"] : [])]
    : agent.kind === "visitor" ? ["Talk", "Assignments"] : ["Talk"];
  const mailbox = detail.data?.agent.id === id ? detail.data.mailbox : undefined;
  const role = [roleOf(agent) || agent.kind, building?.name].filter(Boolean).join(" · ");
  const perms = detail.data?.agent.id === id ? detail.data.permissions : undefined;
  return (
    <PanelShell
      key={id}
      icon={<img className="portrait" src={portraitUrl(agent.sprite)} alt="" />}
      title={<>{agent.name} {building?.managerAgentId === agent.id ? <Pill tone="warn" title={`Set as ${building.name}'s manager in its settings: facilitates its meetings`}>★ manager</Pill> : null} <StatusPill status={agent.status} /></>}
      subtitle={<>
        {agent.kind === "visitor" ? <>{role}<Presence agent={agent} mailbox={mailbox} /></> : agent.forkOf ? <span title={forkTip(agent, nameOf, fork?.assignmentId, fork?.sessionId)}>fork of {nameOf(agent.forkOf)}{building ? ` · ${building.name}` : ""}</span> : role}
        {perms ? <AgentPermissions agent={agent} view={perms} effective={detail.data?.effectivePermissions ?? []} reload={detail.reload} /> : null}
        {perms?.canSetModel ? <AgentModel agent={agent} buildingModel={building?.model} reload={detail.reload} /> : null}
      </>}
      tabs={tabs}
      initialTab={tab && tabs.includes(tab) ? tab : tabs[0]}
    >
      {(t) => (
        <>
          {t === "Fork" ? <ForkTab fork={fork} loading={!detail.data} /> : null}
          {t === "Forks" ? <ForksTab managerId={agent.id} /> : null}
          {t === "Talk" ? <TalkTab agent={agent} /> : null}
          {t === "Assignments" ? <AssignmentsTab agent={agent} /> : null}
          {t === "Memory" ? <MemoryTab agent={agent} topics={detail.data?.agent.id === id ? detail.data.memoryTopics ?? [] : []} memory={detail.data?.agent.id === id ? detail.data.memory : undefined} loading={!detail.data} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/** The transcript link for a session (GET /api/sessions/:id/transcript; admins, the building's managers and the agent). */
function TranscriptLink({ sessionId }: { sessionId: string }) {
  const url = `/api/sessions/${sessionId}/transcript`;
  return <a href={url} onClick={(e) => { e.preventDefault(); void api().openTranscript?.(url).catch((err: Error) => store.toast(err.message, "bad")); }}>transcript</a>;
}

/** A fork's own panel (dc_mymt27yz25 §6): which manager, its assignment and chain hop, its session, report and the topic pages it edited. */
function ForkTab({ fork, loading }: { fork?: ForkSummary; loading: boolean }) {
  if (!fork) return loading ? <Loading /> : <Empty>No fork details.</Empty>;
  const openDoc = (docId: string) => store.open({ kind: "library", docId });
  return (
    <Section title="Fork">
      <KV items={[
        ["Fork of", <button className="link" onClick={() => store.open({ kind: "agent", id: fork.agent.forkOf! })}>{fork.forkOfName}</button>],
        ["Assignment", fork.assignmentId ? <>{fork.assignmentTitle} <span className="muted">({fork.assignmentId})</span></> : "none"],
        ...(fork.chainId ? [["Chain", <Pill tone="neutral">chain {fork.chainId} · hop {fork.hop}</Pill>] as [string, ReactNode]] : []),
        ["Session", fork.sessionId ? <>{fork.sessionId} · {fork.tokens || fork.agent.status === "retired" ? <>{fmtTokens(fork.tokens)} {ADJ}</> : "running (tokens book when it ends)"}{fmtPerf(fork) ? <> · {fmtPerf(fork)}</> : null}{fork.transcript ? <> · <TranscriptLink sessionId={fork.sessionId} /></> : null}</> : "not started"],
        ["Report", fork.reportId ? <button className="link" onClick={() => openDoc(fork.reportId!)}>{fork.reportTitle ?? fork.reportId}</button> : fork.agent.status === "retired" ? "none" : "not yet"],
        ...(fork.pagesEdited.length ? [["Topic pages", <>{fork.pagesEdited.map((p, i) => <span key={p.id}>{i ? ", " : ""}<button className="link" onClick={() => openDoc(p.id)}>{p.title}</button></span>)}</>] as [string, ReactNode]] : []),
        ["Status", fork.agent.status === "retired" ? `retired ${timeAgo(fork.agent.lastActiveAt ?? fork.agent.createdAt)}` : <StatusPill status={fork.agent.status} />],
      ]} />
    </Section>
  );
}

/** The manager's Forks tab: its live ghosts, then the last 50 retired forks (GET /api/agents/:id/forks). */
function ForksTab({ managerId }: { managerId: string }) {
  const rev = useTown((s) => s.rev);
  const list = useLoad(() => api().forks(managerId), [managerId, rev]);
  if (list.loading && !list.data) return <Loading />;
  const row = (f: ForkSummary) => (
    <button key={f.agent.id} className="doc-row" title={forkTip(f.agent, nameOf, f.assignmentId, f.sessionId)} onClick={() => store.open({ kind: "agent", id: f.agent.id })}>
      <div className="intray-who"><b>{f.agent.name}</b>{f.agent.status === "retired" ? <span>retired {timeAgo(f.agent.lastActiveAt ?? f.agent.createdAt)}</span> : <StatusPill status={f.agent.status} />}</div>
      <div className="doc-row-title">{f.assignmentTitle ?? "no assignment"}</div>
      <div className="doc-row-meta">
        {f.chainId ? <Pill tone="neutral">chain {f.chainId} · hop {f.hop}</Pill> : null}
        {f.sessionId ? <span>{f.tokens || f.agent.status === "retired" ? <>{fmtTokens(f.tokens)} {ADJ}</> : "running"}</span> : null}
        {f.sessionId && fmtPerf(f) ? <span>{fmtPerf(f)}</span> : null}
        {f.reportTitle ? <span>report: {f.reportTitle}</span> : null}
      </div>
    </button>
  );
  const live = list.data?.live ?? [], retired = list.data?.retired ?? [], family = list.data?.family;
  return (
    <>
      <ErrorLine error={list.error} />
      {family ? <KV items={[["With forks", <>today {fmtTokens(family.today)} (forks {fmtTokens(family.forksToday)}) · total {fmtTokens(family.total)} {ADJ} · {usd(family.usdTotal)} ({family.forks} fork{family.forks === 1 ? "" : "s"})</>]]} /> : null}
      <Section title={<>Live <Pill>{live.length}</Pill></>}>{live.length ? <div className="doc-list">{live.map(row)}</div> : <Empty>No fork is working now.</Empty>}</Section>
      <Section title={<>Retired <Pill>{retired.length}</Pill></>}>{retired.length ? <div className="doc-list">{retired.map(row)}</div> : <Empty>No fork has finished yet. With forks on, the building's queued work runs on forks of its manager.</Empty>}{list.data?.notStarted ? <div className="muted">{list.data.notStarted} more retired before a session started (desk failed at startup; nothing spent), not listed.</div> : null}</Section>
    </>
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
 * transcript, with the `tell`s between it and you as a chat thread. Humans talk to a building's manager agent in a 1:1
 * (the Town Hall's is the Planner, its "Plan with an agent" 1:1); other residents work from assignments.
 */
function TalkTab({ agent }: { agent: Agent }) {
  const events = useTown((s) => s.events);
  const me = useTown((s) => s.me);
  const avatarId = me?.avatarAgentId ?? null;
  const isService = agent.kind === "service", isHuman = agent.kind === "human", isVisitor = agent.kind === "visitor";
  const home = useTown((s) => s.buildings.find((b) => b.id === agent.homeBuildingId));
  const manager = useTown((s) => (home?.managerAgentId ? s.agents[home.managerAgentId] : undefined));
  /** a resident other than its building's manager agent: its manager takes requests */
  const viaManager = agent.kind === "resident" && !!manager && manager.id !== agent.id && manager.status !== "retired" && manager.status !== "banned";
  const isManager = agent.kind === "resident" && manager?.id === agent.id;
  // the Town Hall's manager is the Planner: its 1:1 is "Plan with an agent" (an admin, or a goal's owner)
  const townHall = home?.kind === "town-hall";
  const canTalk = townHall ? store.can("goals.edit") || canOneOnOne(home?.id) : canOneOnOne(home?.id);
  /** the tells between the agent and my avatar (an agent may `tell` me; nothing here sends one) */
  const threaded = (agent.kind === "resident" || isVisitor) && !!me;
  const working = agent.status === "working";
  const s = useLoad(() => (isHuman || isService ? Promise.resolve(null) : api().session(agent.id)), [agent.id, working]);
  const th = useLoad(() => (threaded ? api().thread(agent.id) : Promise.resolve([] as ThreadMessage[])), [agent.id, threaded]);
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
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [th.data, s.data, events, agent.id, avatarId]);
  const building = store.state.buildings.find((b) => b.id === agent.homeBuildingId);
  const sess = s.data?.session;
  // a manager's spend with its forks (design note §7): the Bank books each fork on its own row, this sums them
  const family = useLoad(() => isManager ? api().forks(agent.id).then((f) => f.family ?? null) : Promise.resolve(null), [agent.id, isManager, agent.spentTokensTotal]);
  const fam = family.data && family.data.forks > 0 ? family.data : null;
  // a fork's own row is booked only when its session ends: show the manager's family count too
  const root = useTown((st) => (agent.forkOf ? st.agents[agent.forkOf] : undefined));
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
          agent.forkOf ? ["Today", <span title={`${root?.name ?? "The manager"} and its forks, today. A fork's spend is booked when its session ends.`}>
            family {fmtTokens(root?.familySpentToday ?? 0)} · this fork {agent.status === "retired" || agent.spentTokensToday ? fmtTokens(agent.spentTokensToday) : "books at session end"}
          </span>]
          : ["Today", fmtTokens(agent.spentTokensToday)],
          ["Total", `${fmtTokens(agent.spentTokensTotal)} ${ADJ} · ${usd(agent.spentUsdTotal)}`],
          ...(fam ? [["With forks", <span title={`${agent.name} and ${fam.forks} fork${fam.forks === 1 ? "" : "s"} (live and retired); each fork keeps its own row`}>today {fmtTokens(fam.today)} (forks {fmtTokens(fam.forksToday)}) · total {fmtTokens(fam.total)} {ADJ} · {usd(fam.usdTotal)}</span>] as [string, ReactNode]] : []),
          ...(sess ? [["Session", <><Pill tone={sess.status === "running" ? "ok" : sess.status === "error" ? "bad" : ""}>{sess.status}</Pill> {sess.purpose} · started {timeAgo(sess.startedAt)} · {sess.turns} turns · <span title={breakdownTitle(sess)}>{fmtTokens(sess.adjustedOutputTokens ?? 0)} {ADJ}</span> · {usd(sess.costUsd)}{s.data?.transcriptFile ? <> · <a href={s.data.transcriptFile.url} title={`${s.data.transcriptFile.lines} lines · kept until ${s.data.transcriptFile.expiresAt.slice(0, 10)}`} onClick={(e) => { e.preventDefault(); void api().openTranscript?.(s.data!.transcriptFile!.url).catch((err: Error) => store.toast(err.message, "bad")); }}>transcript</a></> : null}</>] as [string, ReactNode]] : [["Last active", timeAgo(agent.lastActiveAt)] as [string, ReactNode]]),
        ]} />
      ) : null}
      {agent.activity ? <div className="now"><span className="dot" /> {agent.activity}</div> : null}
      {agent.status === "stopped" && canControl ? (
        <div className="callout">{agent.name} is stopped. <Act small run={async () => { await api().resume(agent.id); store.toast(`${agent.name} is idle again`, "ok"); }}>Resume</Act> to let them take work again.</div>
      ) : null}
      <Timeline items={timeline} agentName={agent.name} empty={isService ? `${agent.name} keeps the library: browse it for what the town has written.` : `${agent.name} hasn't done anything yet.`} />
      {viaManager && manager ? (
        <div className="callout via-manager">
          <span>{agent.name} works from assignments and doesn't take messages. The Memory tab says what they know.</span>
          {canOneOnOne(home?.id) ? <Act small tone="primary" run={() => openOneOnOne(home!.id)}>Talk to ★ {manager.name}</Act>
            : <button type="button" className="btn sm primary" onClick={() => store.open({ kind: "agent", id: manager.id, tab: "Talk" })}>Talk to ★ {manager.name}</button>}
          {working && canControl ? <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act> : null}
        </div>
      ) : isHuman || isService ? null : !me ? <SignInNote to={`talk to ${agent.name}`} /> : isManager && canTalk ? (
        <div className="callout via-manager">
          <span>{agent.name} is {home!.name}'s {townHall ? "manager, the planning agent" : "manager"}. Talk in a 1:1: they answer as you go and can {townHall ? "draft the goal-tree proposals you agree on" : "assign the work you agree on"}.</span>
          <Act small tone="primary" run={() => townHall ? openPlanner() : openOneOnOne(home!.id)}>Talk to ★ {agent.name}</Act>
          {working && canControl ? <Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act> : null}
        </div>
      ) : working && canControl ? (
        <div className="actions"><Act small tone="bad" run={async () => { await api().stop(agent.id); store.toast(`${agent.name} stopped`, "ok"); }}>Stop</Act></div>
      ) : null}
    </div>
  );
}

type Item =
  | { kind: "ev"; ts: string; ev: Event }
  | { kind: "tell"; ts: string; mine: boolean; text: string; key: string };

const EVENT_TONE: Partial<Record<Event["type"], string>> = {
  "agent.tool": "tool", "agent.thought": "thought", "agent.said": "said", "agent.told": "said", "agent.status": "status",
  "doc.created": "doc", "doc.decision": "status", "session.started": "status", "session.ended": "status", "budget.exhausted": "bad",
  "meeting.utterance": "said", "meeting.phase": "status",
};

function Timeline({ items, empty, agentName }: { items: Item[]; empty: string; agentName: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // pin to the bottom of the panel's scroller (the callout sits below the last line)
    let el: HTMLElement | null = end.current?.parentElement ?? null;
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight; else end.current?.scrollIntoView({ block: "end" });
  }, [items.length]);
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div className="chat timeline talk">
      {items.map((it) => {
        if (it.kind === "tell") return <div key={it.key} className={`msg ${it.mine ? "me" : "them"}`}><Markdown text={it.text} className="bubble" breaks /><small>{it.mine ? "you" : agentName} · {clock(it.ts)}</small></div>;
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
  // every session slot on the host is taken: the next assignment waits for one (Planning → System has the cap)
  const noSlot = useTown((s) => slotsFull(s.events, s.health));
  // why each queued one can't start (GET /api/blocked, refetched as queues change)
  const blockedRows = useTown((s) => s.blocked[agent.id]);
  const why = useMemo(() => new Map((blockedRows ?? []).map((b) => [b.assignmentId, b.blockedBy])), [blockedRows]);
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
          <AssignmentRow key={a.id} a={a} blocked={why.get(a.id)} index={visitor ? undefined : i + 1} slotWait={!visitor && i === 0 && agent.status === "idle" && noSlot} actions={canControl && !gone && visitor ? (
            <Act small tone="bad" run={async () => { put(await api().cancelAssignment(a.id)); }}>Withdraw</Act>
          ) : canControl && !gone ? (
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
    </>
  );
}

/** What a waiting assignment waits on, short (the server's `describeWait` has names; this is enough for a pill). */
function waitLabel(w: NonNullable<Assignment["waitFor"]>): string {
  if ("deploy" in w) return w.deploy === "next" ? "next redeploy" : `redeploy with ${w.deploy.slice(0, 7)}`;
  if ("assignment" in w) return `assignment ${w.assignment} to finish`;
  if ("decision" in w) return `decision on ${w.decision}`;
  return `until ${runsAtLabel(w.after)}`;
}


function AssignmentRow({ a, actions, index, offline, footer, slotWait, blocked }: { a: Assignment; actions?: ReactNode; index?: number; offline?: boolean; footer?: ReactNode; slotWait?: boolean; blocked?: BlockedBy }) {
  return (
    <div className={`asg ${a.status}`}>
      <div className="asg-head">
        <b>{index ? <span className="asg-n">{index}.</span> : null}{a.title}</b>
        {a.offered && a.status === "pending" ? <Pill tone="offered" title="Offered to a visitor: it starts when they accept it">offered</Pill>
          : blocked && a.status === "pending" ? <Pill tone="bad" title={`Can't start yet: ${blocked.text}.${a.parked ? " Parked by the agent's own report." : ""}`}>{a.parked ? "parked" : "blocked"}</Pill>
          : a.waitFor && a.status === "pending" ? <Pill tone="offered" title={`Starts by itself once this happens (cancelled into the in-tray if not within 24 h). Start next overrides it.${a.parked ? " Parked by the agent's own report." : ""}`}>{a.parked ? "parked" : "waiting"}: {waitLabel(a.waitFor)}</Pill>
          : slotWait && a.status === "pending" ? <Pill tone="warn" title="Every session slot on the host is taken (Planning → System sets the cap). It starts when one frees up.">waiting for a slot</Pill>
          : <Pill tone={a.status === "active" ? (offline ? "" : "ok") : a.status === "pending" ? "warn" : a.status === "cancelled" ? "bad" : ""}>{a.status === "pending" ? "queued" : a.status === "active" && offline ? "active, visitor offline" : a.status}</Pill>}
      </div>
      {blocked && a.status === "pending" ? (
        <div className="asg-block">
          {blocked.agentId && blocked.agentId !== a.agentId ? <button type="button" className="link" title="Open who it waits on" onClick={() => store.open({ kind: "agent", id: blocked.agentId!, tab: "Assignments" })}>{blocked.text}</button>
            : blocked.kind === "decision" && blocked.targetId ? <button type="button" className="link" title="Open the report" onClick={() => store.open({ kind: "library", docId: blocked.targetId! })}>{blocked.text}</button>
            : blocked.text}
        </div>
      ) : null}
      {a.description ? <div className="asg-desc"><ShowMore text={a.description} max={160} render={(t) => <DocText text={t} />} /></div> : null}
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
