# Agent Guidelines — Carbon Cycle Lab

This is the agent entry point for this building. Read this file first.

**CONTEXT RECOVERY:** If your context was compacted, re-read this file before doing any work.

## Team

- **Mitchell (owner)** — runs the lab, reads every run report, decides whether each desk continues.
- **Desk agents** — one per research direction (see `building.json`). Each has a persona name; you are the one named in your run prompt.
- **Ada (librarian)** — answers visitors' questions from the wiki and reports. Read-only.

## Project Context

This building studies the global carbon cycle: how CO2 moves between atmosphere, land, ocean, and human activity. The purpose is understanding, not advocacy. The output is a wiki that a curious, technically literate person can read to get the real numbers, the real uncertainties, and where the open questions are.

Mitchell already has a separate knowledge base on carbon dioxide *removal* methods (DAC, ocean alkalinity, biochar, etc.). This building is upstream of that: the natural cycle and the anthropogenic perturbation. Don't duplicate removal-method research here.

## How work happens here

Work is done in **runs**. A run is one focused sprint by one desk agent. Every run ends with a **report** in `reports/<desk>/run-NNN.md`. Mitchell reads the report and decides: approve (continue as proposed), redirect (continue with a note), or stop. No desk continues without a decision. The report is the interface between the agents and the human, so it has to be readable in two minutes and concrete about what happens next.

## Standing Rules

### 1. Sources first, three voices separated
Every external fact traces to a source card in `sources/<slug>.md` (URL, date accessed, what it says, then your analysis under a separate heading). Never blend what a source says, what Mitchell thinks, and what you (the agent) conclude. Mark your own synthesis as agent analysis.

### 2. Numbers carry units and uncertainty
Fluxes in GtC/yr or GtCO2/yr (say which; 1 GtC = 3.664 GtCO2). Give the published uncertainty range when one exists. Give the year the number applies to.

### 3. Your desk article is yours; main.md is shared
Keep `wiki/desks/<desk>.md` as the running article for your direction. Promote building-wide findings to `wiki/main.md` under Current State or as a numbered Open Problem. Don't edit other desks' articles or reports. If you find something relevant to another desk, write it in your report under "For other desks".

### 4. Open problems are the to-do list
Each `### Open Problem N` in `wiki/main.md` ends with a `**Next (Open Problem N):**` line naming the desk that owns the move. `wiki/next-actions.md` is just an index of those.

### 5. Cross-link every new file
A new file gets links from `wiki/main.md` or your desk article, and from any related source card. No orphan files.

### 6. Log briefly, append only
Append at most 3 lines to `log/week_of_<monday>.md` after a run. Never rewrite a log file.

### 7. The report is the deliverable
A run that produces no report is a failed run. The report format is fixed (see `reports/README.md`). The proposal section must name one concrete question for the next run, why it matters, and what sources you intend to use. If the direction is exhausted or wrong, say so: verdict `stop` with a post-mortem.

### 8. Depth over breadth
One run, one question. Three well-sourced paragraphs beat a page of unsourced bullets.

## Wiki Entry Points

- `wiki/main.md` — master article: overview, current state, open problems.
- `wiki/next-actions.md` — index of open problems with live next moves.
- `wiki/desks/` — one article per desk.
- `sources/` — source cards.
- `reports/` — run reports, one folder per desk.
- `log/` — weekly append-only logs.
