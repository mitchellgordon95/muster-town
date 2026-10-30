/**
 * The Town Hall goal editor (docs/goals.md "The Town Hall goal editor", build step 3): the whole town goal tree, a
 * node's detail (edit, add a goal or a dated key result, move, owner, retire with move-to-sibling, mark met/missed;
 * History and Subtree tabs) and the managers' open proposals (Accept, Edit and accept, Cut). Humans with `goals.edit`
 * at a node (admins anywhere, an owner in their subtree) edit it; everyone else reads the same tree.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ROOT_GOAL_ID, type GoalTreeNode, type KeyResultStatus } from "@muster-town/schema";
import { api, type GoalProposalView } from "../api";
import { store, useTown } from "../state";
import { Glyph, PanelShell } from "./PanelShell";
import { krStatusLabel, krTone } from "./keyResults";
import { allBuildings, archivedLine, buildingScope, canEditGoal, findGoal, isArchived, moveTargets, pastDue, pathTo, retirePlan, subtreeIds, treeRows, type TreeKr } from "./goalTree";
import { Act, Empty, ErrorLine, Feed, Field, Loading, Pill, Section, Tabs, nameOf, useLoad } from "./ui";

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

export function GoalTreePanel({ goalId }: { goalId?: string }) {
  const rev = useGoalRev();
  const me = useMe();
  const [retired, setRetired] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(goalId ?? null);
  const [bump, setBump] = useState(0);
  const tree = useLoad(() => retired ? api().goalTreeWithRetired() : api().goalTree(), [rev, retired, bump]);
  const proposals = useLoad(() => api().goalProposals("open"), [rev, bump]);
  const reload = () => setBump((n) => n + 1);
  const root = tree.data;
  const anyEdit = me.townWide || (!!root && !!me.userId && treeRows(root, false).some((r) => r.node.ownerId === me.userId));
  const node = root && selected ? findGoal(root, selected) : null;
  return (
    <PanelShell icon={<Glyph kind="goals" />} title="Goal tree" subtitle={anyEdit ? "The town's goals: edit, add key results, decide proposals" : "The town's goals and key results (read-only)"}>
      <ErrorLine error={tree.error ?? proposals.error} />
      {!root ? <Loading /> : <>
        {proposals.data?.length ? <Proposals root={root} list={proposals.data} me={me} onDone={reload} /> : null}
        {node ? <GoalDetail key={node.id} root={root} node={node} me={me} onSelect={setSelected} onDone={reload} />
          : <Section title="Tree" right={<span className="goal-tree-tools">
              <select aria-label="Building filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All buildings</option>
                {allBuildings(root).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Show retired</label>
            </span>}>
            <TreeList root={root} retired={retired} filter={filter} onSelect={setSelected} />
          </Section>}
      </>}
    </PanelShell>
  );
}

function TreeList({ root, retired, filter, onSelect }: { root: GoalTreeNode; retired: boolean; filter: string; onSelect: (id: string) => void }) {
  const scope = filter ? buildingScope(root, filter) : null;
  return (
    <ul className="goal-tree">
      {treeRows(root, retired).map(({ node, depth }) => (
        <li key={node.id} className={`goal-row ${scope && !scope.has(node.id) ? "dim" : ""} ${node.status === "retired" ? "retired" : ""}`} style={{ paddingLeft: depth * 14 }}>
          <div className="goal-row-head">
            <button className="link goal-text" onClick={() => onSelect(node.id)} title={node.text}>{node.id === ROOT_GOAL_ID ? <b>{node.text}</b> : node.text}</button>
            {node.ownerId ? <Pill title={`Owner: ${node.owner.name}`}>{node.owner.name}</Pill> : null}
            {node.status === "retired" ? <Pill tone="bad">retired</Pill> : null}
            {node.buildings.map((b) => <button key={b.id} className="chip" title={`${b.name} is attached here`} onClick={() => store.open({ kind: "building", id: b.id })}>{b.name}</button>)}
          </div>
          <KrLines krs={node.keyResults} />
        </li>
      ))}
    </ul>
  );
}

function KrLines({ krs, actions }: { krs: TreeKr[]; actions?: (k: TreeKr) => ReactNode }) {
  const open = krs.filter((k) => !isArchived(k));
  const done = archivedLine(krs);
  const [showDone, setShowDone] = useState(false);
  const line = (k: TreeKr) => (
    <li key={k.id} className="goal-kr">
      <Pill tone={krTone(k.status as KeyResultStatus)}>{krStatusLabel(k.status as KeyResultStatus)}</Pill>
      {k.due ? <span className={`goal-due ${pastDue(k, today()) ? "late" : ""}`} title={pastDue(k, today()) ? "Past due" : "Due"}>{k.due}</span> : null}
      {k.grantId ? <button className="link goal-grant" onClick={() => store.open({ kind: "grant", id: k.grantId! })}>funded</button> : !isArchived(k) ? <span className="muted goal-grant">open</span> : null}
      <span className="goal-kr-text" title={k.howToCheck ? `How to check: ${k.howToCheck}` : undefined}>{k.text}</span>
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

function GoalDetail({ root, node, me, onSelect, onDone }: { root: GoalTreeNode; node: GoalTreeNode; me: { userId: string | null; townWide: boolean }; onSelect: (id: string | null) => void; onDone: () => void }) {
  const can = canEditGoal(node, me) && node.status === "active";
  const path = pathTo(root, node.id);
  const [tab, setTab] = useState("History");
  const [form, setForm] = useState<"" | "edit" | "goal" | "kr" | "move" | "owner" | "retire">("");
  const done = () => { setForm(""); onDone(); };
  const mark = (k: TreeKr, status: KeyResultStatus) => api().updateKeyResult(k.id, { status }).then(onDone);
  return (
    <div className="goal-detail">
      <div className="goal-path">
        <button className="link" onClick={() => onSelect(null)}>← Tree</button>
        {path.slice(0, -1).map((g) => <span key={g.id}> › <button className="link" onClick={() => onSelect(g.id)}>{clip(g.text, 40)}</button></span>)}
      </div>
      <div className="goal-card"><span>{node.id === ROOT_GOAL_ID ? "Town goal (the root)" : node.status === "retired" ? "Retired goal" : "Goal"}</span>{node.text}</div>
      <div className="muted goal-meta">
        Owner: <b>{node.owner.name}</b>{node.ownerId ? "" : node.owner.goalId === node.id ? "" : ` (from "${clip(findGoal(root, node.owner.goalId)?.text ?? node.owner.goalId, 40)}")`}
        {node.buildings.length ? <> · Attached: {node.buildings.map((b) => <button key={b.id} className="chip" onClick={() => store.open({ kind: "building", id: b.id })}>{b.name}</button>)}</> : null}
      </div>
      {can ? (
        <div className="goal-actions">
          <button className="btn sm" onClick={() => setForm(form === "edit" ? "" : "edit")}>Edit</button>
          <button className="btn sm" onClick={() => setForm(form === "goal" ? "" : "goal")}>Add goal</button>
          <button className="btn sm" onClick={() => setForm(form === "kr" ? "" : "kr")}>Add key result</button>
          {node.parentId ? <button className="btn sm" onClick={() => setForm(form === "move" ? "" : "move")}>Move</button> : null}
          <button className="btn sm" onClick={() => setForm(form === "owner" ? "" : "owner")}>Owner</button>
          {node.parentId ? <button className="btn sm bad" onClick={() => setForm(form === "retire" ? "" : "retire")}>Retire</button> : null}
        </div>
      ) : <div className="muted goal-meta">{node.status === "retired" ? `Retired${node.retiredNote ? `: ${node.retiredNote}` : "."}` : me.userId ? "Only an admin or this goal's owner edits it; managers propose with propose_goal." : "Sign in to see what you can change."}</div>}
      {form === "edit" ? <EditForm node={node} onDone={done} /> : null}
      {form === "goal" ? <AddGoalForm parent={node} onDone={(id) => { done(); onSelect(id); }} /> : null}
      {form === "kr" ? <AddKrForm root={root} node={node} onDone={done} /> : null}
      {form === "move" ? <MoveForm root={root} node={node} onDone={done} /> : null}
      {form === "owner" ? <OwnerForm node={node} me={me} onDone={done} /> : null}
      {form === "retire" ? <RetireForm root={root} node={node} onDone={() => { done(); onSelect(node.parentId); }} /> : null}
      <Section title="Key results">
        {node.keyResults.length ? <KrLines krs={node.keyResults} actions={can ? (k) => !isArchived(k) ? <span className="goal-kr-acts">
          <Act small tone="ok" run={() => mark(k, "met")} title="A human marks it met: it archives under this goal">Met</Act>
          <Act small tone="bad" run={() => mark(k, "missed")} title="A human marks it missed: it archives under this goal">Missed</Act>
        </span> : null : undefined} /> : <Empty>No key results under this goal{can ? ": add a dated one above." : "."}</Empty>}
      </Section>
      {node.children.length ? <Section title="Goals under it">
        <ul className="goal-tree">{node.children.map((c) => <li key={c.id} className="goal-row"><button className="link" onClick={() => onSelect(c.id)}>{c.text}</button></li>)}</ul>
      </Section> : null}
      <Tabs tabs={[{ id: "History", label: "History" }, { id: "Subtree", label: "Subtree" }]} active={tab} onChange={setTab} />
      {tab === "History" ? <History id={node.id} /> : <Subtree node={node} />}
    </div>
  );
}

function History({ id }: { id: string }) {
  const rev = useGoalRev();
  const h = useLoad(() => api().goalHistory(id), [id, rev]);
  if (h.loading && !h.data) return <Loading />;
  return <><ErrorLine error={h.error} /><Feed events={[...(h.data ?? [])].reverse()} empty="No changes recorded yet." /></>;
}

/** The owner's view (docs/goals.md "Owners on nodes"): the buildings attached below, open key results by due date, and the funded ones. */
function Subtree({ node }: { node: GoalTreeNode }) {
  const below = (n: GoalTreeNode): GoalTreeNode[] => [n, ...n.children.flatMap(below)];
  const nodes = below(node);
  const open = nodes.flatMap((n) => n.keyResults.filter((k) => !isArchived(k)).map((k) => ({ k, goal: n })))
    .sort((a, b) => (a.k.due ?? "9999").localeCompare(b.k.due ?? "9999"));
  const buildings = nodes.flatMap((n) => n.buildings);
  return (
    <div className="goal-subtree">
      <Section title={`Buildings (${buildings.length})`}>
        {buildings.length ? <div>{buildings.map((b) => <button key={b.id} className="chip" onClick={() => store.open({ kind: "building", id: b.id })}>{b.name}</button>)}</div> : <Empty>No building is attached here or below.</Empty>}
      </Section>
      <Section title={`Open key results by due date (${open.length})`}>
        {open.length ? <ul className="goal-krs">{open.map(({ k, goal }) => (
          <li key={k.id} className="goal-kr">
            <span className={`goal-due ${pastDue(k, today()) ? "late" : ""}`}>{k.due ?? "no date"}</span>
            <Pill tone={krTone(k.status as KeyResultStatus)}>{krStatusLabel(k.status as KeyResultStatus)}</Pill>
            {k.grantId ? <button className="link goal-grant" onClick={() => store.open({ kind: "grant", id: k.grantId! })}>funded</button> : <span className="muted goal-grant">open</span>}
            <span className="goal-kr-text">{k.text} <span className="muted">· {clip(goal.text, 40)}</span></span>
          </li>
        ))}</ul> : <Empty>No open key results here or below.</Empty>}
      </Section>
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

/** Owners are humans (docs/goals.md "Owners on nodes"): any user who holds a role, or me; empty = inherit from above. */
function OwnerForm({ node, me, onDone }: { node: GoalTreeNode; me: { userId: string | null }; onDone: () => void }) {
  const roles = useLoad(() => api().roles(), []);
  const ids = [...new Set([...(me.userId ? [me.userId] : []), ...(roles.data?.memberships ?? []).filter((m) => m.holderKind === "user").map((m) => m.holderId), ...(node.ownerId ? [node.ownerId] : [])])];
  const [owner, setOwner] = useState(node.ownerId ?? "");
  useEffect(() => setOwner(node.ownerId ?? ""), [node.ownerId]);
  return (
    <div className="goal-form">
      <Field label="Owner" hint="The owner edits this goal and everything under it, and decides and funds grants there.">
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{node.parentId ? "Nobody here (inherit from above)" : "The town admins"}</option>
          {ids.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select>
      </Field>
      <ErrorLine error={roles.error} />
      <Act small tone="primary" disabled={owner === (node.ownerId ?? "")} run={() => api().updateGoal(node.id, { ownerId: owner || null }).then(onDone)}>Set owner</Act>
    </div>
  );
}

function RetireForm({ root, node, onDone }: { root: GoalTreeNode; node: GoalTreeNode; onDone: () => void }) {
  const plan = retirePlan(root, node.id);
  const [to, setTo] = useState(""), [note, setNote] = useState("");
  const mustMove = plan.openKrs.length + plan.buildings.length > 0;
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
      <Act small tone="bad" disabled={mustMove && !to} run={() => api().retireGoal(node.id, { ...(to ? { moveTo: to } : {}), note }).then(onDone)}>Retire goal</Act>
    </div>
  );
}

const ACTION: Record<GoalProposalView["action"], string> = { "add-goal": "New goal", "add-kr": "New key result", edit: "Edit", move: "Move", retire: "Retire", promote: "Promote to a goal" };

/** The goal (in the tree) a proposal belongs to: its target goal, a target key result's goal, else where it goes. */
export function proposalNode(root: GoalTreeNode, p: Pick<GoalProposalView, "targetId" | "parentId" | "action">): GoalTreeNode {
  const krGoal = (id: string): GoalTreeNode | null => {
    const walk = (n: GoalTreeNode): GoalTreeNode | null => n.keyResults.some((k) => k.id === id) ? n : n.children.map(walk).find(Boolean) ?? null;
    return walk(root);
  };
  const at = p.targetId ? findGoal(root, p.targetId) ?? krGoal(p.targetId) : null;
  return (p.action === "move" || !at) && p.parentId ? findGoal(root, p.parentId) ?? at ?? root : at ?? root;
}

function Proposals({ root, list, me, onDone }: { root: GoalTreeNode; list: GoalProposalView[]; me: { userId: string | null; townWide: boolean }; onDone: () => void }) {
  return (
    <Section title={`Proposals (${list.length})`}>
      <div className="goal-proposals">{list.map((p) => <ProposalCard key={p.id} root={root} p={p} me={me} onDone={onDone} />)}</div>
    </Section>
  );
}

function ProposalCard({ root, p, me, onDone }: { root: GoalTreeNode; p: GoalProposalView; me: { userId: string | null; townWide: boolean }; onDone: () => void }) {
  const node = proposalNode(root, p);
  const can = canEditGoal(node, me);
  const [mode, setMode] = useState<"" | "edit" | "cut">("");
  const [text, setText] = useState(p.fields.text ?? ""), [check, setCheck] = useState(p.fields.howToCheck ?? ""), [due, setDue] = useState(p.fields.due ?? "");
  const [note, setNote] = useState("");
  const target = p.targetId ? findGoal(root, p.targetId) : null;
  const targetKr = !target && p.targetId ? subtreeKr(root, p.targetId) : null;
  const old = target?.text ?? targetKr?.text ?? null;
  const parent = p.parentId ? findGoal(root, p.parentId) : null;
  const where = pathTo(root, node.id).map((g) => clip(g.text, 30)).join(" › ");
  const isKr = p.action === "add-kr" || !!targetKr;
  return (
    <div className={`goal-proposal ${p.outsideScope ? "outside" : ""}`}>
      <div className="goal-proposal-head"><Pill tone="warn">{ACTION[p.action]}</Pill> <b>{p.proposedByName}</b>{p.buildingId ? <span className="muted"> · {store.state.buildings.find((b) => b.id === p.buildingId)?.name ?? p.buildingId}</span> : null}{p.outsideScope ? <Pill tone="bad" title="Outside the proposing building's subtree">outside its subtree</Pill> : null}</div>
      <div className="muted goal-path">{where}</div>
      {old && p.fields.text && p.fields.text !== old ? <div className="goal-diff"><s>{old}</s> → <b>{p.fields.text}</b></div>
        : old ? <div className="goal-diff">{old}{(p.action === "move" || p.action === "retire") && parent ? <> → <b>{parent.text}</b></> : null}</div>
        : <div className="goal-diff"><b>{p.fields.text}</b></div>}
      {p.fields.howToCheck ? <div className="muted">How to check: {p.fields.howToCheck}</div> : null}
      {p.fields.due ? <div className="muted">Due: {p.fields.due}</div> : null}
      <div className="goal-why">Why: {p.why}</div>
      {can ? <>
        <div className="goal-actions">
          <Act small tone="ok" run={() => api().decideGoalProposal(p.id, { action: "accept" }).then(onDone)}>Accept</Act>
          {p.fields.text || isKr ? <button className="btn sm" onClick={() => setMode(mode === "edit" ? "" : "edit")}>Edit and accept</button> : null}
          <button className="btn sm bad" onClick={() => setMode(mode === "cut" ? "" : "cut")}>Cut</button>
        </div>
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

function subtreeKr(root: GoalTreeNode, id: string): TreeKr | null {
  for (const gid of subtreeIds(root)) { const k = findGoal(root, gid)?.keyResults.find((x) => x.id === id); if (k) return k; }
  return null;
}
