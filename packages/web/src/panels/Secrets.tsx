/** Collective secrets (docs/secrets.md): the planning desk's Secrets tab, for admins. The secrets stay the Town Hall's collective secrets (storage and grants unchanged); only the tab lives here. Values are write-only: the server never returns them. */
import { useState } from "react";
import type { SecretGrants, SecretView } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { Act, Empty, ErrorLine, Loading, Pill, Section, nameOf, timeAgo, useLoad } from "./ui";

type Kind = "buildings" | "agents" | "skills";
const KIND_LABEL: Record<Kind, string> = { buildings: "Building", agents: "Agent", skills: "Skill" };

export function SecretsTab() {
  const [v, setV] = useState(0);
  const list = useLoad(() => api().secrets(), [v]);
  const skills = useLoad(() => api().skills(), []);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const reload = () => setV((n) => n + 1);
  if (list.loading && !list.data) return <Loading />;
  const skillName = (id: string) => skills.data?.find((k) => k.id === id)?.name ?? id;
  const create = async () => {
    const n = name.trim().toUpperCase();
    await api().putSecret(n, value ? { value } : { grants: {} });
    store.toast(`Secret ${n} saved${value ? "" : " (no value yet)"}. Grant it below; until then no desk gets it.`, "ok");
    setName(""); setValue(""); reload();
  };
  return (
    <>
      <ErrorLine error={list.error} />
      <div className="library-hint">
        Credentials for this collective's tools (e.g. <code>MINICLAW_WS_TOKEN</code>). A desk gets a secret as an env var only when it's granted to the
        whole town, the desk's building, its agent, or a skill pinned for that agent. Values are encrypted and write-only: nobody can read one back here.
        Host secrets (sign-in, admin and deploy tokens) never appear here and never reach a desk. <code>GH_TOKEN</code> is the collective's repo token:
        every desk with code access gets it, no grant needed.
      </div>
      {list.data && !list.data.keyConfigured ? (
        <div className="error-line">The host has no <code>MUSTER_TOWN_DATA_KEY</code>, so values can't be stored (they're never kept in plaintext). The operator sets it in the server's env, e.g. <code>openssl rand -base64 32</code>.</div>
      ) : null}
      <Section title={`Secrets (${list.data?.secrets.length ?? 0})`}>
        {!list.data?.secrets.length ? <Empty>No secrets yet.</Empty> : list.data.secrets.map((s) => <SecretRow key={s.name} s={s} skillName={skillName} skills={skills.data ?? []} onChange={reload} />)}
      </Section>
      <Section title="New secret">
        <form className="skill-pin-form" onSubmit={(e) => e.preventDefault()}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="NAME (e.g. MINICLAW_WS_TOKEN)" aria-label="Name" autoComplete="off" spellCheck={false} />
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value (write-only)" aria-label="Value" autoComplete="new-password" />
          <Act small tone="primary" disabled={!name.trim()} run={create}>Add</Act>
        </form>
      </Section>
    </>
  );
}

function SecretRow({ s, skillName, skills, onChange }: { s: SecretView; skillName: (id: string) => string; skills: { id: string; name: string }[]; onChange: () => void }) {
  const buildings = useTown((x) => x.buildings);
  const agents = useTown((x) => x.agents);
  const [kind, setKind] = useState<Kind>("skills");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const options: { id: string; label: string }[] =
    kind === "buildings" ? buildings.map((b) => ({ id: b.id, label: b.name }))
      : kind === "agents" ? Object.values(agents).filter((a) => a.kind !== "human").map((a) => ({ id: a.id, label: a.name })).sort((a, b) => a.label.localeCompare(b.label))
        : skills.map((k) => ({ id: k.id, label: k.name }));
  const label = (k: Kind, id: string) => (k === "skills" ? skillName(id) : k === "buildings" ? buildings.find((b) => b.id === id)?.name ?? id : nameOf(id));
  const setGrants = async (grants: SecretGrants) => { await api().putSecret(s.name, { grants }); onChange(); };
  const add = async () => {
    const id = target || options[0]?.id;
    if (!id || s.grants[kind].includes(id)) return;
    await setGrants({ ...s.grants, [kind]: [...s.grants[kind], id] });
    store.toast(`${s.name} granted to ${label(kind, id)}`, "ok");
  };
  const remove = (k: Kind, id: string) => async () => { await setGrants({ ...s.grants, [k]: s.grants[k].filter((x) => x !== id) }); };
  const setVal = async () => { await api().putSecret(s.name, { value }); setValue(""); store.toast(`${s.name} value ${s.set ? "replaced" : "set"}`, "ok"); onChange(); };
  const del = async () => { if (!confirm(`Delete ${s.name}? Desks stop getting it at their next session.`)) return; await api().deleteSecret(s.name); onChange(); };
  const grants = (Object.keys(KIND_LABEL) as Kind[]).flatMap((k) => s.grants[k].map((id) => ({ k, id })));
  const repoToken = s.name === "GH_TOKEN";
  return (
    <div className="secret-row">
      <div className="doc-row-title"><code>{s.name}</code> <Pill tone={s.set ? "ok" : "bad"}>{s.set ? "set" : "missing"}</Pill> <span className="muted">updated {timeAgo(s.updatedAt)}{s.updatedBy ? ` by ${nameOf(s.updatedBy)}` : ""}</span></div>
      <div className="doc-row-meta">
        {repoToken ? <span className="muted">The collective's repo token: every desk with code access gets it, and redeploy pulls with it. Grants don't apply.</span>
          : s.grants.town ? <span><Pill tone="info" title="Town grant">Town: every resident</Pill> <Act small tone="warn" title="Stop granting it to everyone" run={() => setGrants({ ...s.grants, town: false })}>×</Act></span>
          : !grants.length ? <span className="muted">Not granted: no desk gets it.</span> : grants.map(({ k, id }) => (
          <span key={`${k}:${id}`}>
            <Pill tone="info" title={`${KIND_LABEL[k]} grant`}>{KIND_LABEL[k]}: {label(k, id)}</Pill>
            <Act small tone="warn" title="Remove this grant" run={remove(k, id)}>×</Act>
          </span>
        ))}
      </div>
      {repoToken || s.grants.town ? null : (
        <div className="doc-row-meta">
          <Act small title="Every resident of every building gets it; the grants above then add nothing" run={async () => { await setGrants({ ...s.grants, town: true }); store.toast(`${s.name} granted to the whole town`, "ok"); }}>Grant to the whole town</Act>
        </div>
      )}
      {repoToken || s.grants.town ? null : <form className="skill-pin-form" onSubmit={(e) => e.preventDefault()}>
        <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setTarget(""); }} aria-label="Grant to">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select value={target || options[0]?.id || ""} onChange={(e) => setTarget(e.target.value)} aria-label="Target">
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <Act small tone="primary" disabled={!options.length} run={add}>Grant</Act>
      </form>}
      <form className="skill-pin-form" onSubmit={(e) => e.preventDefault()}>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={s.set ? "new value (replaces the old one)" : "value"} aria-label={`Value for ${s.name}`} autoComplete="new-password" />
        <Act small tone="primary" disabled={!value} run={setVal}>{s.set ? "Replace value" : "Set value"}</Act>
        <Act small tone="bad" run={del}>Delete</Act>
      </form>
    </div>
  );
}
