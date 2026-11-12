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

## The signup slot

Each post page has a `<!-- signup: ... -->` comment in its `<footer>`, after the article and before the links (`renderPost` in `blog.ts`). The email signup form goes there.
