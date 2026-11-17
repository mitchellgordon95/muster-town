import { grantName, grantPricingOf, type Grant, type GrantForecast, type StepCalibration, type StepSize } from "@muster-town/schema";
import { expectedLeft, stepCalibration } from "./grant-estimate.ts";
import { fileNotice } from "./notices.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * Gates at step reports (docs/legible-delegation.md §7.3, build step 7): the forecast a grant carries from its latest step
 * report, and the expected spend of the steps it has left (what free tokens earmark under oversell, free-tokens.ts).
 * Read-only arithmetic except `fileForecast`, which stores the forecast on the grant and appends its events.
 */

/**
 * Every step's size, or null when a step has none: steps of grants funded before sizes (migration 098 sizes only unfunded
 * proposals) are not priced at all, never guessed as M (decision-5 audit rank 7).
 */
function sizesOf(g: Grant): StepSize[] | null {
  const sizes = g.steps.map((s) => s.size);
  return sizes.every((z): z is StepSize => !!z) ? sizes : null;
}

/**
 * What a funded grant is expected still to spend (`expectedLeft`: steps not started at their size × the calibrated ratio,
 * 1.0 while a size has too few completed steps; the step in flight at what is left of it), never below 0. A grant with
 * no plan steps (funded before migration 096) or unsized ones is expected to spend its ceiling's remainder: there is
 * nothing to price it by.
 */
export function expectedRemaining(world: World, g: Grant, cal: StepCalibration, ceilingRemaining: number): number {
  if (!g.steps.length) return ceilingRemaining;
  return expectedLeft(world, g, cal)?.tokens ?? ceilingRemaining;
}

/**
 * A step of a funded grant filed its report: compute the forecast (steps done and left by size, spent, the ceiling, this
 * grant's spent over size so far, projected = spent + `expectedLeft`), store it on the grant with
 * `needsTopUp` = projected past the ceiling, and append `grant.forecast`; past the ceiling also `grant.top-up-needed`
 * with the shortfall. Past the ceiling that is the whole record: no need, no ask, no notice. A funded grant runs to its
 * end or its ceiling, and the hold at the ceiling (`Grants.checkpoints`) is the only gate (1:1 mt_vdu3iqhasi decision 2).
 * Within it, a `gate` notice "Step N of M landed: …" for the building and goal, with refs [grantId, reportId]. `reportId`: the step report that filed it. Null when the grant has no steps or no ceiling, isn't funded or at checkpoint, or has a step without a size (it
 * appends a `grant.forecast` event with `skipped: "unsized"` saying so).
 */
export function fileForecast(world: World, grantId: string, reportId: string | null = null): GrantForecast | null {
  const g = world.grants.get(grantId);
  if (!g || !g.steps.length || !g.grantTokens) return null;
  // only a running grant forecasts: a stopping or closed one files no ask and no notice
  if (g.status !== "funded" && g.status !== "checkpoint") return null;
  const sizes = sizesOf(g);
  if (!sizes) {
    // funded before step sizes (migration 098 leaves funded grants' steps unsized): no forecast, no ask, no notice, said once per report
    world.events.append({
      type: "grant.forecast", buildingId: g.buildingId,
      text: `No forecast for "${grantName(g)}": its steps were planned before step sizes, so there is nothing to price what is left by`,
      payload: { grantId: g.id, skipped: "unsized", reportId },
    });
    return null;
  }
  const table = grantPricingOf(world.town.get()).stepSizes;
  const cal = stepCalibration(world);
  const states = world.grantDesk.stepStates(g);
  const left: Record<StepSize, number> = { S: 0, M: 0, L: 0 };
  let doneSize = 0, stepsDone = 0;
  sizes.forEach((size, i) => {
    if (states[i]?.status === "done") { stepsDone++; doneSize += table[size]; return; }
    left[size]++;
  });
  // the step in flight at what is left of it, never its full size again (gr_76e81kdpvy)
  const expected = expectedLeft(world, g, cal)?.tokens ?? 0;
  const spent = Math.round(world.grantDesk.spent(g.id));
  const ceiling = g.grantTokens;
  const projected = Math.round(spent + expected);
  const forecast: GrantForecast = {
    at: nowIso(), stepsDone, stepsLeft: left, spent, ceiling,
    spentOverSize: doneSize ? Math.round((spent / doneSize) * 100) / 100 : null,
    projected, overCeiling: projected > ceiling, shortfall: Math.max(0, projected - ceiling),
  };
  world.grants.upsert({ ...g, forecast, needsTopUp: forecast.overCeiling, updatedAt: nowIso() });
  const fmt = (n: number) => n.toLocaleString("en-US");
  const where = `${stepsDone} of ${g.steps.length} steps done; spent ${fmt(spent)} of ${fmt(ceiling)}; projected ${fmt(projected)}`;
  world.events.append({
    type: "grant.forecast", buildingId: g.buildingId,
    text: `Forecast for "${grantName(g)}": ${where} (${forecast.overCeiling ? `over the ceiling by ${fmt(forecast.shortfall)}` : "within the ceiling"})`,
    payload: { grantId: g.id, ...forecast },
  });
  const report = reportId ? world.docs.get(reportId) ?? null : null;
  if (forecast.overCeiling) {
    world.events.append({
      type: "grant.top-up-needed", buildingId: g.buildingId,
      text: `"${grantName(g)}" is projected past its ceiling: ${where}; ${fmt(forecast.shortfall)} more tokens to finish, or cut it`,
      payload: { grantId: g.id, shortfallTokens: forecast.shortfall, projected, ceiling, spent },
    });
  } else {
    const title = `Step ${stepsDone} of ${g.steps.length} landed: ${fmt(spent)} of ${fmt(ceiling)} spent, projected ${fmt(projected)}`;
    fileNotice(world, {
      kind: "gate", buildingId: g.buildingId, goalId: g.goalId ?? world.buildings.get(g.buildingId)?.goalId ?? null, title,
      body: `"${grantName(g)}"${report ? `: ${report.title}` : ""}`, picture: null, refs: [g.id, ...(report ? [report.id] : [])],
    });
  }
  return forecast;
}
