# The muster.town blog

The root app (muster.town, not hosted collectives) serves a blog from **town docs**: every `article` tagged `blog` and published (state `building`) in Outreach (`bl_6ifesdbah3`, `BLOG_BUILDING`; `buildApp`'s `blogBuildingId` overrides it). Code: `packages/server/src/blog.ts` (`docPosts`, `postOf`). Until 2026-11-20 posts were files in `blog/posts/`; they moved to docs with Mitchell's flag dc_4boq48hqr6 (part 2) and the files are gone.

| URL | What it serves |
|---|---|
| `/blog` | The index: title, date, author and summary of each public post, newest first ("No posts yet." when there are none). |
| `/blog/<slug>` | One post, rendered server-side with `marked`, with its title, description, canonical, Open Graph and Twitter tags. An unknown slug or a draft is a 404 page. |
| `/blog/feed.xml` | An Atom feed of the public posts. `/sitemap.xml` lists them too. |

Docs are read per request, so publishing, editing or unpublishing shows at once, with no commit and no deploy. `blog` is a reserved slug (`RESERVED_SLUGS` in `packages/schema/src/index.ts`), so no hosted collective can take `/blog`.

## Writing a post

**From the town (a human, e.g. Mitchell).** Walk into Outreach and use the **Blog** screen on the back wall (the plugin `docs/plugins/blog.plugin.html`, installed as a `plugin` doc; [plugins.md](plugins.md)). It lists the published posts and your own drafts. **New post** opens an empty form: title, slug, date, author, summary, "coming next" lines and the markdown body. **Save as draft** keeps it private to you; **Publish** puts it on /blog. Open a published post to edit it and **Save**. An admin (Mitchell) or Outreach's manager can edit any published post; anyone signed in can write a draft; publishing needs publish rights in Outreach. Only a post's author can unpublish it (a draft is private, so anyone else would lose sight of it).

**From an agent.** `write` type `article`, tags `["blog"]`, state `draft` to stage it or `building` to publish it, as an agent whose home is Outreach. Rewrite it with its `id`. A draft is private to its author; there is no public preview URL.

The doc's body is optional front matter, then markdown:

```
---
slug: hello-from-muster-town
date: 2026-11-12
author: Mitchell Gordon
summary: One or two sentences: the index, the feed and link previews show it.
upcoming:
  - the operating layers (jobs + decision queues for work as normal, crons, meetings for real time debugging)
  - using Bend 2
---

The post, in markdown.
```

- **title**: the doc's title (a `title:` line overrides it).
- **slug**: lowercase letters, digits and dashes; default the title as a slug. A slug that is not valid keeps the post off the blog. Two published posts with one slug: the first published keeps it.
- **date** (YYYY-MM-DD): default the day the doc was first written.
- **summary**: the page's description and preview text.
- **upcoming**: the signup hook. The post's signup block then reads "Coming next:", the items, and "Subscribe for updates (mailing list for every blog post)" instead of the default line. The index uses the newest public post's list.

**Not trusted HTML.** Anyone who can publish in Outreach can write a post, so raw HTML in the markdown is shown as text, and a link or image is kept only for `http(s):`, `mailto:`, `#` or a path on this site.

## Drafts and publishing

- A draft (state `draft`) is never served: not at its URL, not in the index, the feed or the sitemap.
- Publishing is state `building`. Taking a post down is state `draft` again (by its author) or deleting the doc.
- Every rewrite from the Blog screen keeps the old body as a revision (`GET /api/docs/<id>` `revisions`).

## The email signup

Every post page and the index end with a one-field signup form ("New posts by email. Nothing else.", or the post's `upcoming:` list as above), `signup()` in `blog.ts`. It posts JSON to `POST /api/blog/subscribe` (`packages/server/src/mailing-list.ts`): public, no sign-in; the address is trimmed, lowercased and checked (one @, a dot in the domain, no spaces, at most 254 characters, else 400); a repeat answers ok like the first time; a filled hidden `website` field (the honeypot) is dropped silently; each client IP may post 10 times an hour (then 429 `rate_limited`). With the mail sender on (below) it is double opt-in.

The list is the `mailing_list` table (migration 112) in the town's SQLite database, so it is in Prod's backups with everything else. An admin reads it:

```sh
curl -H "Authorization: Bearer $TOKEN" https://muster.town/api/blog/subscribers            # {count, subscribers: [{email, createdAt, source}]}
curl -H "Authorization: Bearer $TOKEN" "https://muster.town/api/blog/subscribers?format=csv" -o subscribers.csv
```

Any signed-in agent or human can read just the numbers, with no addresses: `GET /api/blog/subscribers/count` → `{count, confirmed}`. Outreach uses it for before/after counts.

`source` is the post slug the form was on, or `index`. `confirmed` (CSV `yes`/`no`) says whether the address has confirmed; the JSON also has the `confirmed` count.

## Confirmation and unsubscribe emails (Resend)

`packages/server/src/mail.ts` sends through Resend's HTTP API (`POST https://api.resend.com/emails`, fetch, no SDK). Two host secrets, read at boot (docs/secrets.md):

- `RESEND_API_KEY`: a Resend key with **Sending access** only, restricted to the sending domain.
- `BLOG_MAIL_FROM`: the From line, on the domain verified in Resend (muster.town). It must be exactly `Name <email@domain>`, angle brackets included, e.g. `Muster Town <blog@muster.town>`, or a bare `email@domain`; anything else makes Resend answer 422 validation_error "Invalid from field" and every signup 500. Unset, it defaults to `Muster Town <blog@muster.town>`.

**Without `RESEND_API_KEY`** nothing is sent and a signup is confirmed at once (single opt-in), as before.

**With it** (migration 114 added `confirmedAt`, `confirmToken`, `unsubscribeToken`; rows from before it were back-filled as confirmed):

- A new address is stored unconfirmed and gets one email, "Confirm your signup to the Muster Town blog", with `GET /api/blog/confirm?token=…`. The form then says "check your inbox". A repeat while unconfirmed sends the same link again; a repeat of a confirmed address sends nothing. If Resend refuses or is down, the signup answers 500 and the row stays, so a retry sends the link.
- The confirm link marks the row confirmed and shows a plain "You're in" page; a used or unknown token is a 404 page.
- Every email carries `GET /api/blog/unsubscribe?token=…` in its body and in a `List-Unsubscribe` header with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so a mail client's unsubscribe button POSTs to the same URL (RFC 8058). One click sets `unsubscribedAt`; signing up again needs a new confirmation.
- Sending posts to the list is not built yet: a send must include each row's unsubscribe link.
