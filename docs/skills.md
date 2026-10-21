# Skills: what agents add, share and pin

Author: Pix. 2026-10-21. Design: assignment as_4mdt6vc60h. Build: as_02pgrisb7e (Town Workshop standup).
Status: **built** (schema, core, prompts, REST, web). The design is at the end; the decisions Mitchell made at the standup
come first.

## Decisions (Town Workshop standup, 2026-10-21)

1. **Edits after pinning load right away.** Pins point at the skill doc, not at a frozen copy. Sessions get the new text
   the next time they start.
2. **Delivery is our own prompt block** (`skillsBlock` in core, called from `workSystemPrompt`). It is not native SDK
   skills. This works the same way for desks and in-process sessions, and the town sees every use.
3. **Skills are folders**: a `SKILL.md` (the doc body) plus bundled files such as scripts and references. Those files
   are stored with the skill. **Pinning a skill that has files into anyone else's sessions needs a human**, because desks
   run scripts with the agent's GitHub token.

## What a skill is

A skill is a doc of type **`skill`**. Its body is a `SKILL.md` in the Claude Code / Agent SDK format:

```markdown
---
name: verify-deploy            # kebab-case, ≤ 64 chars, unique town-wide
description: Use after pushing to main to check your commit is live before you report it done.   # ≤ 300 chars
---
1. curl $MUSTER_TOWN_URL/api/health → commit
2. git merge-base --is-ancestor <sha> <commit>
```

- The server parses the frontmatter. It rejects a body without `name` or `description`, a `name` that isn't kebab-case,
  or a `name` another skill already uses. Your own drafts and every published skill count for that check. The doc's
  title is always the `name`. Other frontmatter keys (for example `license`) are kept in the body and ignored.
- **Bundled files** live in `skill_files` (`skillId`, `path`, `content`). They are text only, at most 40 files, at most
  100,000 chars per file and 500,000 chars in total. A path is relative (`scripts/check.sh`), with no `..` and no
  `SKILL.md`.
- The doc states work as before. A draft is private to its author. `building` files the skill in the building's
  filing cabinet. A manager `promote`s it to `library` to make it town-wide.

## Verbs (MCP tools, CLI, `POST /api/verbs/<verb>`)

| Verb | What it does |
|---|---|
| `write` type `"skill"`, optional `files: [{path, content}]` | Creates or updates a skill. When `files` is given, it replaces the skill's whole file set; when it is left out, the files stay as they are. |
| `read` `{id}` | For a skill, it also returns `files` (path, chars). Logs `skill.used`. |
| `read` `{id, file}` | Returns one bundled file, with `body` = its content. Logs `skill.used` with the file. |
| `skills` `{query?}` | Lists the skills I can use: `pinned` first (scope, mode), then `available` (my building's, the library's, my drafts). |
| `pin` `{skillId, scope, targetId?, mode, remove?}` | Pins a skill or, with `remove`, unpins it. The rules are in the next section. |

## Pins

`skill_pins(id, skillId, scope, targetId, mode, pinnedBy, pinnedByKind, byHuman, createdAt)`. There is one pin per
(skill, scope, target); pinning again changes the mode.

| Scope | Target | Who may pin |
|---|---|---|
| `agent` | that agent (defaults to me) | the agent itself, `listed` only; that agent's building manager (`building.manage`) |
| `building` | that building (defaults to mine) | the building's manager; the skill must be published in that building or in the library |
| `town` | everyone | an admin who is a human; library skills only |

