/**
 * A grant's step strip (docs/legible-delegation.md §5 "multimodal where it is cheap", UI / UX C): one box per step with
 * its size (S, M, L), filled when done, and the money line from the latest forecast: spent of the ceiling and the
 * projected total, red when the forecast runs past the ceiling. Drawn from data, no model. Nothing for a grant without steps.
 */
import type { GrantView } from "@muster-town/schema";
import { fmtTokens } from "./ui";

/** How many steps are done: the forecast's count, else the steps whose latest assignment is done. */
function stepsDone(g: Pick<GrantView, "steps" | "stepStates" | "forecast">): number {
  if (g.forecast) return Math.min(g.steps.length, g.forecast.stepsDone);
  return (g.stepStates ?? []).filter((s) => s?.status === "done").length;
}

export function StepStrip({ grant: g }: { grant: Pick<GrantView, "steps" | "stepStates" | "forecast" | "spentTokens" | "grantTokens" | "askTokens" | "status"> }) {
  if (!g.steps?.length) return null;
  const done = stepsDone(g);
  const f = g.forecast ?? null;
  const ceiling = f?.ceiling ?? g.grantTokens ?? g.askTokens;
  const spent = f?.spent ?? g.spentTokens;
  const over = !!f?.overCeiling;
  return (
    <div className={over ? "step-strip over" : "step-strip"} aria-label="Steps">
      <ol className="step-strip-boxes">
        {g.steps.map((st, i) => {
          const state = i < done ? "done" : g.stepStates?.[i]?.status === "active" ? "running" : "left";
          return <li key={i} className={`step-box size-${st.size ?? "M"} ${state}`} title={`Step ${i + 1} · ${st.size ?? "planned before sizes"} · ${state}: ${st.title}`}>{st.size ?? "·"}</li>;
        })}
      </ol>
      <span className="step-strip-line">
        {done} of {g.steps.length} done · spent {fmtTokens(spent)} of {fmtTokens(ceiling)}
        {f ? <> · projected <b className={over ? "step-over" : undefined}>{fmtTokens(f.projected)}</b>{over ? ` (${fmtTokens(f.shortfall)} past the ceiling)` : ""}</> : null}
      </span>
    </div>
  );
}
