/** Small shared UI pieces for panels. */
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { Event } from "@muster-town/schema";
import { store, useTown } from "../state";
import { api } from "../api";

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
/** "10-29 14:02": a feed line's stamp, dated so events days apart don't read as one day (goal History). */
export function dayClock(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(iso)}`;
}
import { ADJ, ADJ_HINT } from "../format";
import { clipText } from "./showMore";
export { ADJ, ADJ_HINT, breakdownTitle, fmtTokens, fromMillions, toMillions } from "../format";
export const usd = (n: number) => `$${n.toFixed(2)}`;

export function Pill({ tone, children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`pill ${tone ?? ""}`} title={title}>{children}</span>;
}
export function StatusPill({ status }: { status: string }) {
  return <Pill tone={`st-${status}`}>{status.replace(/-/g, " ")}</Pill>;
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: ReactNode }[]; active: string; onChange: (id: string) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={t.id === active ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </nav>
  );
}

/** A button that runs an async action, disables itself meanwhile, and toasts failures. */
export function Act({ run, children, tone, disabled, title, small }: { run: () => Promise<unknown>; children: ReactNode; tone?: "ok" | "warn" | "bad" | "primary"; disabled?: boolean; title?: string; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={`btn ${tone ?? ""} ${small ? "sm" : ""}`} disabled={disabled || busy} title={title}
      onClick={async () => {
        setBusy(true);
        try { await run(); } catch (e) { store.toast((e as Error).message || "Request failed", "bad"); } finally { setBusy(false); }
      }}>
      {busy ? <span className="spin" /> : null}{children}
    </button>
  );
}

/** Fetch on mount and whenever deps change; `reload` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    setLoading(true);
    fnRef.current().then((d) => { if (live) { setData(d); setError(null); } }, (e: Error) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}

/** A long text collapsed to its first `max` characters with a "Show more" that reveals all of it in place (never cut for good). */
export function ShowMore({ text, max = 400, render }: { text: string; max?: number; render: (text: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const { head, cut } = clipText(text, max);
  return <>{render(open || !cut ? text : head)}{cut ? <button type="button" className="link show-more" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{open ? "Show less" : "Show more"}</button> : null}</>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Loading() { return <div className="empty"><span className="spin" /> Loading…</div>; }
export function ErrorLine({ error }: { error: string | null }) { return error ? <div className="error-line">{error}</div> : null; }
export function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header><h3>{title}</h3>{right}</header>
      {children}
    </section>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}
/**
 * A token count typed in millions, the unit shown beside the box. `value` is the text as typed ("2.5"); the form keeps
 * it as a string and converts once, with fromMillions(), when it submits (NaN or 0 → not ready). The unit is adjusted output tokens (Bank step 3).
 */
export function MTokensInput({ value, onChange, placeholder, min = 0, ariaLabel }: { value: string; onChange: (text: string) => void; placeholder?: string; min?: number; ariaLabel?: string }) {
  return (
    <div className="unit-input">
      <input type="number" min={min} step="any" inputMode="decimal" value={value} placeholder={placeholder} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} />
      <span className="unit" title={ADJ_HINT}>M {ADJ}</span>
    </div>
  );
}
/**
 * A whole-number box that can be emptied while typing: the text is a draft, `onChange` gets each valid number
 * (clamped to min..max), and leaving the box shows `value` again.
 */
export function NumberInput({ value, onChange, min, max, ...rest }: { value: number; onChange: (n: number) => void; min?: number; max?: number } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type">) {
  const [text, setText] = useState<string | null>(null);
  return <input {...rest} type="number" min={min} max={max} value={text ?? String(value)}
    onChange={(e) => {
      setText(e.target.value);
      const n = Math.round(Number(e.target.value));
      if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
    }}
    onBlur={(e) => { setText(null); rest.onBlur?.(e); }} />;
}
export function KV({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

const EVENT_TONE: Partial<Record<Event["type"], string>> = {
  "agent.tool": "tool", "agent.thought": "thought", "agent.said": "said", "agent.told": "said", "agent.status": "status",
  "doc.created": "doc", "doc.decision": "status", "session.started": "status", "session.ended": "status", "budget.exhausted": "bad",
  "meeting.utterance": "said", "meeting.phase": "status",
};
export function Feed({ events, empty = "Nothing yet.", showWho }: { events: Event[]; empty?: string; showWho?: boolean }) {
  const agents = useTown((s) => s.agents);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [events.length]);
  if (!events.length) return <Empty>{empty}</Empty>;
  return (
    <div className="feed" ref={ref} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {events.map((e) => (
        <div key={e.id} className={`ev ${EVENT_TONE[e.type] ?? ""}`}>
          <time title={e.ts}>{dayClock(e.ts)}</time>
          {showWho && e.agentId ? <b>{agents[e.agentId]?.name ?? "?"}</b> : null}
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function nameOf(id: string | null | undefined): string {
  if (!id) return "unknown";
  const s = store.state;
  if (s.agents[id]) return s.agents[id].name;
  if (s.me?.user.id === id) return s.me.user.name;
  const known = store.names.get(id);
  if (known) return known;
  // dismissed/banned agents aren't in the snapshot; GET /api/agents/:id still answers for them
  if (id.startsWith("ag_") && !lookups.has(id)) {
    lookups.add(id);
    api().agent(id).then((d) => { store.names.set(id, d.agent.name); store.set({ rev: store.state.rev + 1 }); }, () => undefined);
  }
  return id;
}
const lookups = new Set<string>();
