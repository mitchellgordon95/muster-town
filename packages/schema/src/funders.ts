import type { FunderSessionLine, FunderWeek } from "./index.ts";
import type { ReviewSlide } from "./deck.ts";

/**
 * The funder filter's deck slide (docs/goals.md "Funder attribution", goal tree build step 8): pure over a FunderWeek
 * (core `funderWeek` builds one from the world), so the server and the web's mock render the same slide.
 */
const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function sessionText(l: FunderSessionLine): string {
  const where = [l.buildingName, l.keyResultText ? `KR ${l.keyResultId}: ${l.keyResultText}` : null].filter(Boolean).join(" · ");
  return `- ${l.at.slice(5, 16).replace("T", " ")} · **${fmt(l.tokens)}** · ${l.title}${where ? ` · ${where}` : ""}${l.reportId ? ` · report ${l.reportId}` : ""}`;
}

/** The funder filter's slide 1: "Your week as a funder", in place of the state of the town (0 tokens, assembled live). */
export function funderSlide(w: FunderWeek): ReviewSlide {
  const streams = w.streams.map((s) => `- **${s.label}** (${s.source === "api-key" ? "API key" : "subscription"}${s.goalPath ? `, earmarked for ${s.goalPath}` : ", general"}${s.cancelledAt ? ", cancelled" : ""}) · balance ${fmt(s.balance)} · ${s.story === "literal" ? `ran ${s.sessions} session${s.sessions === 1 ? "" : "s"}, ${fmt(s.tokens)}` : `credited ${fmt(s.creditedTokens)}`} this window`);
  const lit = w.literal.sessions;
  const p = w.proRata;
  const text = [
    `# Your ${w.days === 7 ? "week" : `${w.days} days`} as a funder: ${w.userName}`,
    `_${w.from.slice(0, 10)} to ${w.to.slice(0, 10)} · adjusted output tokens · read from session rows, nothing booked_`,
    `## Your streams\n${streams.length ? streams.join("\n") : "_You have no Bank input. Donate at the Bank to fund work._"}`,
    `## Sessions that ran on your key (${lit.length}, ${fmt(w.literal.tokens)})\n${lit.length ? lit.map(sessionText).join("\n") : "_None this window._"}`,
    p.share > 0
      ? `## Your share of the pooled week (${pct(p.share)}, ${fmt(p.tokens)})\nYou credited ${fmt(p.yourCreditedTokens)} of the window's ${fmt(p.poolCreditedTokens)} subscription tokens, so ${pct(p.share)} of the ${p.poolSessions} sessions that ran on no donated key (${fmt(p.poolTokens)}) is yours. What it bought, biggest first:\n${p.byAssignment.map(sessionText).join("\n")}`
      : "",
    "The decision slides after this one are the items under the goals your money reached.",
  ].filter(Boolean).join("\n\n");
  return { text, notes: "", title: "Your week as a funder", pictures: [], key: `funder:${w.userId}`, kind: "funder", itemId: null, group: 0, buildingId: null, since: null, waiters: 0, history: "" };
}
