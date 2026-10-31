# Bounties: a goal with tokens attached, looking for a captain

Status 2026-10-31: design only, nothing built. From Mitchell's 1:1 mt_3jtclcoxl2 (~20:20Z): "home page has two tabs.
Collectives looking for funding (what currently exists). But then let's accept bounties of tokens with a goal
attached, looking for a captain (humans are captains now, fits the muster theme). The second tab can be the
looking-for-captains (I'm thinking like, looking for people with Climate Science backgrounds)."

"Captain" is the word for a human who owns a goal node (`goals.ownerId`). The code rename owner → captain is a separate
assignment; this doc uses "captain" throughout.

## 1. The two home tabs

The homepage (server `home.ts` `renderHome`, web `home/main.tsx`) gets two tabs above the tile list. They are plain
server-rendered links (`/` and `/?tab=captains`), so they read without JS.

**Collectives looking for funding** (the default, today's list). One tile per collective, as `Tile` in
`home/HomeCard.tsx` and `tile()` in `home.ts`: name, live preview, the goal under it. Added: one line
**"N free tokens"** (core `freeTokens(world, rootGoalId)`, read through `hub.world(slug)`) and a **Donate** link to that
collective's Bank. Collectives with an open bounty are not listed here.

**Looking for a captain.** One card per open bounty, newest first:
- the goal (the bounty's text, 300 chars at most), as the title;
- **Wanted:** what the captain should bring ("Climate Science background");
- **N tokens** and, under it, "posted by <GitHub name>";
- **"Closes in N days"**, and "N asks" once anyone has asked;
- **Captain this**, the one button. Signed out, it goes through GitHub sign-in and comes back to the card, like
  `StartCard`'s `#start`.

## 2. A bounty

**Who posts: anyone signed in with GitHub (recommended).** This follows the rule for Start a collective
(hosted-collectives.md, mt_6830h8x5qk): a bounty spends only the poster's own key, so nobody else's money is at risk.
Limit: 3 open bounties per GitHub id, and a town admin has no cap (the same shape as `HOSTED_PER_PERSON`).

**Fields** (a **Post a bounty** form on the Captains tab, a paper card like `StartCard`):
- **Goal** (required, 300 chars at most). It becomes the root goal of the collective the bounty creates.
- **Wanted** (required, 200 chars at most). Free text describing who should captain it.
- **Tokens** (required, from 500,000 to 50,000,000 adjusted tokens), shown with today's price per million.
- **Anthropic API key** (required, checked by `apiKeyProblem`). A bounty without a key is a promise with nothing
  behind it, and hosted collectives never spend the host's credential.
- **Closes** (optional; default 30 days, at most 90).
- **Address** (optional): the slug, which defaults to one made from the goal.

**Where the tokens sit: in the Bank of the bounty's own collective, created at posting time.** Posting runs the
existing `Hub.create` path with three changes: no buildings, the poster as its admin, and the key as its one Bank
input (`bank.addInput`, source `api-key`, `tokens` = the bounty's tokens in place of `STARTER_KEY_TOKENS`). Its hub
row is linked to a `bounties` row in state `open`, and its runtime is not started. Reasons:

- The post-mortem rule dc_bq7yfn5dr8 says the Bank is the only place a credential lives. A key held in a hub-level
  `bounties` table would break that rule.
- Nothing can spend while the bounty is open: the collective has no buildings and no runtime. This is the escrow: a cap on the poster's own key, billed by Anthropic only when work runs.
- Not `bank_reservations` (migration 067): a reservation claims free tokens under a goal *inside* a World for one exploration session; a bounty precedes any World.

**If nobody takes it.** At the closing date the hub retires the collective (`Hub.retire`: the slug is kept, the
`/<slug>/` page shows the 410 notice) and `bank.cancelInput` wipes the stored key. The bounty row
stays with state `expired` and is listed under "Closed" on the Captains tab. The poster can **Withdraw** at any time
before it is captained, which does the same with state `withdrawn`.

## 3. Captain this

**The ask.** A signed-in GitHub user presses Captain this and writes one **pitch** (1,000 chars at most: their
background, links, what they would do first). This is the Ask-to-own request of gr_bwm0iz7rwl / kr_j1w17nw178, aimed
at the root goal of the bounty's collective. The asker becomes a `visitor` there, as on any first visit
(hosted-collectives.md step 2), and their request is routed to the node's captain. Until a captain is accepted, that
is the poster. Several people may ask, one pending ask each.

**Who accepts: the poster**, from the Town Hall in-tray of the bounty's collective. Each ask is a row ("Ask to
captain: <name>"), and in Review as deck each ask is one slide with the name, GitHub avatar and link, the pitch, and
**Accept / Decline**. The poster is that collective's admin, so this uses the in-tray and deck that already exist
there. The homepage card shows the poster "N asks: review" as a link into that in-tray.

**What accepting does (recommended: the bounty's own collective, already made, becomes the captain's).**
- The captain gets `admin` in that World, and the root goal gets `ownerId` = the captain's user.
- The hub row's `ownerGithubId` becomes the captain's. The poster stays as a member, and the key input stays
  theirs: they can cancel it at the Bank at any time, like any donor.
- The bounty becomes `captained`. Every other pending ask is declined with a notice, the runtime starts, and the
  collective moves to the Funding tab.

**Why not attach the bounty to an existing collective.** That would put a stranger's key into another collective's
Bank, controlled by that collective's admins instead of the captain. A new collective keeps one key in one Bank with one
captain; `Hub.create`, `addInput`, `ownerId` and the in-tray already exist.

## 4. Data model and API

The hub's `hub.db` has no migration runner: `Hub` runs `CREATE TABLE IF NOT EXISTS`. The one new table is additive in
the same way. No World migration is needed: Ask to own brings its own table (gr_bwm0iz7rwl), and the bounty World uses
the existing tables.

```sql
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,              -- bn_…
  slug TEXT NOT NULL UNIQUE,        -- the bounty's collective (collectives.slug)
  goal TEXT NOT NULL,
  wanted TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  posterGithubId TEXT NOT NULL,
  posterName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  closesAt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','captained','withdrawn','expired')),
  captainGithubId TEXT,
  decidedAt TEXT
);
```

There is no key column: the key lives in the bounty World's `bank_inputs`. Asks live in that World's Ask-to-own table.
The hub only counts them (a new read on the Ask-to-own table) for the card.

Schema (`packages/schema`): `Bounty`, `PostBountyInput`, `CaptainAskInput`; `Collective` gains `freeTokens?`.

Routes (root app, `app.ts`, next to `POST /api/collectives`):
- `GET /api/bounties?state=open|closed`: public, the card fields only.
- `POST /api/bounties`: GitHub sign-in required, with the per-person cap. Returns 201 and `{bounty, url}`. The key
  is never in the reply.
- `POST /api/bounties/:id/withdraw`: the poster or a town admin.
- `POST /api/bounties/:id/asks`: GitHub sign-in required. Forwards to the bounty World's Ask to own on its root goal.
- Accept and decline go through that World's existing in-tray decision route from gr_bwm0iz7rwl. On accept, a hub
  hook (`Hub.captained(slug, githubId)`) flips the hub row and the bounty and starts the runtime.
- Expiry: a once-an-hour sweep in the hub retires bounties whose `closesAt` has passed.

## 5. Build order

Each step is one PR, with tests and docs, merged green and redeployed under dc_vzqoh7ppen.

1. **Ask to own** (gr_bwm0iz7rwl, already proposed): the request, in-tray row, deck slide and accept setting
   `ownerId`. Bounties depend on it.
2. **Home tabs**: the Funding tab with "N free tokens" and Donate on each tile, and an empty Captains tab ("No
   bounties yet"). No new tables.
3. **Post a bounty**: the `bounties` table, `POST /api/bounties`, `Hub.create` with no runtime and the key as an input
   for the bounty's tokens, the Captains tab cards, Withdraw. **This is a Bank-touching change: ask Mitchell first**
   (merge rules).
4. **Captain this**: the ask from the card, the poster's in-tray and deck in the bounty World, `Hub.captained`,
   moving to the Funding tab.
5. **Expiry**: the hourly sweep (`Hub.retire` + `cancelInput`) and the "Closed" list.
6. **Live check** with two GitHub accounts in private windows: post → ask → accept → the captain opens Planning →
   New building and the first session runs on the poster's key. Then add a "Bounties" section to the manual.

## 6. Open questions for Mitchell

1. **Who posts.** Is any signed-in GitHub user right (recommended), or admins only at first?
2. **Whose key.** A bounty is backed only by the poster's own API key (recommended, since hosted collectives never
   spend the host's credential). Should the Workshop also be able to post bounties from its own Bank? That would mean a
   subscription token funding another collective, which the hosted-collectives terms rule out today.
3. **Poster after accept.** Should the poster drop to member (recommended, so the captain steers) or stay admin
   alongside the captain?
4. **Caps.** Does a captained bounty count toward the captain's "one collective per person" cap (recommended: no)?
   Are 3 open bounties per poster and 500k–50M tokens the right limits?
5. **Wanted.** Is free text enough, or do you want tags (e.g. "climate science") to filter the Captains tab?