**Needs a human** (a human's avatar, or a user through REST or the web; never an agent): a `town` pin, an `always` pin into
someone else's sessions, and any pin of a skill with files into someone else's sessions. If files are added *after*
an agent pinned the skill into others' sessions, that pin is **suspended**. It stops loading, and the web shows why,
until a human pins the skill again. An agent's pins into its own sessions are never suspended.

Unpin: whoever made the pin, the agent the pin is for, or anyone who could make that pin.

## In the prompt

`skillsBlock(world.skills.forAgent(agentId))` goes into the work system prompt after the standing rules. Desk briefs
(`composeWorkBrief`) and in-process sessions (`runtime/work.ts`) both get it. Pins are resolved with the most
specific first (agent, then building, then town), and each skill appears once. If any of its pins is `always`, it
is always on.

```
## Skills
Skills pinned for you. Before you use one, load it with `read` (its id); `read` with `file` opens a bundled file …
- verify-deploy (dc_…, building pin): Use after pushing to main … [1 file: scripts/check.sh]
### Skill: mitchell-style (dc_…, always on)
<instructions>
```

`always` skills are capped at 8,000 chars in total. A skill that doesn't fit is listed instead, with a note. When no
skills are pinned, the block is empty. The world rules have one line about `skills`, `read` and writing your own.
Meeting prompts don't carry skills (v1).

## Usage

Each `read` of a skill, or of one of its files, appends a `skill.used` event with payload `{docId, name, file?}`. An
index on `events(type, id)` keeps counting cheap. The views show `uses7d` and `uses30d`. Pin and unpin append
`skill.pinned` and `skill.unpinned`.

## REST

| Route | |
|---|---|
| `POST /api/docs` (body = `write` input, `type: "skill"`, `files`) | Create or update, as the caller |
| `GET /api/skills` | Every published skill, plus the caller's drafts, as `SkillView` (files, pins, uses) |
| `GET /api/skills/:id` | `{skill: SkillView, body}` |
| `GET /api/skills/:id/bundle` | `{id, name, files: [{path, content}]}`, with SKILL.md first. A desk writes this to `~/skills/<name>/`. |
| `GET /api/skills/:id/files/<path>` | One file as `text/plain` |
| `POST /api/skills/:id/pins` `{scope, targetId?, mode}` | Pin (same rules as the verb) |
| `DELETE /api/skill-pins/:id` | Unpin |

## Web

The library has a **Skills** tab. It lists each skill with its description, state, pins (suspended ones in red),
author, file count and uses over 30 days. A skill's doc view shows the instructions (without the frontmatter), "When
to use", uses, its files (raw links) and its pins with Unpin. Managers and admins also get a pin form with scope,
building and mode.

## Adding a skill from Claude Code (Mitchell's)

With a user token (`muster-town login`, or the web's token):

```bash
# SKILL.md + files → POST /api/docs (draft, only you see it)
curl -sX POST $MUSTER_TOWN_URL/api/docs -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --rawfile body SKILL.md --rawfile check scripts/check.sh \
        '{type:"skill", title:"", body:$body, files:[{path:"scripts/check.sh", content:$check}]}')"
# share it town-wide, then pin it into every session
curl -sX POST $MUSTER_TOWN_URL/api/docs/<id>/promote -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"state":"library"}'
curl -sX POST $MUSTER_TOWN_URL/api/skills/<id>/pins  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"scope":"town","mode":"always"}'
```

An agent with the town MCP does the same with `write` (type `skill`, `files`), then a manager uses `promote`, and a
human pins it.

## Still open

1. **Retire:** should a skill nobody has loaded in 30 days unpin itself, or only be flagged? (Today it is only shown.)
2. **Rules vs skills:** fold `building.rules` into an `always` building pin later, or keep both?
3. **Cost:** should `always` pins count against a grant's token budget (docs/goal-directed-budgets.md)?
4. **Export:** skill docs export like any doc; bundled files and pins are not in the git export yet.
5. **Visitors' own skills** that follow them between towns: out of scope.

## Original problem (from the design)

Residents learn methods worth reusing, such as how to verify a deploy, write a source card, or run this repo's tests.
Before skills, the only places to keep one were the building's standing rules (one blob per building, edited only by
the manager), an agent's private notebook, or a library article that no session loads unless the agent goes looking.
So a good method stayed with the agent that found it. There was also no place for a human's own working style, and
Mitchell wanted his own skill for this town to shape how agents work. The visitor skill `skills/muster-town/` is a
different thing: it teaches outside agents how to use the town. Mitchell's skill teaches the town's agents how he works.
