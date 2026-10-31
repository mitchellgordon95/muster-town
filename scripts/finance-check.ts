// Live finance check: fetches the five public finance endpoints of a running town and re-checks every identity, within
// each endpoint and across them, from the returned numbers. Read-only. Exits 1 when any check fails.
// Run from the repo root: `npm run check:finance` (https://muster.town) or `npm run check:finance -- http://localhost:3000`.
// The five reads are not one snapshot: a debit landing between them shifts used/left, so a round whose cross-endpoint
// checks fail is fetched again (up to 3 rounds) before it counts as a failure.

type Json = Record<string, any>;
interface Check { name: string; ok: boolean; line: string }

const base = (process.argv[2] ?? "https://muster.town").replace(/\/+$/, "");
const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : String(n));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function eq(name: string, leftExpr: string, left: number, rightExpr: string, right: number): Check {
  const diff = left - right;
  return { name, ok: diff === 0, line: `${leftExpr} ${fmt(left)} = ${rightExpr} ${fmt(right)} (diff ${fmt(diff)})` };
}
function flag(name: string, ok: unknown, detail: string): Check {
  return { name, ok: ok === true, line: detail };
}

function near(name: string, leftExpr: string, left: number, rightExpr: string, right: number, tol = 1e-6): Check {
  const diff = left - right;
  return { name, ok: Math.abs(diff) <= tol, line: `${leftExpr} $${left.toFixed(4)} = ${rightExpr} $${right.toFixed(4)} (diff ${diff.toFixed(6)})` };
}

/** Every check, from the five bodies alone. */
function checks(f: Json, s: Json, src: Json, bank: Json, fly: Json): Check[] {
  const ob = f.overdrawnBreakdown ?? {};
  return [
    flag("finance sumCheck", f.sumCheck?.ok, `ok ${f.sumCheck?.ok}, diff ${fmt(f.sumCheck?.diff)} (${f.sumCheck?.identity})`),
    flag("spend check", s.check?.ok, `ok ${s.check?.ok}, diff ${fmt(s.check?.diff)} (${s.check?.identity})`),
    flag("sources sumCheck", src.sumCheck?.ok, `ok ${src.sumCheck?.ok}, diff ${fmt(src.sumCheck?.diff)} (${src.sumCheck?.identity})`),
    eq("finance identity", "used + expired + left", f.used + f.expired + f.left, "total + overdrawn", f.total + f.overdrawn),
    eq("overdrawn parts", "Σ overdrawnBreakdown",
      sum([ob.durableOvershoot, ob.subscriptionOverdrawn, ob.deletedCreditDebits, ob.allocationOverspent].map(Number)), "overdrawn", f.overdrawn),
    eq("sources total", "sources.totalReceived", src.totalReceived, "finance.total", f.total),
    flag("sources matchesFinance", src.matchesFinance, `matchesFinance ${src.matchesFinance} (financeTotal ${fmt(src.financeTotal)})`),
    eq("sources expired", "sources.expiredTokens", src.expiredTokens, "finance.expired", f.expired),
    eq("spend used", "spend.used", s.used, "finance.used", f.used),
    // one balance (pools were deleted, migration 067): the Bank's balance is what finance says is left in it
    eq("bank balance", "bank.balanceTokens", bank.balanceTokens, "finance.leftBank", f.leftBank),
    // the runway nets one inflow rule (gr_rdzg83m0al): the Bank's expected inflow is the projection's
    eq("daily inflow", "finance.projection.dailyInflow", f.projection?.dailyInflow, "bank.dailyInflowTokens", bank.dailyInflowTokens),
    eq("net per day", "finance.projection.netDailyBurn", f.projection?.netDailyBurn, "trailingDailyBurn − dailyInflow", f.projection?.trailingDailyBurn - f.projection?.dailyInflow),
    // Fly hosting (USD): the days' and the buildings' desk time agree, each day's desks + town = its total
    flag("fly sumCheck", fly.sumCheck?.ok, `ok ${fly.sumCheck?.ok}, diff ${fly.sumCheck?.diff} (${fly.sumCheck?.identity})`),
    eq("fly desk time", "Σ fly.days[].deskMs", sum((fly.days ?? []).map((d: Json) => d.deskMs)), "Σ fly.buildings[].deskMs", sum((fly.buildings ?? []).map((b: Json) => b.deskMs))),
    near("fly totals", "Σ fly.days[] (desk + town)", sum((fly.days ?? []).map((d: Json) => d.deskUsd + d.townUsd)), "fly.totals.totalUsd", Number(fly.totals?.totalUsd), 1e-4),
  ];
}

async function get(path: string): Promise<Json> {
  const res = await fetch(base + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as Json;
}

async function main(): Promise<number> {
  const health = await get("/api/health").catch((e: Error) => ({ commit: `unknown (${e.message})` }));
  let round = 0, bodies: Json[] = [], result: Check[] = [];
  while (round < 3) {
    round++;
    bodies = await Promise.all(["/api/finance", "/api/finance/spend", "/api/finance/sources", "/api/bank", "/api/finance/fly"].map(get));
    const [f, s, src, bank, fly] = bodies as [Json, Json, Json, Json, Json];
    result = checks(f, s, src, bank, fly);
    if (result.every((c) => c.ok)) break;
  }
  const [f, s, src, , fly] = bodies as [Json, Json, Json, Json, Json];
  console.log(`${base}: commit ${String(health.commit).slice(0, 7)}${round > 1 ? `, round ${round} of 3` : ""}`);
  console.log(`at: finance ${f.at}, spend ${s.at}, sources ${src.at}, fly ${fly.at}`);
  console.log(`fly today ${fly.today?.day}: desks $${Number(fly.today?.deskUsd).toFixed(2)} + town $${Number(fly.today?.townUsd).toFixed(2)} = $${Number(fly.today?.totalUsd).toFixed(2)}; last ${fly.windowDays} days $${Number(fly.totals?.totalUsd).toFixed(2)} (desk time ${(Number(fly.totals?.deskMs) / 3_600_000).toFixed(1)} h, ${fly.totals?.sessions} sessions)`);
  for (const c of result) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.line}`);
  const failed = result.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} of ${result.length} checks failed` : `all ${result.length} checks ✓`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e: Error) => { console.error(`✗ ${base}: ${e.message}`); process.exit(1); });
