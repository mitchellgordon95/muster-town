// Live finance check: fetches the four public finance endpoints of a running town and re-checks every identity, within
// each endpoint and across them, from the returned numbers. Read-only. Exits 1 when any check fails.
// Run from the repo root: `npm run check:finance` (https://muster.town) or `npm run check:finance -- http://localhost:3000`.
// The four reads are not one snapshot: a debit landing between them shifts used/left, so a round whose cross-endpoint
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

/** Every check, from the four bodies alone. */
function checks(f: Json, s: Json, src: Json, p: Json): Check[] {
  const ob = f.overdrawnBreakdown ?? {};
  return [
    flag("finance sumCheck", f.sumCheck?.ok, `ok ${f.sumCheck?.ok}, diff ${fmt(f.sumCheck?.diff)} (${f.sumCheck?.identity})`),
    flag("spend check", s.check?.ok, `ok ${s.check?.ok}, diff ${fmt(s.check?.diff)} (${s.check?.identity})`),
    flag("sources sumCheck", src.sumCheck?.ok, `ok ${src.sumCheck?.ok}, diff ${fmt(src.sumCheck?.diff)} (${src.sumCheck?.identity})`),
    flag("pools drawsOk", p.sumCheck?.drawsOk, `ok ${p.sumCheck?.drawsOk}, diff ${fmt(p.sumCheck?.drawsDiff)}`),
    flag("pools balanceOk", p.sumCheck?.balanceOk, `ok ${p.sumCheck?.balanceOk}, diff ${fmt(p.sumCheck?.balanceDiff)}`),
    eq("finance identity", "used + expired + left", f.used + f.expired + f.left, "total + overdrawn", f.total + f.overdrawn),
    eq("overdrawn parts", "Σ overdrawnBreakdown",
      sum([ob.durableOvershoot, ob.subscriptionOverdrawn, ob.deletedCreditDebits, ob.allocationOverspent].map(Number)), "overdrawn", f.overdrawn),
    eq("sources total", "sources.totalReceived", src.totalReceived, "finance.total", f.total),
    flag("sources matchesFinance", src.matchesFinance, `matchesFinance ${src.matchesFinance} (financeTotal ${fmt(src.financeTotal)})`),
    eq("sources expired", "sources.expiredTokens", src.expiredTokens, "finance.expired", f.expired),
    eq("spend used", "spend.used", s.used, "finance.used", f.used),
    eq("pools usedBank", "pools.usedBank", p.usedBank, "finance.usedBank", f.usedBank),
    eq("pools building draws", "Σ pools.buildings[].drawn", sum((p.buildings ?? []).map((b: Json) => b.drawn)), "pools.usedBank", p.usedBank),
    eq("pools balance", "pools.balanceTokens", p.balanceTokens, "finance.leftBank", f.leftBank),
    eq("pools overshoot", "pools.overshootTokens", p.overshootTokens, "finance durableOvershoot", ob.durableOvershoot),
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
    bodies = await Promise.all(["/api/finance", "/api/finance/spend", "/api/finance/sources", "/api/finance/pools"].map(get));
    const [f, s, src, p] = bodies as [Json, Json, Json, Json];
    result = checks(f, s, src, p);
    if (result.every((c) => c.ok)) break;
  }
  const [f, s, src, p] = bodies as [Json, Json, Json, Json];
  console.log(`${base}: commit ${String(health.commit).slice(0, 7)}${round > 1 ? `, round ${round} of 3` : ""}`);
  console.log(`at: finance ${f.at}, spend ${s.at}, sources ${src.at}, pools ${p.at}`);
  for (const c of result) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.line}`);
  const failed = result.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} of ${result.length} checks failed` : `all ${result.length} checks ✓`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (e: Error) => { console.error(`✗ ${base}: ${e.message}`); process.exit(1); });
