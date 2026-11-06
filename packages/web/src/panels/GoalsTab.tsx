/**
 * The building panel's goal tabs (Mitchell, 1:1 mt_auczm6f1j1): Goals (the goal's objectives and key results, each with
 * one word on its grant state; humans mark met / missed and delete in place, and "Edit" opens the editor that used to sit
 * in Settings) and Grants (every grant of the building, decided in the Town Hall in-tray). The board is notes only.
 */
import { clipText } from "./showMore";
import { useEffect, useState, type ReactNode } from "react";
import { MAX_OBJECTIVES, type GrantView, type KeyResultStatus, type KpiKey, type SnapshotBuilding } from "@muster-town/schema";
import { api, type GoalKeyResult, type ObjectiveView, type SpendNode } from "../api";
import { store, useTown } from "../state";
import { Act, ADJ, Empty, ErrorLine, Field, Loading, Pill, Section, fmtTokens, timeAgo, useLoad } from "./ui";
import { UNBLOCK_LINE, blockedLabel, goalsSummary, grantGroups, grantSpendLine, grantSteps, grantsSummary, krAuthorLine, krGrantWord, krStatusLabel, krTone, objectiveLine, settableStatuses, spentShare, type KrGrantWord } from "./keyResults";
import { openDocLink } from "./Markdown";

/** The building's objective tree and grants, reloaded on every town change. */
export function useGoalData(buildingId: string) {
  const rev = useTown((s) => s.rev);
  const tree = useLoad(() => api().objectives(buildingId), [buildingId, rev]);
  const grants = useLoad(() => api().grants(buildingId), [buildingId, rev]);
  return { tree, grants };
}

const openTab = (id: string, tab: "Goals" | "Grants") => store.open({ kind: "building", id, tab });

/** The Overview's two lines, each opening its tab. */
export function GoalTabsSummary({ b }: { b: SnapshotBuilding }) {
  const { tree, grants } = useGoalData(b.id);
  const g = grants.data ?? [];
  const krIds = tree.data ? new Set([...tree.data.objectives.flatMap((o) => o.keyResults), ...tree.data.unsorted].map((k) => k.id)) : undefined;
  return (
    <div className="goal-tabs-summary">
      <button className="link" onClick={() => openTab(b.id, "Goals")}><b>Goals:</b> {tree.data ? goalsSummary(tree.data, g) : "…"} →</button>
      <button className="link" onClick={() => openTab(b.id, "Grants")}><b>Grants:</b> {grants.data ? grantsSummary(g, krIds) : "…"} →</button>
    </div>
  );
}

const WORD_TONE: Record<KrGrantWord, string> = { funded: "ok", proposed: "info", open: "" };
const WORD_TITLE: Record<KrGrantWord, string> = { funded: "A funded grant works on it", proposed: "A proposal names it, waiting in the Town Hall in-tray", open: "No grant: open for exploration" };

