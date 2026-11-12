/**
 * The in-tray as a list (Mitchell's flag dc_2hllscunfx): one line per item, its title truncated with the full title in
 * the tooltip, a time-ago and at most one short pill; clicking the line opens the item (the report with its review, or
 * the grant / retainer / request row with its decision buttons). It is the only view: the Cards view was removed for
 * everyone (1:1 mt_i50xwu4z2t, "that view was basically impossible to read").
 */
import type { ReactNode } from "react";
import type { AccessRequestView, CaptainRequestView, Doc, GrantView, ScheduleView } from "@muster-town/schema";
import type { GoalProposalView } from "../api";
import { fmtTokens, Pill, timeAgo } from "./ui";
import { VERDICT_TONE } from "./DocView";

/** One in-tray line. Hook-free: `lead` (building tag, portrait) is rendered by the caller. */
export function CompactLine({ lead, title, at, pill, onOpen, selected }: { lead?: ReactNode; title: string; at: string | null | undefined; pill?: ReactNode; onOpen: () => void; /** the line whose item is open (or was last open) in the sheet */ selected?: boolean }) {
  return (
    <button className={selected ? "doc-row intray-line on" : "doc-row intray-line"} aria-current={selected || undefined} onClick={onOpen} title={title}>
      {lead ? <span className="intray-line-lead">{lead}</span> : null}
      <span className="intray-line-title">{title}</span>
      <span className="intray-line-end">{pill}<span className="muted">{timeAgo(at)}</span></span>
    </button>
  );
}

/** A report's one pill: flag, visitor report, else its verdict. */
export function reportPill(d: Pick<Doc, "type" | "tags" | "verdict">): ReactNode {
  if (d.type === "flag") return <Pill tone="warn">⚑ flag</Pill>;
  if (d.tags.includes("visitor")) return <Pill tone="warn">visitor report</Pill>;
  return d.verdict ? <Pill tone={VERDICT_TONE[d.verdict]}>{d.verdict}</Pill> : null;
}

/** A grant's one pill: the money that matters for it, with its status where the section heading doesn't say it ("asks 350k", "538k / 500k", "stopped · …"). */
export function grantPillText(g: Pick<GrantView, "status" | "outcome" | "askTokens" | "grantTokens" | "spentTokens">, stopped = false): string {
  const spent = `${fmtTokens(g.spentTokens)} / ${fmtTokens(g.grantTokens ?? 0)}`;
  if (stopped) return `stopped · ${spent}`;
  if (g.status === "proposed") return `asks ${fmtTokens(g.askTokens)}`;
  if (g.status === "countered") return `countered · asks ${fmtTokens(g.askTokens)}`;
  if (g.status === "checkpoint" || (g.status === "closed" && g.outcome === "done")) return spent;
  return `${g.status} · ${spent}`;
}
export function grantPill(g: GrantView, stopped = false): ReactNode {
  const tone = g.status === "checkpoint" ? "warn" : stopped || g.status === "rejected" ? "bad" : g.status === "proposed" ? "ok" : "";
  return <Pill tone={tone}>{grantPillText(g, stopped)}</Pill>;
}

export function retainerPill(x: ScheduleView): ReactNode {
  return <Pill tone={x.retainer === "asked" ? "warn" : ""}>{x.retainer === "asked" ? "retainer ask" : x.retainer} · {fmtTokens(x.askTokens)}</Pill>;
}

const who = (r: { githubLogin: string | null; name: string }) => r.githubLogin ? `@${r.githubLogin}` : r.name;
export const captainTitle = (r: CaptainRequestView) => `${who(r)} asks to captain "${r.goalText}"`;
export const accessTitle = (r: AccessRequestView) => `${who(r)} asks to join${r.message ? `: "${r.message}"` : ""}`;
export const goalProposalTitle = (p: GoalProposalView) => `${p.proposedByName}: ${p.action.replace(/-/g, " ")}${p.fields.text ? ` "${p.fields.text}"` : p.why ? `: ${p.why}` : ""}`;
