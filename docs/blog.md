# The muster.town blog

The root app (muster.town, not hosted collectives) serves a blog from markdown files in this repo. Code: `packages/server/src/blog.ts`.

| URL | What it serves |
|---|---|
| `/blog` | The index: title, date, author and summary of each public post, newest first ("No posts yet." when there are none). |
| `/blog/<slug>` | One post, rendered server-side with `marked`, with its title, description, canonical, Open Graph and Twitter tags. An unknown slug is a 404 page. |
| `/blog/feed.xml` | An Atom feed of the public posts. |

`blog` is a reserved slug (`RESERVED_SLUGS` in `packages/schema/src/index.ts`), so no hosted collective can take `/blog`.

## Writing a post

1. Add `blog/posts/<slug>.md`. The slug is the file name: lowercase letters, digits and dashes.
2. Start it with front matter:

   ```
   ---
   title: Hello from Muster Town
   date: 2026-11-12
   author: Mitchell Gordon
   summary: One or two sentences: the index, the feed and link previews show it.
   draft: true
   ---
   ```

   `title` and `date` (YYYY-MM-DD) are required; a file without them is not served. `summary` becomes the page's description and preview text.
3. Write the post in markdown below the front matter. Posts are written by us and committed here, so their HTML is not sanitized.

## Drafts and publishing

- `draft: true` serves the post at `/blog/<slug>` (marked as a draft on the page) but leaves it out of `/blog` and the feed. Use it to preview a post live.
- To publish, remove the `draft` line (or set `draft: false`) and merge. Files are read per request, so the post shows once the commit is deployed, without a restart.

## The email signup

Every post page and the index end with a one-field signup form ("New posts by email. Nothing else."), `signup()` in `blog.ts`. It posts JSON to `POST /api/blog/subscribe` (`packages/server/src/mailing-list.ts`): public, no sign-in; the address is trimmed, lowercased and checked (one @, a dot in the domain, no spaces, at most 254 characters, else 400); a repeat answers ok like the first time; a filled hidden `website` field (the honeypot) is dropped silently; each client IP may post 10 times an hour (then 429 `rate_limited`). With the mail sender on (below) it is double opt-in.

The list is the `mailing_list` table (migration 112) in the town's SQLite database, so it is in Prod's backups with everything else. An admin reads it:

```sh
curl -H "Authorization: Bearer $TOKEN" https://muster.town/api/blog/subscribers            # {count, subscribers: [{email, createdAt, source}]}
curl -H "Authorization: Bearer $TOKEN" "https://muster.town/api/blog/subscribers?format=csv" -o subscribers.csv
```

`source` is the post slug the form was on, or `index`. `confirmed` (CSV `yes`/`no`) says whether the address has confirmed; the JSON also has the `confirmed` count.

## Confirmation and unsubscribe emails (Resend)

`packages/server/src/mail.ts` sends through Resend's HTTP API (`POST https://api.resend.com/emails`, fetch, no SDK). Two host secrets, read at boot (docs/secrets.md):

- `RESEND_API_KEY`: a Resend key with **Sending access** only, restricted to the sending domain.
- `BLOG_MAIL_FROM`: the From line, on the domain verified in Resend, e.g. `Muster Town <blog@mail.muster.town>` (default `Muster Town <blog@muster.town>`).

**Without `RESEND_API_KEY`** nothing is sent and a signup is confirmed at once (single opt-in), as before.

**With it** (migration 114 added `confirmedAt`, `confirmToken`, `unsubscribeToken`; rows from before it were back-filled as confirmed):

- A new address is stored unconfirmed and gets one email, "Confirm your signup to the Muster Town blog", with `GET /api/blog/confirm?token=…`. The form then says "check your inbox". A repeat while unconfirmed sends the same link again; a repeat of a confirmed address sends nothing. If Resend refuses or is down, the signup answers 500 and the row stays, so a retry sends the link.
- The confirm link marks the row confirmed and shows a plain "You're in" page; a used or unknown token is a 404 page.
- Every email carries `GET /api/blog/unsubscribe?token=…` in its body and in a `List-Unsubscribe` header with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so a mail client's unsubscribe button POSTs to the same URL (RFC 8058). One click sets `unsubscribedAt`; signing up again needs a new confirmation.
- Sending posts to the list is not built yet: a send must include each row's unsubscribe link.