/** Goals tab: the objectives and their key results (read), or the editor (Edit, building.manage). */
export function GoalsTab({ b }: { b: SnapshotBuilding }) {
  useTown((s) => s.me);
  const canManage = store.can("building.manage", b.id);
  const canFund = store.can("building.fund", b.id);
  const [editing, setEditing] = useState(false);
  const { tree, grants } = useGoalData(b.id);
  const atHall = <button className="link" title="The town goal tree: goals, key results and proposals" onClick={() => store.open({ kind: "goals", id: b.goalId ?? undefined })}>Goal tree at the Town Hall →</button>;
  const toggle = canManage ? <span className="goal-actions">{atHall}<button className="link" onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit"}</button></span> : atHall;
  if (editing) return <KeyResultsEditor b={b} right={toggle} />;
  const objectives = tree.data?.objectives ?? [];
  const unsorted = tree.data?.unsorted ?? [];
  const all = [...objectives.flatMap((o) => o.keyResults), ...unsorted];
  const num = new Map(all.map((k, i) => [k.id, i + 1]));
  const g = grants.data ?? [];
  const row = (k: GoalKeyResult) => <GoalRow key={k.id} n={num.get(k.id)!} kr={k} word={krGrantWord(k.id, g)} />;
  // met and missed key results are the record: they fold to their count under the open ones (gr_zak30564zh step 5)
  const isOpen = (k: GoalKeyResult) => k.status !== "met" && k.status !== "missed";
  const judged = all.filter((k) => !isOpen(k));
  const rows = (list: GoalKeyResult[]) => list.filter(isOpen).length ? <ol className="kr-rows">{list.filter(isOpen).map(row)}</ol> : null;
  return (
    <Section title="Objectives and key results" right={toggle}>
      {blockedLabel(b) ? <div className="kr-blocked"><Pill tone="bad">{blockedLabel(b)}</Pill> {UNBLOCK_LINE}</div> : null}
      {tree.loading && !tree.data ? <Loading /> : null}
      <ErrorLine error={tree.error} />
      {tree.data && !all.length && !objectives.length ? <Empty>No objectives or key results on the goal yet.{canManage ? " Write them with Edit." : ""}</Empty> : null}
      {objectives.map((o, i) => (
        <div key={o.id} className="kr-objective">
          <div className="kr-objective-head"><b>Objective {i + 1}: {o.text}</b> <span className="muted">{objectiveLine(o)}</span></div>
          {o.keyResults.length ? rows(o.keyResults) ?? <div className="muted kr-funding">Every key result under it is met or missed.</div> : <div className="muted kr-funding">No key results under it yet.</div>}
        </div>
      ))}
      {objectives.length && unsorted.some(isOpen) ? <div className="kr-objective-head muted">Not under an objective yet</div> : null}
      {rows(unsorted)}
      {judged.length ? <details className="grant-fold settled-fold kr-judged-fold"><summary><b>Met or missed</b>{judged.length} key result{judged.length === 1 ? "" : "s"}</summary><ol className="kr-rows">{judged.map(row)}</ol></details> : null}
      {/* one fold for every key result's how to check, notes and marks, not one per row: the list opens on status and words,
          and its controls stay the same however many key results there are (gr_zak30564zh step 5, kr_p6l1w6tade) */}
      {all.length ? (
        <details className="kr-more kr-checks-fold">
          <summary>How to check{all.some((k) => k.statusNote) ? ", notes" : ""}{canFund || canManage ? " and marks" : ""}</summary>
          <ol className="kr-rows">{all.map((k) => <GoalRowMore key={k.id} n={num.get(k.id)!} kr={k} canFund={canFund} canDelete={canManage} onChanged={tree.reload} />)}</ol>
        </details>
      ) : null}
    </Section>
  );
}

/** Characters of a key result's words on its row (about one line); the full words are in the "How to check" fold. */
const KR_ROW = 64;

/** One key result, read-only: number, status, text and its grant word. How to check, notes and marks are in the list's one fold (GoalRowMore). */
function GoalRow({ n, kr, word }: { n: number; kr: GoalKeyResult; word: KrGrantWord }) {
  return (
    <li className="kr-row">
      <div className="kr-row-head">
        <span className="kr-n">{n}</span>
        <Pill tone={krTone(kr.status)} title={kr.statusNote || undefined}>{krStatusLabel(kr.status)}</Pill>
        <b title={kr.text}>{clipText(kr.text, KR_ROW).head}</b>
        <span className={`kr-word ${WORD_TONE[word]}`} title={WORD_TITLE[word]}>{word}</span>
      </div>
    </li>
  );
}

