# ytm-liked-sync — Cloudflare Workers edition

Purges and refills a target YouTube Music playlist with a 1:1 copy of your
Liked Music, on a Cron Trigger. Same purge → verify → refill → verify logic
as the original Python script, rewritten in TypeScript since Workers can't
run `ytmusicapi` (Python + `requests`, and no local `browser.json` file to
read).

## Provenance

`src/ytmusic.ts` was rewritten after diffing it against the actual current
`sigma67/ytmusicapi` source (not reconstructed from memory) -- specifically
`helpers.py`, `constants.py`, `ytmusic.py`, `mixins/playlists.py`,
`parsers/playlists.py`, `navigation.py`, and `continuations.py`. Each
function has a comment pointing at the real file/function it ports. Two
things the first draft got wrong that this version fixes:

- **Liked Music's browse ID**: it's `"VL" + "LM"` = `"VLLM"`, not a special
  `FEmusic_liked_videos` ID.
- **Track/continuation parsing**: the real response shape uses
  `twoColumnBrowseResultsRenderer` → `secondaryContents` →
  `musicPlaylistShelfRenderer`, with `setVideoId`/`videoId` read out of each
  track's context menu (`menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.actions[0]`),
  and continuations are a trailing `continuationItemRenderer` in the same
  array (`get_continuations_2025`) -- not the older shelf-level
  `continuations` array I'd guessed at originally.

It also now sends the `X-Goog-Visitor-Id` header (fetched once per run, the
way `ytmusicapi` does), reads `__Secure-3PAPISID` specifically instead of
falling back to `SAPISID`, and sends all playlist-edit actions in a single
request instead of the artificial chunking the first draft added (the real
client doesn't chunk).

**What's still unverified**: this was checked against one point-in-time
snapshot of the source, not the exact released version you may end up
depending on, and I have not run it against a live account. Treat a first
manual `/run` as the real test, not this diff.

## What changed vs. the GitHub Actions version

- **Auth**: instead of a `browser.json` file, the Worker takes the raw
  `Cookie` header as a secret and derives the `SAPISIDHASH` signature itself
  (that's literally all `ytmusicapi`'s "browser auth" does under the hood).
- **HTTP calls**: `src/ytmusic.ts` re-implements just the three YouTube Music
  internal endpoints this project needs (`browse` for reading a playlist,
  `browse/edit_playlist` for add/remove/description) using `fetch` directly.
- **Scheduling**: a Cron Trigger (`*/30 * * * *`, same cadence as the old
  Actions workflow) replaces `on: schedule` in the YAML.
- **Manual run**: `GET/POST /run` (optionally token-gated) replaces
  `workflow_dispatch`.

## One caveat worth knowing

YouTube Music's internal API is undocumented and can change its response
shape without notice — `ytmusicapi` deals with this by being actively
maintained. `src/ytmusic.ts` here parses the same JSON shapes but is a much
smaller, unmaintained reimplementation, so if Google changes the page's
JSON structure this will need a small patch (the parsing helpers are
isolated at the bottom of that file). Everything else — the shape-check,
purge/refill/verify cycle, retry logic — is a direct port of
`update_liked.py` and shouldn't need touching.

## Setup

1. **Install deps**
   ```bash
   npm install
   ```

2. **Get your cookie.** Log into https://music.youtube.com in a browser,
   open DevTools → Network, click any request to `music.youtube.com`, and
   copy the full value of the `Cookie` request header (this is the same
   cookie data that used to live in your `browser.json`; it must include
   `SAPISID` or `__Secure-3PAPISID`).

3. **Set secrets:**
   ```bash
   npx wrangler login
   npx wrangler secret put YT_COOKIE
   # paste the full Cookie header value when prompted

   npx wrangler secret put RUN_TOKEN   # optional, protects the manual /run endpoint
   ```

4. **Set the target playlist ID** in `wrangler.toml` under `[vars]` (already
   filled in with the ID from the original script — change it if needed).

5. **Deploy:**
   ```bash
   npm run deploy
   ```

6. **Test it once manually** before waiting on the cron:
   ```bash
   curl -X POST "https://ytm-liked-sync.<your-subdomain>.workers.dev/run?token=<RUN_TOKEN>"
   ```
   Tail logs live with `npm run tail`.

## Notes on cookie lifetime

Browser cookies for a Google account are long-lived but not permanent —
if the sync starts failing with an auth error, re-copy the `Cookie` header
from a fresh logged-in session and re-run `wrangler secret put YT_COOKIE`.
This is the same maintenance the old `YT_BROWSER_JSON` GitHub secret
needed.
