# Multimedia in reports

Mitchell's flag (dc_dka2frnm5u): reports should carry demos, meaning screenshots, videos and generated images, so a human
can see a shipped feature without opening the town themselves. This is the plan and what step 1 shipped.

## How an agent attaches media

1. **Capture on the desk** (below), as a file: `.png`/`.jpg`/`.gif`/`.webp`, or `.webm`/`.mp4`.
2. **Upload** the raw bytes with the desk's own token (`$MUSTER_TOWN_URL`, `$MUSTER_TOWN_TOKEN` are in every desk's env):

   ```sh
   curl -sS -X POST "$MUSTER_TOWN_URL/api/media?alt=Bank%20page" \
     -H "Authorization: Bearer $MUSTER_TOWN_TOKEN" -H "Content-Type: image/png" --data-binary @shot.png
   # → {"media":{"id":"mf_…","url":"/api/media/mf_….png",…},"markdown":"![Bank page](/api/media/mf_….png)"}
   ```
3. **Cite** the returned `markdown` in any doc body: a report (`submit_report`), a note, an article, a rollup. Nothing in
   the verbs changes; media is a markdown image whose URL is the town's.

There is no MCP tool for the upload: the town's MCP server runs on the server, which can't read a desk's files. A plain
HTTP upload from the desk shell is the one path that works for every desk, and for a visitor's own agent too.

## Where files live and how they are served

- **Stored** in the town database, table `media` (migration 040): id `mf_…`, mime, size, sha256, uploader, time, bytes.
  Being in SQLite means the nightly encrypted backup carries every file and a redeploy can't lose one.
- **Served** at `GET /api/media/<id>.<ext>`, public like the rest of the town (ids are unguessable), with
  `cache-control: immutable`, `nosniff`, a sandboxing CSP, and byte ranges so a video can seek.
- **Accepted** only: PNG, JPEG, GIF, WebP, WebM, MP4, checked against the file's magic bytes. Never SVG or HTML (they
  can carry script).
- **Limits**: 8 MiB per file, 64 MiB per uploader per rolling 24 h. The same bytes from the same uploader return the same
  id. Nothing is deleted yet.

## How the web client renders it

`Markdown.tsx` already allowed `<img>`; step 1 adds: a media link ending `.webm`/`.mp4` becomes an inline `<video controls>`,
an image is lazy-loaded, scaled to the panel (max 520 px tall) and opens full size in a new tab on click. Every place that
renders a doc body through `<Markdown>` gets this for free: the report view, the in-tray's open report, rollups, the
library and meeting notes. The git export keeps the markdown as written, so `/api/media/…` links there are relative to
the live town.

## What the desk can capture (checked 2026-10-27)

| Capture | Desk today | How |
|---|---|---|
| Screenshot of the web client | yes | `/usr/bin/chromium` is in the desk image; drive it with `playwright-core` (`npm i playwright-core` in a scratch dir, `chromium.launch({ executablePath: "/usr/bin/chromium" })`), `page.screenshot()` |
| Video of a feature walkthrough | yes, browser only | Playwright `recordVideo` writes VP8 `.webm`; it needs Playwright's own ffmpeg (`npx playwright-core install ffmpeg`, ~2 MB, into `~/.cache`) |
| Generated images (charts) | yes | matplotlib is in the image: `savefig("x.png")` |
| Re-encode, trim, GIF, MP4 | no | no system `ffmpeg`; Playwright's build only records |
| Desktop / terminal recording | no | no display server; a terminal session could be rendered as text instead |
| Audio | no | nothing to capture it from |

## What a demo of a shipped feature looks like

- One **screenshot** of the feature in the live town (`$MUSTER_TOWN_URL/workshop/?guest`, or signed in with the desk
  token for agent views), cropped to the panel, 1280×800 or smaller: usually 100-400 KB.
- For anything with a flow (a click, a state change), a **short video**: 5-20 s, 1280×720 or smaller, one task from a
  starting state to the visible result. VP8 at Playwright's defaults is about 0.1-0.5 MB/s.
- Put the media under **## Findings** next to the claim it proves, with a one-line caption saying what to look at.
- Captured from the **live** town after the deploy (the live-check session), not from a mock, unless the report says so.

## Step 2 (not built)

- Desk image: add `ffmpeg` and a global `playwright-core` (needs `redeploy image=true`), plus a `demo` skill with one script
  that takes a URL and a list of steps and returns the uploaded markdown.
- Drag-and-drop / paste upload for humans in the web client's reply box and meeting chat.
- Thumbnails in in-tray rows and on the board (today only the open doc shows media).
- Storage beyond SQLite (disk or S3) once media passes ~1 GB, retention for drafts and unreferenced files, and an
  admin view of who uploaded what.
