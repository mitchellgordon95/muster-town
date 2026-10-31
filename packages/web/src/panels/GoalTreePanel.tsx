/**
 * The Town Hall goal editor (docs/goals.md "The Town Hall goal editor", build step 3): the whole town goal tree, a
 * node's detail (edit, add a goal or a dated key result, move, owner, retire with move-to-sibling, mark met/missed;
 * marking one missed asks why and queues its postmortem) and the managers' open proposals (Accept, Edit and accept, Cut). Humans with `goals.edit`
 * at a node (admins anywhere, an owner in their subtree) edit it; everyone else reads the same tree. The detail has no
 * tabs (1:1 mt_n25udpflus decision 5): a goal's spend is the Bank's "Spend by goal" (Spending tab), the queue is each
 * building panel's Queue tab, and the goal event log is for agents (GET /api/goals/:id/history), not shown here.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ROOT_GOAL_ID, type FunderWeek, type GoalChangeView, type GoalTreeNode, type KeyResultStatus } from "@muster-town/schema";
import { api, type GoalProposalView } from "../api";
import { store, useTown } from "../state";
import { Glyph } from "./PanelShell";
import { FUNDED, treeScope } from "./funderFilter";
import { openDocLink } from "./Markdown";
import { openPlanner } from "./oneOnOne";
import { krStatusLabel, krTone } from "./keyResults";
import { allBuildings, archivedLine, buildingScope, canEditGoal, deskWord, findGoal, isArchived, moveTargets, nodeGlance, pastDue, pathTo, proposalVerb, retireMoves, retirePlan, subtreeDesks, subtreeIds, treeRows, visibleRows, type TreeKr } from "./goalTree";
import { Act, Empty, ErrorLine, Field, Loading, MTokensInput, Pill, Section, fmtTokens, nameOf, timeAgo, useLoad } from "./ui";
import { fromMillions, toMillions } from "../format";
import { FreeTokensLine, capText } from "./FreeTokens";

const today = () => new Date().toISOString().slice(0, 10);
const clip = (s: string, n = 70) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Reloads on every goal or key result event, so another human's edit (or an accepted proposal) shows at once. */
function useGoalRev(): number {
  return useTown((s) => { for (let i = s.events.length - 1; i >= 0; i--) { const t = s.events[i].type; if (t.startsWith("goal.") || t.startsWith("kr.")) return s.events[i].id; } return 0; });
}

function useMe(): { userId: string | null; townWide: boolean } {
  const me = useTown((s) => s.me);
  return { userId: me?.user.id ?? null, townWide: store.can("goals.edit") };
}


/**
 * The goal tree editor: a large sheet over the map (not the side panel), the tree on the left and the selected goal on
 * the right. It stays open while a link opens the side panel beside it (a grant, a building, the Planner's 1:1), so
 * Mitchell can talk to the Planner while he edits; its × (or Esc with no side panel open) closes it.
 */
