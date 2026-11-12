/**
 * A grant's step strip (docs/legible-delegation.md §5 "multimodal where it is cheap", UI / UX C): one box per step with
 * its size (S, M, L), filled when done, and the money line from the latest forecast: spent of the ceiling and the
 * projected total, red when the forecast runs past the ceiling. Each box's tooltip says what the step spent against its
 * price, and a box past 1.5× its price is red (gr_3na7vdmd52). Drawn from data, no model. Nothing for a grant without steps.
 */
import { grantName, type GrantStepState, type GrantView } from "@muster-town/schema";
import { fmtTokens } from "./ui";

/** How many steps are done: the forecast's count, else the steps whose latest assignment is done. */
function stepsDone(g: Pick<GrantView, "steps" | "stepStates" | "forecast">): number {
  if (g.forecast) return Math.min(g.steps.length, g.forecast.stepsDone);
  return (g.stepStates ?? []).filter((s) => s?.status === "done").length;
}

/** Above this many times its price a step reads red (here and on its Bank › Spending row). */
export const STEP_OVER = 1.5;

/**
 * A step box's spend (gr_3na7vdmd52, kr_5j25451emh): "spent 210,000 of its 150,000 price (1.40×)", `over` past 1.5× its
 * price; "spent N" for a step with no price (planned before sizes). Null before the step ran or on an older server.
 */
export function stepSpend(ss: GrantStepState | null | undefined): { text: string; over: boolean } | null {
  if (!ss || ss.spentTokens === undefined) return null;
  const spent = fmtTokens(ss.spentTokens);
  if (!ss.priceTokens) return { text: `spent ${spent}`, over: false };
  const r = ss.spentTokens / ss.priceTokens;
  return { text: `spent ${spent} of its ${fmtTokens(ss.priceTokens)} price (${r.toFixed(2)}×)`, over: r > STEP_OVER };
}

export function StepStrip({ grant: g }: { grant: Pick<GrantView, "steps" | "stepStates" | "forecast" | "spentTokens" | "grantTokens" | "askTokens" | "status"> & Partial<Pick<GrantView, "title" | "objective">> }) {
  if (!g.steps?.length) return null;
  const done = stepsDone(g);
  const f = g.forecast ?? null;
  const ceiling = f?.ceiling ?? g.grantTokens ?? g.askTokens;
  const spent = f?.spent ?? g.spentTokens;
  const over = !!f?.overCeiling;
  return (
    <div className={over ? "step-strip over" : "step-strip"} aria-label={g.objective !== undefined ? `Steps of ${grantName({ title: g.title, objective: g.objective })}` : "Steps"}>
      <ol className="step-strip-boxes">
        {g.steps.map((st, i) => {
          const state = i < done ? "done" : g.stepStates?.[i]?.status === "active" ? "running" : "left";
          const ss = g.stepStates?.[i];
          const spend = stepSpend(ss);
          return <li key={i} className={`step-box size-${st.size ?? "M"} ${state}${spend?.over ? " over" : ""}`} title={`Step ${i + 1} · ${st.size ?? "planned before sizes"} · ${state}: ${st.title}${spend ? ` · ${spend.text}` : ""}`}>{st.size ?? "·"}</li>;
        })}
      </ol>
      <span className="step-strip-line">
        {done} of {g.steps.length} done · spent {fmtTokens(spent)} of {fmtTokens(ceiling)}
        {f ? <> · projected <b className={over ? "step-over" : undefined}>{fmtTokens(f.projected)}</b>{over ? ` (${fmtTokens(f.shortfall)} past the ceiling)` : ""}</> : null}
      </span>
    </div>
  );
}