/** One key result in the "How to check" fold: how to check, the status note, the postmortem, met / missed (building.fund) and delete (building.manage). */
function GoalRowMore({ n, kr, canFund, canDelete, onChanged }: { n: number; kr: GoalKeyResult; canFund: boolean; canDelete: boolean; onChanged: () => void }) {
  const judged = kr.status === "met" || kr.status === "missed";
  const mark = (status: KeyResultStatus) => async () => {
    // missed asks why: the line is filed as the human's note and queues one postmortem (docs/goals.md "Postmortems on missed KRs")
    const why = status === "missed" ? window.prompt(`Why was key result ${n} missed? One line: it queues a postmortem on the building.`)?.trim() : "";
    if (status === "missed" ? !why : !window.confirm(`Mark key result ${n} ${status}?`)) return;
    await api().updateKeyResult(kr.id, { status, note: why ?? "" });
    store.toast(`Key result ${n} is ${status}`, "ok");
    onChanged();
  };
  return (
    <li className="kr-row">
      <div className="kr-row-head"><span className="kr-n">{n}</span><b>{kr.text}</b></div>
      <div className="muted kr-check">How to check: {kr.howToCheck}</div>
      {kr.statusNote ? <div className="muted kr-check">{krStatusLabel(kr.status)}: {kr.statusNote}</div> : null}
      {kr.status === "missed" ? <div className="muted kr-check">{kr.postmortemDocId ? <button className="link" onClick={() => void openDocLink(kr.postmortemDocId!)}>Postmortem →</button> : "Postmortem pending: queued on the building that worked on it."}</div> : null}
      {(canFund && !judged) || canDelete ? (
        <div className="actions">
          {canFund && !judged ? <><Act small tone="ok" run={mark("met")}>Mark met</Act><Act small tone="warn" run={mark("missed")}>Mark missed</Act></> : null}
          {canDelete ? <Act small tone="bad" title="Refused while a grant names it" run={async () => {
            if (!window.confirm(`Delete key result ${n} ("${kr.text}")?`)) return;
            await api().deleteKeyResult(kr.id);
            store.toast(`Key result ${n} deleted`, "ok");
            onChanged();
          }}>Delete</Act> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Grants tab: open proposals, then funded grants, then checkpoint / closed. Fund, counter and reject stay in the Town Hall in-tray. */
export function GrantsTab({ b }: { b: SnapshotBuilding }) {
  const { grants } = useGoalData(b.id);
  const spend = useLoad(() => api().financeSpend(), [b.id]);
  const { proposals, funded, settled } = grantGroups(grants.data ?? []);
  const held = settled.filter((g) => g.status === "checkpoint"), closed = settled.filter((g) => g.status !== "checkpoint");
  const hall = useTown((s) => s.buildings.find((x) => x.kind === "town-hall"));
  const decideLink = hall ? <button className="link" onClick={() => store.open({ kind: "intray", id: hall.id })}>Decide in the Town Hall in-tray →</button> : undefined;
  const rows = (list: GrantView[]) => <div className="doc-list">{list.map((g) => <GrantTabRow key={g.id} g={g} steps={grantSteps(spend.data, b.id, g.id)} />)}</div>;
  return (
    <>
      {grants.loading && !grants.data ? <Loading /> : null}
      <ErrorLine error={grants.error} />
      {grants.data && !grants.data.length ? <Empty>No grants or proposals yet. The manager proposes one per key result; humans fund it in the Town Hall in-tray.</Empty> : null}
      {/* the grants waiting on a human link to the in-tray once per section, not once per row (gr_zak30564zh step 5) */}
      {proposals.length ? <Section title={<>Open proposals <Pill>{proposals.length}</Pill></>} right={decideLink}>{rows(proposals)}</Section> : null}
      {funded.length ? <Section title={<>Funded <Pill>{funded.length}</Pill></>}>{rows(funded)}</Section> : null}
      {held.length ? <Section title={<>At checkpoint <Pill>{held.length}</Pill></>} right={proposals.length ? undefined : decideLink}>{rows(held)}</Section> : null}
      {/* closed grants are history: folded to their count, one click away (gr_zak30564zh step 4) */}
      {closed.length ? <details className="grant-fold settled-fold"><summary><b>Closed</b>{closed.length} grant{closed.length === 1 ? "" : "s"}</summary>{rows(closed)}</details> : null}
    </>
  );
}

function grantStatusLine(g: GrantView): ReactNode {
  switch (g.status) {
    case "proposed": return `Asks ${fmtTokens(g.askTokens)} ${ADJ} · proposed ${timeAgo(g.createdAt)}`;
    case "countered": return `Countered: the manager revises it and proposes again · asks ${fmtTokens(g.askTokens)} ${ADJ}`;
    case "closed": return `Closed${g.outcome ? `: ${g.outcome}` : ""}${g.closedAt ? ` ${timeAgo(g.closedAt)}` : ""} · spent ${grantSpendLine(g)}`;
    case "stopping": return `Stopping: a human stopped it; it closes as stopped once its forks have filed their reports · spent ${grantSpendLine(g)}`;
    case "rejected": return `Rejected · asked ${fmtTokens(g.askTokens)} ${ADJ}`;
    default: return null;
  }
}

/** Characters of a grant's objective on its Grants-tab row (about one line; the grant's page has it whole). */
const GRANT_ROW = 84;

/** One grant: objective (opens the grant), status, spend, its key result, its steps as one line (the in-tray link sits on its section). */
function GrantTabRow({ g, steps }: { g: GrantView; steps: SpendNode[] }) {
  const live = g.status === "funded" || g.status === "checkpoint";
  return (
    <div className="doc-row grant-tab-row">
      <div className="kr-grant-head">
        <button className="link doc-row-title" title={`Open grant ${g.id}: ${g.objective}`} onClick={() => store.open({ kind: "grant", id: g.id })}>{clipText(g.objective, GRANT_ROW).head}</button>
        <Pill tone={g.status === "checkpoint" || g.status === "proposed" ? "warn" : g.status === "funded" ? "ok" : g.status === "rejected" ? "bad" : ""}>{g.status}</Pill>
      </div>
      {live ? (
        <div className="kr-bar-row">
          <span className="kr-bar"><i style={{ width: `${spentShare(g.spentTokens, g.grantTokens ?? 0) * 100}%` }} /></span>
          <span className="muted">{grantSpendLine(g)}</span>
        </div>
      ) : <div className="muted">{grantStatusLine(g)}</div>}
      <div className="muted">{g.keyResult ? <>Key result: {clipText(g.keyResult.text, 48).head} · {krStatusLabel(g.keyResult.status)}</> : "Names no key result"}</div>
      {/* the steps as one line; each session is listed on the grant's page (gr_zak30564zh step 4: one control per row) */}
      {steps.length ? <div className="muted" title={steps.map((s) => `${s.name} · ${fmtTokens(s.tokens)} ${ADJ}`).join("\n")}>{steps.length} step{steps.length === 1 ? "" : "s"}{live ? "" : ` · ${fmtTokens(steps.reduce((t, s) => t + s.tokens, 0))} ${ADJ}`} · {steps.reduce((t, s) => t + s.sessions, 0)} sessions</div>
        : live ? <div className="muted">No step sessions yet.</div> : null}
    </div>
  );
}

/**
 * The goal's objectives and key results, the edit path (Goals → Edit; read on the Goals tab; docs/goal-directed-budgets.md
 * "Objectives and KPIs"). Each objective is one sentence for the quarter naming the town KPI it moves, and holds 2 to 4
 * key results; key results under none sit in "Not under an objective yet". A human with building.manage writes them,
 * and so does the manager; status up to claimed is the manager's, met / missed need building.fund. A key result a
 * grant names can't be deleted, nor an objective that holds key results (the server says why).
 */
function KeyResultsEditor({ b, right }: { b: SnapshotBuilding; right?: ReactNode }) {
  const rev = useTown((s) => s.rev);
  useTown((s) => s.me);
  const tree = useLoad(() => api().objectives(b.id), [b.id, rev]);
  const canFund = store.can("building.fund", b.id);
  const human = store.can("building.manage", b.id); // the web is the humans' client: a manage holder here is a human
  const objectives = tree.data?.objectives ?? [];
  const unsorted = tree.data?.unsorted ?? [];
  const all = [...objectives.flatMap((o) => o.keyResults), ...unsorted];
  const num = new Map(all.map((k, i) => [k.id, i + 1]));
  const row = (k: GoalKeyResult) => <KeyResultRow key={k.id} n={num.get(k.id)!} kr={k} canWrite={human} statuses={settableStatuses(canFund)} objectives={objectives} onChanged={tree.reload} />;
  return (
    <Section title="Objectives and key results" right={right}>
      <p className="direction">{KPI_FRAMING_SHORT} Each objective is one sentence for the quarter and names the KPI it moves; its 2 to 4 key results say how you'll know, in terms a human can check in the live town. Each grant names one key result, and a goal-directed building is blocked without them. Humans write them here; the manager writes them too (from a meeting or your 1:1) and lists each key result in its next rollup, so you can keep or cut it.</p>
      {tree.loading && !tree.data ? <Loading /> : null}
      <ErrorLine error={tree.error} />
      {tree.data && !all.length && !objectives.length ? <Empty>No objectives or key results on the goal yet{b.kind !== "town-hall" ? ": the building is blocked until a key result exists or a grant is funded" : ""}.</Empty> : null}
      {objectives.map((o, i) => (
        <div key={o.id} className="kr-objective">
          <ObjectiveRow n={i + 1} o={o} canWrite={human} onChanged={tree.reload} />
          <ol className="kr-editor">{o.keyResults.map(row)}</ol>
          {o.keyResults.length < 2 ? <div className="muted kr-hint">Aim for 2 to 4 key results under each objective.</div> : null}
        </div>
      ))}
      {objectives.length && unsorted.length ? <div className="kr-objective-head muted">Not under an objective yet: move each under one</div> : null}
      {unsorted.length ? <ol className="kr-editor">{unsorted.map(row)}</ol> : null}
      {human && objectives.length < MAX_OBJECTIVES ? <AddObjective buildingId={b.id} n={objectives.length + 1} onChanged={tree.reload} /> : null}
    </Section>
  );
}

const KPI_OPTIONS: { key: KpiKey; name: string }[] = [{ key: "fund", name: "Fund" }, { key: "join", name: "Join" }, { key: "trust", name: "Trust" }];
const KPI_FRAMING_SHORT = "The town goal is three standing KPIs, Fund, Join and Trust.";

/** One objective: its sentence, the KPI it moves and its quarter (humans edit), delete (refused while it holds key results). */
function ObjectiveRow({ n, o, canWrite, onChanged }: { n: number; o: ObjectiveView; canWrite: boolean; onChanged: () => void }) {
  const [f, setF] = useState<{ text: string; kpi: KpiKey | ""; horizon: string }>({ text: o.text, kpi: o.kpi ?? "", horizon: o.horizon });
  useEffect(() => setF({ text: o.text, kpi: o.kpi ?? "", horizon: o.horizon }), [o.text, o.kpi, o.horizon]);
  const dirty = f.text !== o.text || f.kpi !== (o.kpi ?? "") || f.horizon !== o.horizon;
  if (!canWrite) return <div className="kr-objective-head"><b>Objective {n}: {o.text}</b> <span className="muted">{objectiveLine(o)}</span></div>;
  return (
    <form className="form kr-objective-head" onSubmit={(e) => e.preventDefault()}>
      <Field label={`Objective ${n}`}><input value={f.text} maxLength={300} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
      <div className="row">
        <Field label="Moves"><select value={f.kpi} onChange={(e) => setF({ ...f, kpi: e.target.value as KpiKey | "" })}>
          <option value="">(no KPI yet)</option>
          {KPI_OPTIONS.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
        </select></Field>
        <Field label="Quarter"><input value={f.horizon} maxLength={7} placeholder="2026-Q4" onChange={(e) => setF({ ...f, horizon: e.target.value })} /></Field>
      </div>
      <div className="actions">
        <Act small tone="primary" disabled={!dirty || !f.text.trim() || !/^\d{4}-Q[1-4]$/.test(f.horizon)} run={async () => {
          await api().updateObjective(o.id, { text: f.text.trim(), kpi: f.kpi || null, horizon: f.horizon });
          store.toast(`Objective ${n} saved`, "ok");
          onChanged();
        }}>Save</Act>
        <Act small tone="bad" title="Refused while key results hang off it" run={async () => {
          if (!window.confirm(`Delete objective ${n} ("${o.text}")?`)) return;
          await api().deleteObjective(o.id);
          store.toast(`Objective ${n} deleted`, "ok");
          onChanged();
        }}>Delete</Act>
      </div>
    </form>
  );
}

function AddObjective({ buildingId, n, onChanged }: { buildingId: string; n: number; onChanged: () => void }) {
  const [f, setF] = useState({ text: "", kpi: "" as KpiKey | "" });
  return (
    <form className="form kr-add" onSubmit={(e) => e.preventDefault()}>
      <Field label={`Objective ${n}`} hint="One sentence: what the building will achieve this quarter. 2 or 3 per goal."><input value={f.text} maxLength={300} placeholder="A stranger can …" onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
      <Field label="Moves"><select value={f.kpi} onChange={(e) => setF({ ...f, kpi: e.target.value as KpiKey | "" })}>
        <option value="">(pick the KPI it moves)</option>
        {KPI_OPTIONS.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
      </select></Field>
      <div className="actions"><Act tone="primary" disabled={!f.text.trim() || !f.kpi} run={async () => {
        await api().createObjective(buildingId, { text: f.text.trim(), kpi: f.kpi || null });
        setF({ text: "", kpi: "" });
        store.toast("Objective added: put key results under it", "ok");
        onChanged();
      }}>Add objective</Act></div>
    </form>
  );
}

/** Who wrote the key result (a human, or the building's manager from a meeting), who last edited it, and its sources. */
function KeyResultAuthor({ kr }: { kr: GoalKeyResult }) {
  const by = krAuthorLine(kr);
  if (!by && !kr.sourceDocIds.length) return null;
  return (
    <div className="muted kr-author">
      {by}
      {kr.sourceDocIds.length ? <>{by ? " · " : ""}from {kr.sourceDocIds.map((id, i) => <span key={id}>{i ? ", " : ""}<button className="link" onClick={() => void openDocLink(id)}>{store.state.docs[id]?.title ?? id}</button></span>)}</> : null}
    </div>
  );
}

/** One key result in the editor: words (humans), status (per `statuses`), delete. Dirty rows save explicitly. */
function KeyResultRow({ n, kr, canWrite, statuses, objectives, onChanged }: { n: number; kr: GoalKeyResult; canWrite: boolean; statuses: KeyResultStatus[]; objectives: ObjectiveView[]; onChanged: () => void }) {
  const [f, setF] = useState({ text: kr.text, howToCheck: kr.howToCheck });
  useEffect(() => setF({ text: kr.text, howToCheck: kr.howToCheck }), [kr.text, kr.howToCheck]);
  const dirty = f.text !== kr.text || f.howToCheck !== kr.howToCheck;
  const canStatus = statuses.includes(kr.status);
  const setStatus = async (status: KeyResultStatus) => {
    if (status === kr.status) return;
    await api().updateKeyResult(kr.id, { status });
    store.toast(`Key result ${n} is ${krStatusLabel(status)}`, "ok");
    onChanged();
  };
  return (
    <li className="kr-editor-row">
      <div className="kr-row-head">
        <span className="kr-n">{n}</span>
        {canStatus ? (
          <select className={`kr-status ${krTone(kr.status)}`} value={kr.status} title={kr.statusNote || "Status"} onChange={(e) => setStatus(e.target.value as KeyResultStatus).catch((err) => store.toast((err as Error).message, "bad"))}>
            {statuses.map((s) => <option key={s} value={s}>{krStatusLabel(s)}</option>)}
          </select>
        ) : <Pill tone={krTone(kr.status)} title={kr.statusNote || undefined}>{krStatusLabel(kr.status)}</Pill>}
        {canWrite ? null : <b>{kr.text}</b>}
        {canWrite && objectives.length ? (
          <select className="kr-move" value={kr.objectiveId ?? ""} title="The objective it serves" aria-label={`Objective of key result ${n}`} onChange={(e) => {
            api().updateKeyResult(kr.id, { objectiveId: e.target.value || null }).then(() => { store.toast(`Key result ${n} moved`, "ok"); onChanged(); }, (err) => store.toast((err as Error).message, "bad"));
          }}>
            <option value="">{kr.objectiveId ? "Not under an objective" : "Move under…"}</option>
            {objectives.map((o, i) => <option key={o.id} value={o.id}>Objective {i + 1}: {o.text}</option>)}
          </select>
        ) : null}
      </div>
      {canWrite ? (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <input value={f.text} maxLength={300} aria-label={`Key result ${n}`} onChange={(e) => setF({ ...f, text: e.target.value })} />
          <input value={f.howToCheck} maxLength={300} aria-label={`How to check ${n}`} placeholder="How to check" onChange={(e) => setF({ ...f, howToCheck: e.target.value })} />
          <div className="actions">
            <Act small tone="primary" disabled={!dirty || !f.text.trim() || !f.howToCheck.trim()} run={async () => {
              await api().updateKeyResult(kr.id, { text: f.text.trim(), howToCheck: f.howToCheck.trim() });
              store.toast(`Key result ${n} saved`, "ok");
              onChanged();
            }}>Save</Act>
            {dirty ? <button className="link" onClick={() => setF({ text: kr.text, howToCheck: kr.howToCheck })}>Undo</button> : null}
            <Act small tone="bad" title="Refused while a grant names it" run={async () => {
              if (!window.confirm(`Delete key result ${n} ("${kr.text}")?`)) return;
              await api().deleteKeyResult(kr.id);
              store.toast(`Key result ${n} deleted`, "ok");
              onChanged();
            }}>Delete</Act>
          </div>
        </form>
      ) : <div className="muted kr-check">How to check: {kr.howToCheck}</div>}
      <KeyResultAuthor kr={kr} />
    </li>
  );
}