export function GoalTreePanel({ goalId, onClose }: { goalId?: string; onClose: () => void }) {
  // a key result id (a kr_ link in a doc) opens the tree at its goal with that key result highlighted
  const focusKr = goalId?.startsWith("kr_") ? goalId : null;
  const rev = useGoalRev();
  const me = useMe();
  const [retired, setRetired] = useState(false);
  const [filter, setFilter] = useState("");
  const [showKrs, setShowKrs] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>(goalId ?? ROOT_GOAL_ID);
  const [bump, setBump] = useState(0);
  const tree = useLoad(() => retired ? api().goalTreeWithRetired() : api().goalTree(), [rev, retired, bump]);
  const proposals = useLoad(() => api().goalProposals("open"), [rev, bump]);
  // the funder filter (goal tree step 8): a signed-in human with a Bank input can dim what their money didn't reach
  const funder = useLoad(() => me.userId ? api().funderWeek().catch(() => null) : Promise.resolve(null), [me.userId]);
  const isFunder = !!funder.data?.streams.length;
  const reload = () => setBump((n) => n + 1);
  const root = tree.data;
  const anyEdit = me.townWide || (!!root && !!me.userId && treeRows(root, false).some((r) => r.node.ownerId === me.userId));
  const node = root ? findGoal(root, selected) ?? root : null;
  useEffect(() => {
    const at = root && focusKr ? krGoal(root, focusKr) : null;
    if (at) select(at.id);
  }, [root?.id, focusKr]);
  // Esc closes the sheet only when no side panel sits beside it (the app's own Esc closes that panel first)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key !== "Escape" || store.state.panel || (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT"))) return;
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const select = (id: string | null) => {
    const to = id ?? ROOT_GOAL_ID;
    setSelected(to);
    if (root) setCollapsed((c) => { const n = new Set(c); for (const g of pathTo(root, to).slice(0, -1)) n.delete(g.id); return n; });
  };
  const byNode = new Map<string, number>();
  if (root) for (const p of proposals.data ?? []) { const id = proposalNode(root, p).id; byNode.set(id, (byNode.get(id) ?? 0) + 1); }
  return createPortal(
    <div className="ge-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ge" role="dialog" aria-label="Goal tree">
        <header className="ge-head">
          <div className="panel-icon"><Glyph kind="goals" /></div>
          <div className="who">
            <div className="who-title">Goal tree</div>
            <div className="who-sub">{anyEdit ? "The town's goals and key results: pick one to edit it, add under it or decide its proposals" : "The town's goals and key results (read-only)"}</div>
          </div>
          {anyEdit ? <Act small tone="primary" run={() => openPlanner(node?.id)} title="Open your 1:1 with the Planner beside the tree: it drafts proposals you accept or cut here">Talk to the Planner</Act> : null}
          <button className="close" title="Close (Esc)" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <ErrorLine error={tree.error ?? proposals.error} />
        {!root || !node ? <Loading /> : (
          <div className="ge-body">
            <nav className="ge-tree" aria-label="Goals">
              <div className="ge-tools">
                <select aria-label="Building filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="">All buildings</option>
                  {isFunder ? <option value={FUNDED}>Funded by me</option> : null}
                  {allBuildings(root).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <label className="check"><input type="checkbox" checked={showKrs} onChange={(e) => setShowKrs(e.target.checked)} /> Key results</label>
                <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Retired</label>
              </div>
              <TreeList root={root} retired={retired} filter={filter} funded={funder.data} selected={node.id} collapsed={collapsed} showKrs={showKrs} proposals={byNode}
                onSelect={select} onToggle={toggle} />
            </nav>
            <main className="ge-detail">
              <GoalDetail key={node.id} root={root} node={node} me={me} focusKr={focusKr} onSelect={select} onDone={reload}
                proposals={(proposals.data ?? []).filter((p) => node.id === ROOT_GOAL_ID || subtreeIds(node).has(proposalNode(root, p).id))} />
            </main>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

type TreeProps = { root: GoalTreeNode; retired: boolean; filter: string; funded?: FunderWeek | null; selected: string; collapsed: ReadonlySet<string>; showKrs: boolean; proposals: Map<string, number>; onSelect: (id: string) => void; onToggle: (id: string) => void };

/** The tree as nodes: a chevron, the goal's words, its buildings, owner, open key results at a glance (funded, late, next due) and waiting proposals. */
function TreeList({ root, retired, filter, funded, selected, collapsed, showKrs, proposals, onSelect, onToggle }: TreeProps) {
  const scope = filter === FUNDED ? treeScope(root, funded) : filter ? buildingScope(root, filter) : null;
  const now = today();
  return (
    <ul className="ge-nodes">
      {visibleRows(root, retired, collapsed).map(({ node, depth }) => {
        const g = nodeGlance(node, now);
        const krs = showKrs ? node.keyResults.filter((k) => !isArchived(k)) : [];
        const kids = node.children.some((c) => retired || c.status !== "retired");
        const open = !collapsed.has(node.id);
        const waiting = proposals.get(node.id) ?? 0;
        const d = subtreeDesks(node);
        return (
          <li key={node.id} className={`ge-node ${node.id === selected ? "on" : ""} ${scope && !scope.has(node.id) ? "dim" : ""} ${node.status === "retired" ? "retired" : ""}`} style={{ "--depth": depth } as CSSProperties}>
            <div className="ge-node-row">
              {kids || krs.length ? <button className="ge-chev" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} onClick={() => onToggle(node.id)}>{open ? "▾" : "▸"}</button> : <span className="ge-chev" />}
              <button className="ge-node-main" onClick={() => onSelect(node.id)} title={node.text}>
                <span className={`ge-node-text ${node.id === ROOT_GOAL_ID ? "root" : ""}`}>{node.text}</span>
                <span className="ge-node-meta">
                  {node.status === "retired" ? null : <span className={`ge-tag desks ${d.desks ? "" : "none"}`} title={d.desks ? `${deskWord(d.desks)} work this goal (the headcount of every building attached here or below), ${d.inUse} in use now` : "No building is attached here or below: nobody works this goal"}>{deskWord(d.desks)}</span>}
                  {node.buildings.map((b) => <span key={b.id} className="ge-tag building" title={`${b.name} is attached here`}>{b.name}</span>)}
                  {node.ownerId ? <span className="ge-tag" title={`Captain: ${node.owner.name}`}>👤 {node.owner.name}</span> : null}
                  {node.status === "retired" ? <span className="ge-tag bad">retired</span> : null}
                  {g.open ? <span className="ge-tag" title={`${g.open} open key result${g.open === 1 ? "" : "s"}, ${g.funded} funded`}>{g.open} KR · {g.funded} funded</span> : null}
                  {g.late ? <span className="ge-tag warn" title="Open key results past their due date">{g.late} late</span> : g.nextDue ? <span className="ge-tag" title="The nearest open due date">due {g.nextDue}</span> : null}
                  {waiting ? <span className="ge-tag prop" title="Open proposals waiting for a decision here">{waiting} proposal{waiting === 1 ? "" : "s"}</span> : null}
                </span>
              </button>
            </div>
            {open && krs.length ? <ul className="ge-krs">{krs.map((k) => (
              <li key={k.id}>
                <button className="ge-kr" onClick={() => onSelect(node.id)} title={`${krStatusLabel(k.status as KeyResultStatus)}: ${k.text}`}>
                  <span className={`ge-dot st-${k.status}`} />
                  <span className="ge-kr-text">{k.text}</span>
                  {k.due ? <span className={`goal-due ${pastDue(k, now) ? "late" : ""}`}>{k.due.slice(5)}</span> : null}
                  <span className={`ge-kr-grant ${k.grantId ? "funded" : ""}`}>{k.grantId ? "funded" : "open"}</span>
                </button>
              </li>
            ))}</ul> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A goal's key results; `cards` (the editor's detail) shows each whole with its how-to-check, else one line each. */
function KrLines({ krs, actions, cards, focus }: { krs: TreeKr[]; actions?: (k: TreeKr) => ReactNode; cards?: boolean; focus?: string | null }) {
  const open = krs.filter((k) => !isArchived(k));
  const done = archivedLine(krs);
  const [showDone, setShowDone] = useState(() => krs.some((k) => k.id === focus && isArchived(k)));
  const scrolled = useRef(false);
  const line = (k: TreeKr) => (
    <li key={k.id} className={`goal-kr ${cards ? "ge-kr-card" : ""} ${k.id === focus ? "focus" : ""}`} ref={k.id === focus ? (el) => { if (el && !scrolled.current) { scrolled.current = true; el.scrollIntoView({ block: "center" }); } } : undefined}>
      <Pill tone={krTone(k.status as KeyResultStatus)}>{krStatusLabel(k.status as KeyResultStatus)}</Pill>
      {k.underReviewSince ? <Pill tone="warn" title={`A "Change this goal" put it under review on ${k.underReviewSince.slice(0, 10)}: its grant keeps running until a human decides`}>under review</Pill> : null}
      {k.due ? <span className={`goal-due ${pastDue(k, today()) ? "late" : ""}`} title={pastDue(k, today()) ? "Past due" : "Due"}>{k.due}</span> : null}
      {k.grantId ? <button className="link goal-grant" onClick={() => store.open({ kind: "grant", id: k.grantId! })}>funded</button> : !isArchived(k) ? <span className="muted goal-grant">open</span> : null}
      <span className="goal-kr-text" title={k.howToCheck && !cards ? `How to check: ${k.howToCheck}` : undefined}>{k.text}{cards && k.howToCheck ? <span className="ge-check">How to check: {k.howToCheck}</span> : null}</span>
      {k.status === "missed" ? k.postmortemDocId
        ? <button className="link goal-postmortem" onClick={() => void openDocLink(k.postmortemDocId!)} title="The postmortem: what we planned, what happened, what we'd do differently">postmortem</button>
        : <span className="muted goal-postmortem" title="A postmortem assignment is queued on the building; its report links here">postmortem pending</span> : null}
      {actions?.(k)}
    </li>
  );
  if (!open.length && !done) return null;
  return (
    <ul className="goal-krs">
      {open.map(line)}
      {done ? <li className="goal-kr muted"><button className="link" onClick={() => setShowDone(!showDone)}>{done}</button></li> : null}
      {showDone ? krs.filter(isArchived).map(line) : null}
    </ul>
  );
}

function GoalDetail({ root, node, me, proposals, focusKr, onSelect, onDone }: { root: GoalTreeNode; node: GoalTreeNode; me: { userId: string | null; townWide: boolean }; proposals: GoalProposalView[]; focusKr?: string | null; onSelect: (id: string | null) => void; onDone: () => void }) {
  const can = canEditGoal(node, me) && node.status === "active";
  const path = pathTo(root, node.id);
  const [form, setForm] = useState<"" | "edit" | "goal" | "kr" | "move" | "owner" | "retire" | "change">("");
  const rev = useGoalRev();
  const changes = useLoad(() => api().goalChanges({ goalId: node.id, open: true }), [node.id, rev]);
  const open = changes.data?.[0] ?? null;
  const done = () => { setForm(""); onDone(); };
  const mark = (k: TreeKr, status: KeyResultStatus) => api().updateKeyResult(k.id, { status }).then(onDone);
  // marking missed (or archiving an under-review one) asks for a line on why: it files the postmortem's source
  const [missing, setMissing] = useState<{ k: TreeKr; archive: boolean } | null>(null);
  const tool = (f: typeof form, label: string, title?: string, tone = "") => <button className={`btn sm ${tone} ${form === f ? "on" : ""}`} aria-pressed={form === f} title={title} onClick={() => setForm(form === f ? "" : f)}>{label}</button>;
  return (
    <div className="goal-detail">
      {path.length > 1 ? <div className="goal-path">
        {path.slice(0, -1).map((g, i) => <span key={g.id}>{i ? " › " : ""}<button className="link" onClick={() => onSelect(g.id)}>{clip(g.text, 40)}</button></span>)}
      </div> : null}
      <div className="ge-goal">
        <span>{node.id === ROOT_GOAL_ID ? "Town goal (the root)" : node.status === "retired" ? "Retired goal" : "Goal"}</span>
        <h2>{node.text}</h2>
        <div className="muted goal-meta">
          Captain: <b>{node.owner.name}</b>{node.ownerId ? "" : node.owner.goalId === node.id ? "" : ` (from "${clip(findGoal(root, node.owner.goalId)?.text ?? node.owner.goalId, 40)}")`}
          {node.buildings.length ? <> · Attached: {node.buildings.map((b) => <button key={b.id} className="chip" title={`${deskWord(b.headcount)}, ${b.inUse} in use now`} onClick={() => store.open({ kind: "building", id: b.id })}>{b.name} · {deskWord(b.headcount)}</button>)}</> : null}
        </div>
        <DeskLine node={node} />
        <FundingBlock root={root} node={node} can={can} onDone={onDone} />
      </div>
      {can ? (
        <div className="ge-toolbar" role="toolbar" aria-label="Change this goal">
          {tool("edit", "Edit words")}
          {tool("goal", "+ Goal under it")}
          {tool("kr", "+ Key result")}
          {node.parentId ? tool("move", "Move") : null}
          {tool("owner", "Captain")}
          {!open ? tool("change", "Change this goal", "X → Y: the buildings under it prepare, then a planning meeting decides what goes underneath") : null}
          <span className="ge-toolbar-gap" />
          {node.parentId ? tool("retire", "Retire", undefined, "bad") : null}
        </div>
      ) : <div className="muted goal-meta">{node.status === "retired" ? `Retired${node.retiredNote ? `: ${node.retiredNote}` : "."}` : me.userId ? "Only an admin or this goal's captain edits it; managers propose with propose_goal." : "Sign in to see what you can change."}</div>}
      {!can && me.userId && node.status === "active" && node.id !== ROOT_GOAL_ID ? <AskToCaptain node={node} userId={me.userId} /> : null}
      {open ? <ChangeBanner c={open} /> : null}
      {form === "change" ? <ChangeForm node={node} onDone={done} /> : null}
      {form === "edit" ? <EditForm node={node} onDone={done} /> : null}
      {form === "goal" ? <AddGoalForm parent={node} onDone={(id) => { done(); onSelect(id); }} /> : null}
      {form === "kr" ? <AddKrForm root={root} node={node} onDone={done} /> : null}
      {form === "move" ? <MoveForm root={root} node={node} onDone={done} /> : null}
      {form === "owner" ? <OwnerForm node={node} me={me} onDone={done} /> : null}
      {form === "retire" ? <RetireForm root={root} node={node} onDone={() => { done(); onSelect(node.parentId); }} /> : null}
      {proposals.length ? <Proposals root={root} list={proposals} me={me} onDone={onDone} here={node.id === ROOT_GOAL_ID ? null : node.text} /> : null}
      <Section title={`Key results (${node.keyResults.filter((k) => !isArchived(k)).length})`}>
        {node.keyResults.length ? <KrLines krs={node.keyResults} cards focus={focusKr} actions={can ? (k) => isArchived(k) ? null : k.underReviewSince ? <ReviewActs root={root} k={k} onDone={onDone} onArchive={() => setMissing({ k, archive: true })} /> : <span className="goal-kr-acts">
          <Act small tone="ok" run={() => mark(k, "met")} title="A human marks it met: it archives under this goal">Met</Act>
          <button className="btn sm bad" onClick={() => setMissing({ k, archive: false })} title="A human marks it missed: it archives under this goal and a postmortem is queued">Missed</button>
        </span> : undefined} /> : <Empty>No key results under this goal{can ? ": add a dated one with + Key result." : "."}</Empty>}
        {missing ? <MissedForm key={missing.k.id} k={missing.k} archive={missing.archive} onCancel={() => setMissing(null)} onDone={() => { setMissing(null); onDone(); }} /> : null}
      </Section>
    </div>
  );
}

/** An open "Change this goal": where its prep stands and when (or whether) its planning meeting is open. */
function ChangeBanner({ c }: { c: GoalChangeView }) {
  const inCount = c.prep.filter((p) => p.status !== "waiting").length;
  const when = new Date(c.meetingDeadline);
  const stamp = `${when.toISOString().slice(5, 10)} ${when.toISOString().slice(11, 16)} UTC`;
  return (
    <div className="goal-change">
      <div><Pill tone="warn">{c.status === "prep" ? "changing" : "reorg meeting"}</Pill> <s>{c.fromText}</s> → <b>{c.toText}</b></div>
      <div className="muted">Filed by {c.createdByName}. Why: {c.why}</div>
      <div className="muted">
        {c.prep.length ? <>Prep reports: {inCount} of {c.prep.length} in ({c.prep.map((p) => `${p.buildingName}: ${p.status === "in" ? "in" : p.status === "waiting" ? "working" : "no manager"}`).join(", ")}). </> : "No building is attached under it. "}
        {c.status === "prep" ? <>The meeting opens when every prep report is in, or at {stamp}.</> : <>The meeting is open: the goal reads the new words.</>}
        {" "}{c.underReview.length} key result{c.underReview.length === 1 ? "" : "s"} under review · {c.proposals.length} proposal{c.proposals.length === 1 ? "" : "s"}.
      </div>
      {c.meetingId ? <button className="link" onClick={() => store.open({ kind: "meeting", id: c.meetingId! })}>Open the planning meeting →</button> : null}
    </div>
  );
}

function ChangeForm({ node, onDone }: { node: GoalTreeNode; onDone: () => void }) {
  const [text, setText] = useState(node.text), [why, setWhy] = useState("");
  return (
    <div className="goal-form">
      <Field label="Change this goal to" hint="Every building attached under it gets a prep assignment, its open key results go under review (grants keep running), and a planning meeting opens when the prep reports are in or after 24 h."><textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Why"><textarea rows={3} maxLength={2000} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      <Act small tone="primary" disabled={!text.trim() || text.trim() === node.text || !why.trim()} run={() => api().changeGoal(node.id, { toText: text.trim(), why: why.trim() }).then(onDone)}>File the change</Act>
    </div>
  );
}

/** An under-review key result (a reorg): Keep (clears the flag), Move (to another goal), or Archive (as missed). */
function ReviewActs({ root, k, onDone, onArchive }: { root: GoalTreeNode; k: TreeKr; onDone: () => void; onArchive: () => void }) {
  const [to, setTo] = useState("");
  const targets = treeRows(root, false).map((r) => r.node).filter((g) => !g.keyResults.some((x) => x.id === k.id));
  return (
    <span className="goal-kr-acts">
      <Act small tone="ok" run={() => api().reviewKeyResult(k.id, { action: "keep" }).then(onDone)} title="It still serves the goal: clear the flag">Keep</Act>
      <select aria-label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Move to…</option>
        {targets.map((g) => <option key={g.id} value={g.id}>{clip(g.text, 50)}</option>)}
      </select>
      {to ? <Act small run={() => api().reviewKeyResult(k.id, { action: "move", goalId: to }).then(onDone)}>Move</Act> : null}
      <button className="btn sm bad" onClick={onArchive} title="Archive it as missed; its grant becomes a Cut candidate and a postmortem is queued">Archive</button>
    </span>
  );
}

/** Missed (docs/goals.md "Postmortems on missed KRs"): the why-line is filed as the human's note, which queues one postmortem on the building. */
function MissedForm({ k, archive, onCancel, onDone }: { k: TreeKr; archive: boolean; onCancel: () => void; onDone: () => void }) {
  const [why, setWhy] = useState("");
  const run = () => (archive ? api().reviewKeyResult(k.id, { action: "archive", note: why.trim() }) : api().updateKeyResult(k.id, { status: "missed", note: why.trim() })).then(onDone);
  return (
    <div className="goal-form">
      <Field label={`Why was "${clip(k.text, 60)}" missed?`} hint="One line. It is filed as your note, and it queues one small postmortem on the building that worked on it; the report links back here.">
        <textarea rows={2} maxLength={2000} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <span className="goal-kr-acts">
        <Act small tone="bad" disabled={!why.trim()} run={run}>{archive ? "Archive as missed" : "Mark missed"}</Act>
        <button className="btn sm" onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}

/**
 * Funding (docs/how-work-gets-done.md §7, §8): the free tokens under this goal with their sum, and its exploration cap
 * per day, set here or inherited from the nearest goal above that sets one (none = uncapped). The cap is a human
 * funder's with goals.edit here (an admin or the goal's captain); blank = inherit.
 */
function FundingBlock({ root, node, can, onDone }: { root: GoalTreeNode; node: GoalTreeNode; can: boolean; onDone: () => void }) {
  const [cap, setCap] = useState(node.exploreCapTokensPerDay == null ? "" : toMillions(node.exploreCapTokensPerDay));
  useEffect(() => setCap(node.exploreCapTokensPerDay == null ? "" : toMillions(node.exploreCapTokensPerDay)), [node.id, node.exploreCapTokensPerDay]);
  if (node.status === "retired") return null;
  const { exploreCap } = node.funding;
  const above = node.parentId ? findGoal(root, node.parentId)?.funding.exploreCap ?? null : null;
  const next = cap.trim() === "" ? null : Math.max(0, fromMillions(cap) || 0);
  return (
    <div className="ge-funding">
      <div className="ge-funding-row">
        <span className="ge-funding-label">Free tokens</span>
        <FreeTokensLine free={node.funding.free} />
      </div>
      <div className="ge-funding-row">
        <span className="ge-funding-label">Exploration cap</span>
        {can ? <>
          <MTokensInput value={cap} placeholder={above ? toMillions(above.tokensPerDay) : "none"} onChange={setCap} />
          <span className="muted">/ day</span>
          <Act small tone="primary" disabled={next === node.exploreCapTokensPerDay} title="Blank = inherit from the goal above (none set anywhere = uncapped)" run={() => api().updateGoal(node.id, { exploreCapTokensPerDay: next }).then(onDone)}>Save</Act>
        </> : null}
        <span className={exploreCap ? undefined : "muted"}>{can && exploreCap?.goalId === node.id ? `${fmtTokens(node.funding.exploreSpentTodayTokens)} used today` : capText(node, root)}</span>
      </div>
      <ExploreRow node={node} can={can} onDone={onDone} />
    </div>
  );
}

/**
 * The explore rule (docs/how-work-gets-done.md §3): whether the runtime's tick starts explorers under this goal and the
 * chunk each reserves, set here or inherited (the root's default: on, 100k). Same editors as the cap.
 */
function ExploreRow({ node, can, onDone }: { node: GoalTreeNode; can: boolean; onDone: () => void }) {
  const rule = node.funding.explore;
  const [chunk, setChunk] = useState(node.exploreChunkTokens == null ? "" : toMillions(node.exploreChunkTokens));
  useEffect(() => setChunk(node.exploreChunkTokens == null ? "" : toMillions(node.exploreChunkTokens)), [node.id, node.exploreChunkTokens]);
  const nextChunk = chunk.trim() === "" ? null : Math.max(10_000, Math.round((fromMillions(chunk) || 0)));
  const from = (id: string | null) => id === node.id ? "set here" : id ? "inherited" : "default";
  return (
    <div className="ge-funding-row">
      <span className="ge-funding-label">Exploration</span>
      {can ? <>
        <select value={node.explore == null ? "" : node.explore ? "on" : "off"} onChange={(e) => void api().updateGoal(node.id, { explore: e.target.value === "" ? null : e.target.value === "on" }).then(onDone)}>
          <option value="">inherit ({rule.on ? "on" : "off"})</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
        <MTokensInput value={chunk} placeholder={toMillions(rule.chunkTokens)} onChange={setChunk} />
        <span className="muted">/ explorer</span>
        <Act small tone="primary" disabled={nextChunk === node.exploreChunkTokens} title="Blank = inherit the chunk from the goal above (default 100k)" run={() => api().updateGoal(node.id, { exploreChunkTokens: nextChunk }).then(onDone)}>Save</Act>
      </> : null}
      <span className="muted">{rule.on ? `on (${from(rule.onFrom)}): idle desks start explorers of ${fmtTokens(rule.chunkTokens)} tokens (${from(rule.chunkFrom)})` : `off (${from(rule.onFrom)})`}</span>
    </div>
  );
}

/** The desks working this goal: the subtree total (the root's is the town's), with what children add when they add any. */
function DeskLine({ node }: { node: GoalTreeNode }) {
  const d = subtreeDesks(node);
  const own = node.buildings.reduce((n, b) => n + b.headcount, 0);
  if (node.status === "retired") return null;
  return (
    <div className={`ge-desks ${d.desks ? "" : "none"}`}>
      <b>{deskWord(d.desks)}</b> {d.desks ? <>{node.id === ROOT_GOAL_ID ? "in the town" : "work this goal"}{own && own < d.desks ? ` (${own} attached here, ${d.desks - own} below)` : ""} · {d.inUse} in use now</> : "· no building is attached here or below"}
    </div>
  );
}

function EditForm({ node, onDone }: { node: GoalTreeNode; onDone: () => void }) {
  const [text, setText] = useState(node.text);
  return (
    <div className="goal-form">
      <Field label="Goal"><textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Act small tone="primary" disabled={!text.trim() || text.trim() === node.text} run={() => api().updateGoal(node.id, { text: text.trim() }).then(onDone)}>Save</Act>
    </div>
  );
}

function AddGoalForm({ parent, onDone }: { parent: GoalTreeNode; onDone: (id: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="goal-form">
      <Field label={`A goal under "${clip(parent.text, 50)}"`} hint="A standing direction, never met. Key results under it are the dated, checkable claims."><textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Act small tone="primary" disabled={!text.trim()} run={() => api().createGoal({ parentId: parent.id, text: text.trim() }).then((g) => onDone(g.id))}>Add goal</Act>
    </div>
  );
}

function AddKrForm({ root, node, onDone }: { root: GoalTreeNode; node: GoalTreeNode; onDone: () => void }) {
  const [text, setText] = useState(""), [check, setCheck] = useState(""), [due, setDue] = useState("");
  // the building it is for: one attached here or above (default: the nearest, which the server also picks)
  const near = pathTo(root, node.id).reverse().flatMap((g) => g.buildings);
  const [buildingId, setBuildingId] = useState("");
  return (
    <div className="goal-form">
      <Field label="Key result" hint="A concrete thing in the live town by a date."><textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="How to check" hint="Where a human looks and what they'd see."><textarea rows={2} maxLength={300} value={check} onChange={(e) => setCheck(e.target.value)} /></Field>
      <Field label="Due"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      {near.length > 1 ? <Field label="For building"><select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
        <option value="">{near[0].name} (nearest)</option>
        {near.slice(1).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></Field> : null}
      <Act small tone="primary" disabled={!text.trim() || !check.trim() || !due}
        run={() => api().addTreeKeyResult(node.id, { text: text.trim(), howToCheck: check.trim(), due, ...(buildingId ? { buildingId } : {}) }).then(onDone)}>Add key result</Act>
    </div>
  );
}

function MoveForm({ root, node, onDone }: { root: GoalTreeNode; node: GoalTreeNode; onDone: () => void }) {
  const targets = moveTargets(root, node.id);
  const [to, setTo] = useState("");
  return (
    <div className="goal-form">
      <Field label="Move under" hint="Its key results, goals below and attached buildings move with it.">
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Pick a goal…</option>
          {targets.map(({ node: g, depth }) => <option key={g.id} value={g.id}>{`${"  ".repeat(depth)}${depth ? "› " : ""}${clip(g.text)}`}</option>)}
        </select>
      </Field>
      <Act small tone="primary" disabled={!to} run={() => api().updateGoal(node.id, { parentId: to }).then(onDone)}>Move</Act>
    </div>
  );
}

/**
 * "Ask to captain this goal" (gr_bwm0iz7rwl): a member who can't edit this goal asks to become its captain (its owner).
 * The ask waits in the Town Hall in-tray for the goal's current captain or an admin; once asked, it says so instead.
 */
function AskToCaptain({ node, userId }: { node: GoalTreeNode; userId: string }) {
  const member = useTown((s) => !!s.me?.canInteract);
  const asks = useLoad(() => api().captainRequests(node.id), [node.id]);
  const [open, setOpen] = useState(false), [note, setNote] = useState("");
  const mine = asks.data?.find((r) => r.userId === userId);
  if (!member) return <div className="muted goal-meta captain-ask">Want to captain this goal? Ask to join first (the card on the map): members can ask to captain a goal.</div>;
  if (mine) return <div className="muted goal-meta captain-ask">You asked to captain this goal {timeAgo(mine.createdAt)}. It is in the Town Hall in-tray for {mine.captainName} to accept or decline.</div>;
  const ask = async () => {
    await api().askToCaptain(node.id, note.trim() || undefined);
    store.toast(`Asked to captain "${node.text}": ${node.owner.name} ${node.owner.userId ? "decides" : "decide"} from the Town Hall in-tray.`, "ok");
    setOpen(false); setNote(""); asks.reload();
  };
  return (
    <div className="captain-ask">
      {open ? (
        <div className="goal-form">
          <Field label="Why you (optional)" hint={`The captain steers this goal: its in-tray items route to them, and they fund, counter or reject grants and write key results under it. ${node.owner.name} ${node.owner.userId ? "decides" : "decide"}.`}>
            <textarea rows={2} maxLength={280} autoFocus placeholder="One line on what you'd steer it toward" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="actions">
            <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
            <Act small tone="primary" run={ask}>Ask</Act>
          </div>
        </div>
      ) : <button className="btn sm primary" onClick={() => setOpen(true)} title="Ask the goal's current captain (or an admin) to make you its captain">Ask to captain this goal</button>}
      <ErrorLine error={asks.error} />
    </div>
  );
}

/** Captains are humans (docs/goals.md "Captains on nodes"): any user who holds a role, or me; empty = inherit from above. */
function OwnerForm({ node, me, onDone }: { node: GoalTreeNode; me: { userId: string | null }; onDone: () => void }) {
  const roles = useLoad(() => api().roles(), []);
  const ids = [...new Set([...(me.userId ? [me.userId] : []), ...(roles.data?.memberships ?? []).filter((m) => m.holderKind === "user").map((m) => m.holderId), ...(node.ownerId ? [node.ownerId] : [])])];
  const [owner, setOwner] = useState(node.ownerId ?? "");
  useEffect(() => setOwner(node.ownerId ?? ""), [node.ownerId]);
  return (
    <div className="goal-form">
      <Field label="Captain" hint="The captain edits this goal and everything under it, and decides and funds grants there.">
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{node.parentId ? "Nobody here (inherit from above)" : "The town admins"}</option>
          {ids.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select>
      </Field>
      <ErrorLine error={roles.error} />
      <Act small tone="primary" disabled={owner === (node.ownerId ?? "")} run={() => api().updateGoal(node.id, { ownerId: owner || null }).then(onDone)}>Set captain</Act>
    </div>
  );
}

function RetireForm({ root, node, onDone }: { root: GoalTreeNode; node: GoalTreeNode; onDone: () => void }) {
  const plan = retirePlan(root, node.id);
  const [to, setTo] = useState(""), [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const mustMove = plan.openKrs.length + plan.buildings.length > 0;
  const retire = () => api().retireGoal(node.id, { ...(to ? { moveTo: to } : {}), note }).then(onDone);
  const dest = plan.siblings.find((s) => s.id === to);
  if (confirm && dest) return <RetireConfirm goal={node.text} plan={plan} dest={dest.text} confirmLabel="Retire goal" onConfirm={retire} onCancel={() => setConfirm(false)} />;
  return (
    <div className="goal-form">
      {mustMove ? <>
        <div className="muted">Retiring it moves {plan.openKrs.length} open key result{plan.openKrs.length === 1 ? "" : "s"} (with their grants) and {plan.buildings.length} attached building{plan.buildings.length === 1 ? "" : "s"} to a sibling goal:</div>
        <ul className="goal-krs">
          {plan.openKrs.map((k) => <li key={k.id} className="goal-kr">{k.text}</li>)}
          {plan.buildings.map((b) => <li key={b.id} className="goal-kr"><span className="chip">{b.name}</span></li>)}
        </ul>
        <Field label="Move them to" hint={plan.siblings.length ? "Retire is refused until you pick one." : "No sibling goal: add one under the parent first, or move or close these."}>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Pick a sibling…</option>
            {plan.siblings.map((s) => <option key={s.id} value={s.id}>{clip(s.text)}</option>)}
          </select>
        </Field>
      </> : <div className="muted">Nothing open hangs here: retiring it just hides it behind "Show retired". Its archived key results stay under it.</div>}
      <Field label="Why (optional)"><input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
      {plan.buildings.length && dest ? <button className="btn sm bad" onClick={() => setConfirm(true)}>Retire goal…</button>
        : <Act small tone="bad" disabled={mustMove && !to} run={retire}>Retire goal</Act>}
    </div>
  );
}

/**
 * Asked before a retire runs when a building is attached in the goal's subtree (the Retire form and accepting a retire
 * proposal, in the editor and the review deck): names each building and open key result that moves, and says that a
 * building is never archived here (core Goals.retire refuses to orphan one and moves it instead).
 */
export function RetireConfirm({ goal, plan, dest, confirmLabel, onConfirm, onCancel }: { goal: string; plan: Pick<ReturnType<typeof retirePlan>, "openKrs" | "buildings">; dest: string; confirmLabel: string; onConfirm: () => Promise<unknown>; onCancel: () => void }) {
  const moves = retireMoves(plan, clip(dest, 80));
  return (
    <div className="goal-form retire-confirm" role="alertdialog" aria-label="Confirm retire">
      <b>Retire "{clip(goal, 80)}"?</b>
      <ul className="goal-krs">
        {moves.buildings.map((t) => <li key={t} className="goal-kr"><b>{t}</b></li>)}
        {moves.krs.map((t) => <li key={t} className="goal-kr">{t}</li>)}
      </ul>
      <div className="muted">A building is never archived here; it moves, and its work keeps running under the new goal.</div>
      <div className="goal-actions">
        <Act small tone="bad" run={onConfirm}>{confirmLabel}</Act>
        <button className="btn sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const ACTION: Record<GoalProposalView["action"], string> = { "add-goal": "New goal", "add-kr": "New key result", edit: "Edit", move: "Move", retire: "Retire", promote: "Promote to a goal" };

/** The goal a key result hangs under, or null. */
function krGoal(root: GoalTreeNode, id: string): GoalTreeNode | null {
  const walk = (n: GoalTreeNode): GoalTreeNode | null => n.keyResults.some((k) => k.id === id) ? n : n.children.map(walk).find(Boolean) ?? null;
  return walk(root);
}

/** The goal (in the tree) a proposal belongs to, as core Goals.nodeOfProposal: its target goal or key result's goal, else where it goes. */
export function proposalNode(root: GoalTreeNode, p: Pick<GoalProposalView, "targetId" | "parentId" | "action">): GoalTreeNode {
  const at = p.targetId ? findGoal(root, p.targetId) ?? krGoal(root, p.targetId) : null;
  return at ?? (p.parentId ? findGoal(root, p.parentId) : null) ?? root;
}

function Proposals({ root, list, me, here, onDone }: { root: GoalTreeNode; list: GoalProposalView[]; me: { userId: string | null; townWide: boolean }; here: string | null; onDone: () => void }) {
  return (
    <Section title={`Proposals waiting${here ? " here and below" : ""} (${list.length})`}>
      <div className="goal-proposals">{list.map((p) => <ProposalCard key={p.id} root={root} p={p} me={me} onDone={onDone} />)}</div>
    </Section>
  );
}

export function ProposalCard({ root, p, me, onDone }: { root: GoalTreeNode; p: GoalProposalView; me: { userId: string | null; townWide: boolean }; onDone: () => void }) {
  const node = proposalNode(root, p);
  const can = canEditGoal(node, me);
  const [mode, setMode] = useState<"" | "edit" | "cut" | "confirm">("");
  const [text, setText] = useState(p.fields.text ?? ""), [check, setCheck] = useState(p.fields.howToCheck ?? ""), [due, setDue] = useState(p.fields.due ?? "");
  const [note, setNote] = useState("");
  const target = p.targetId ? findGoal(root, p.targetId) : null;
  const targetKr = !target && p.targetId ? subtreeKr(root, p.targetId) : null;
  const old = target?.text ?? targetKr?.text ?? null;
  const parent = p.parentId ? findGoal(root, p.parentId) : null;
  const where = pathTo(root, node.id).map((g) => clip(g.text, 30)).join(" › ");
  const isKr = p.action === "add-kr" || !!targetKr;
  const plan = p.action === "retire" && target ? retirePlan(root, target.id) : null;
  const words = proposalVerb(p.action, parent?.text ?? null, !!plan && plan.openKrs.length + plan.buildings.length > 0);
  const accept = () => api().decideGoalProposal(p.id, { action: "accept" }).then(onDone);
  return (
    <div className={`goal-proposal ${p.outsideScope ? "outside" : ""}`}>
      <div className="goal-proposal-head"><Pill tone="warn">{ACTION[p.action]}</Pill> <b>{p.proposedByName}</b>{p.buildingId ? <span className="muted"> · {store.state.buildings.find((b) => b.id === p.buildingId)?.name ?? p.buildingId}</span> : null}{p.outsideScope ? <Pill tone="bad" title="Outside the proposing building's subtree">outside its subtree</Pill> : null}</div>
      <div className="muted goal-path">{where}</div>
      {old && p.fields.text && p.fields.text !== old ? <div className="goal-diff"><s>{old}</s> → <b>{p.fields.text}</b></div>
        : old ? <div className="goal-diff">{old}{words ? <> <span className="muted">{words.verb}</span>{words.dest ? <> <b>{words.dest}</b></> : null}</> : null}</div>
        : <div className="goal-diff"><b>{p.fields.text}</b></div>}
      {p.fields.howToCheck ? <div className="muted">How to check: {p.fields.howToCheck}</div> : null}
      {p.fields.due ? <div className="muted">Due: {p.fields.due}</div> : null}
      <div className="goal-why">Why: {p.why}</div>
      {can ? <>
        <div className="goal-actions decide-footer">
          {plan?.buildings.length && parent ? <button className="btn sm ok" onClick={() => setMode(mode === "confirm" ? "" : "confirm")}>Accept…</button>
            : <Act small tone="ok" run={accept}>Accept</Act>}
          {p.fields.text || isKr ? <button className="btn sm" onClick={() => setMode(mode === "edit" ? "" : "edit")}>Edit and accept</button> : null}
          <button className="btn sm bad" onClick={() => setMode(mode === "cut" ? "" : "cut")}>Cut</button>
        </div>
        {mode === "confirm" && plan && parent ? <RetireConfirm goal={old ?? ""} plan={plan} dest={parent.text} confirmLabel="Accept and retire" onConfirm={accept} onCancel={() => setMode("")} /> : null}
        {mode === "edit" ? <div className="goal-form">
          <Field label="Words"><textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {isKr ? <><Field label="How to check"><textarea rows={2} maxLength={300} value={check} onChange={(e) => setCheck(e.target.value)} /></Field>
            <Field label="Due"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field></> : null}
          <Act small tone="ok" disabled={!text.trim()} run={() => api().decideGoalProposal(p.id, { action: "accept", text: text.trim(), ...(isKr && check.trim() ? { howToCheck: check.trim() } : {}), ...(isKr && due ? { due } : {}) }).then(onDone)}>Accept with these words</Act>
        </div> : null}
        {mode === "cut" ? <div className="goal-form">
          <Field label="Note to the proposer" hint="It goes back to them in their inbox."><input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
          <Act small tone="bad" run={() => api().decideGoalProposal(p.id, { action: "cut", note }).then(onDone)}>Cut</Act>
        </div> : null}
      </> : null}
    </div>
  );
}

/**
 * One goal proposal with its Accept / Edit and accept / Cut, outside the editor (the Town Hall in-tray and the review
 * deck, step 4): loads the tree it needs for the proposal's place and the viewer's `goals.edit` there.
 */
export function GoalProposalItem({ p, onDone }: { p: GoalProposalView; onDone: () => void }) {
  const me = useMe();
  const tree = useLoad(() => api().goalTree(), [p.id]);
  if (!tree.data) return tree.error ? <ErrorLine error={tree.error} /> : <Loading />;
  return <ProposalCard root={tree.data} p={p} me={me} onDone={onDone} />;
}

function subtreeKr(root: GoalTreeNode, id: string): TreeKr | null {
  for (const gid of subtreeIds(root)) { const k = findGoal(root, gid)?.keyResults.find((x) => x.id === id); if (k) return k; }
  return null;
}
