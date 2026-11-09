import { grantPricingOf, type Grant, type GrantForecast, type StepCalibration, type StepSize } from "@muster-town/schema";
import { calibratedRatio, stepCalibration } from "./grant-estimate.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * Gates at step reports (docs/legible-delegation.md §7.3, build step 7): the forecast a grant carries from its latest step
 * report, and the expected spend of the steps it has left (what free tokens earmark under oversell, free-tokens.ts).
 * Read-only arithmetic except `fileForecast`, which stores the forecast on the grant and appends its events.
 */

/** The sizes of a grant's steps not done yet (a step is done when its latest assignment is). */
function stepsLeft(world: World, g: Grant): StepSize[] {
  const states = world.grantDesk.stepStates(g);
  return g.steps.flatMap((s, i) => (states[i]?.status === "done" ? [] : [s.size ?? "M"]));
}

/**
 * What a funded grant is expected still to spend: the sizes of its steps left × the calibrated ratio per size (1.0 while
 * a size has too few completed steps), never below 0. A grant with no plan steps (funded before migration 096) is
 * expected to spend its ceiling's remainder: there is nothing to price it by.
 */
export function expectedRemaining(world: World, g: Grant, cal: StepCalibration, ceilingRemaining: number): number {
  if (!g.steps.length) return ceilingRemaining;
  const table = grantPricingOf(world.town.get()).stepSizes;
  return Math.max(0, Math.round(stepsLeft(world, g).reduce((s, size) => s + table[size] * calibratedRatio(cal, size), 0)));
}

/**
 * A step of a funded grant filed its report: compute the forecast (steps done and left by size, spent, the ceiling, this
 * grant's spent over size so far, projected = spent + the sizes left × the calibrated ratio), store it on the grant with
 * `needsTopUp` = projected past the ceiling, and append `grant.forecast`; past the ceiling also `grant.top-up-needed`
 * with the shortfall. No ask and no report are written here (the money ask that carries it is a later step). Null when
 * the grant has no steps or no ceiling.
 */
export function fileForecast(world: World, grantId: string): GrantForecast | null {
  const g = world.grants.get(grantId);
  if (!g || !g.steps.length || !g.grantTokens) return null;
  const table = grantPricingOf(world.town.get()).stepSizes;
  const cal = stepCalibration(world);
  const states = world.grantDesk.stepStates(g);
  const left: Record<StepSize, number> = { S: 0, M: 0, L: 0 };
  let doneSize = 0, stepsDone = 0, expected = 0;
  g.steps.forEach((s, i) => {
    const size = s.size ?? "M";
    if (states[i]?.status === "done") { stepsDone++; doneSize += table[size]; return; }
    left[size]++;
    expected += table[size] * calibratedRatio(cal, size);
  });
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
    text: `Forecast for "${g.objective}": ${where} (${forecast.overCeiling ? `over the ceiling by ${fmt(forecast.shortfall)}` : "within the ceiling"})`,
    payload: { grantId: g.id, ...forecast },
  });
  if (forecast.overCeiling) {
    world.events.append({
      type: "grant.top-up-needed", buildingId: g.buildingId,
      text: `"${g.objective}" is projected past its ceiling: ${where}; ${fmt(forecast.shortfall)} more tokens to finish, or cut it`,
      payload: { grantId: g.id, shortfallTokens: forecast.shortfall, projected, ceiling, spent },
    });
  }
  return forecast;
}
