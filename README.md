# Albumverse

A music database. Search an album, see its tracklist, writers/composers, and (where available) performer credits.

## Stack
- Node + Express backend, proxies and rate-limits calls to the [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) (free, open, no API key).
- Cover art pulled from the [Cover Art Archive](https://coverartarchive.org/).
- Optional supplementary credits (producer, engineer, session musicians) from the [Discogs API](https://www.discogs.com/developers) — see below.
- Plain HTML/CSS/JS frontend, no build step.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000.

### Discogs credits (optional)

MusicBrainz's own performer credits are inconsistently filled in; Discogs
tends to have richer session-musician/producer/engineer credits. To enable
enrichment from it:

1. Get a personal access token from your [Discogs developer settings](https://www.discogs.com/settings/developers).
2. Set it as an env var before starting the server or import script:
   ```bash
   export DISCOGS_TOKEN=your-token-here
   ```

Without a token, Discogs lookups still work but are capped at 25 req/min
instead of 60 (Discogs' own limits). Either way this is best-effort — a
missing token, no match, or any API failure just means an album has no
"Additional credits" section, never an error.

### SeatGeek tour dates (optional)

Without this, an artist page's ticket link is just a blind SeatGeek search.
With it, artists with upcoming shows get real dates/venues listed, each
linking straight to that event.

1. Get a `client_id` from [SeatGeek's Platform API](https://platform.seatgeek.com/) (self-serve signup).
2. Set it as an env var before starting the server:
   ```bash
   export SEATGEEK_CLIENT_ID=your-client-id-here
   ```
3. Optional: once approved for [SeatGeek's affiliate program](https://seatgeek.com/affiliate), set
   `SEATGEEK_AFFILIATE_ID` too so ticket links carry your tracking - confirm
   the actual tracking mechanism SeatGeek's affiliate dashboard gives you,
   since `seatgeek.js`'s `withAffiliateTag()` assumes a simple `?aid=` query
   param and may need adjusting to match.

Best-effort, same as Discogs: no client ID, no matching shows, or any API
failure just means the generic "Find tickets" search link stays as-is.

### Concert poster maker (optional)

`/poster` lets a visitor search an artist, pick a specific past show, and
generate a downloadable poster (date, venue, real setlist, optionally their
own photo) - a shareable memento, not a physical product; nothing is printed
or shipped. Needs real setlist data from [setlist.fm](https://api.setlist.fm/docs/1.0/index.html):

1. Get a free API key from the link above (self-serve signup).
2. Set it as an env var:
   ```bash
   export SETLISTFM_API_KEY=your-api-key-here
   ```

Without a key, the search just returns no results - the page itself still
loads fine, there's just nothing to pick from.

### Automated daily social post (optional)

Once a day, the server picks the single most newsworthy thing on the site
(a new In Memoriam entry first, then today's "On this day" pick, then this
week's #1 trending album) and posts it to Bluesky with a link back - or
posts nothing that day if none of those have anything new. A specific
artist/album is never posted about twice.

1. Create a Bluesky account and, under **Settings → App Passwords**, generate
   one (don't use your real account password here).
2. Set env vars:
   ```bash
   export BLUESKY_IDENTIFIER=yourhandle.bsky.social
   export BLUESKY_APP_PASSWORD=your-app-password-here
   export SITE_URL=https://albumverse.com   # defaults to this already; override if your domain differs
   ```

Without credentials, this quietly does nothing - same best-effort shape as
Discogs/SeatGeek/setlist.fm above.

### Automated daily YouTube Short (optional)

Same "one most-newsworthy thing" pick as the Bluesky post above, rendered
as a vertical video instead: cover art with a slow zoom, a burned-in
title/subtitle caption, and a TTS narration mixed over a royalty-free
music bed - never the actual copyrighted recording, so there's no
licensing issue. See `youtubeShort.js`, `video.js`, `elevenlabs.js`, and
`youtube.js`.

1. **Narration voice** - create an [ElevenLabs](https://elevenlabs.io) account,
   restrict an API key to Text-to-Speech only, and note a voice ID from
   the Voices tab:
   ```bash
   export ELEVENLABS_API_KEY=your-api-key-here
   export ELEVENLABS_VOICE_ID=your-chosen-voice-id
   ```
2. **Background music** - drop a few royalty-free instrumental tracks
   (e.g. from YouTube's own Audio Library) into `assets/music/` - see that
   folder's own README. One is picked at random per video.
3. **YouTube upload** - needs a Google Cloud OAuth app (YouTube Data API v3
   enabled, an OAuth consent screen, and a Desktop-app OAuth client), plus a
   one-time manual login to generate a refresh token:
   ```bash
   export YOUTUBE_CLIENT_ID=your-client-id-here
   export YOUTUBE_CLIENT_SECRET=your-client-secret-here
   export YOUTUBE_REFRESH_TOKEN=your-refresh-token-here
   ```
   **Note:** while the Google Cloud OAuth app is in "Testing" mode (the
   default, and fine for a single-user tool like this), Google caps refresh
   tokens at 7 days - this needs periodically regenerating via the same
   one-time login unless the app goes through Google's verification to move
   to "In production".

Missing any of the three pieces above just means no video gets rendered
that day - same best-effort shape as everything else in this app. Two
Basic-Auth-gated diagnostic routes exist for testing this pipeline without
waiting for the daily scheduler: `/admin/render-test-short` (renders and
downloads the video) and `/admin/upload-test-short` (renders and uploads
it to YouTube as **private**, never public) - both reuse the real content-
selection cascade but never mark anything as posted, so hitting them
repeatedly is safe.

## Growing the library

Seed artist lists live in `artists.txt`, `artists_expansion.txt`,
`artists_expansion_2.txt`, and `artists_expansion_3.txt` (~345 artists
across rock, metal, classical, country, soul, jazz, blues, folk, pop,
hip-hop, grunge, indie, EDM, K-pop, Latin, punk, prog, reggae, Afrobeats,
gospel, bluegrass, and more - including current-decade names, not just
classic-era). Import them with:

```bash
npm run import -- --file artists.txt
npm run import -- --file artists_expansion.txt
npm run import -- --file artists_expansion_2.txt
npm run import -- --file artists_expansion_3.txt
```

**Classical composers are a trap.** MusicBrainz treats every orchestra's
every recording of the same work as its own release-group, so a single
composer can match *thousands* (Bach alone: ~5,000). The importer caps new
additions per artist per run at 40 by default (`--max-per-artist N` to
change it) specifically so one outlier composer can't eat an entire run's
time budget before it ever reaches the next artist in the file. Already-saved
albums don't count against the cap, so re-running the same file later keeps
adding more, N at a time.

**Budget real time for this.** MusicBrainz paces every request to ~1
req/1.3s, and a single album needs several requests (release detail, plus
one per track that has separate writer-credit data) — a typical artist with
a handful of studio albums can take several minutes, so a few hundred
artists is realistically hours, not minutes. Run it somewhere it can keep
going after you close the terminal:

```bash
nohup npm run import -- --file artists_expansion_2.txt > import.log 2>&1 &
tail -f import.log   # watch progress; Ctrl-C to stop watching (the import keeps running)
```

It's idempotent (skips albums already saved), so it's always safe to stop
and re-run later, or add more artists to a `.txt` file and re-run just that
file. In production (`DATA_DIR` set), the server itself auto-resumes all
three seed files on every boot — see `launchSeedImports` in `server.js` —
so a deploy restart never loses progress.

## Notes
- MusicBrainz limits unauthenticated clients to ~1 request/second. The server serializes all calls; a first-time album load (especially fetching per-track writer credits) can take 10-20+ seconds.
- Performer credits (who played what instrument) are much less consistently filled in on MusicBrainz than composer/lyricist credits — that data gap is MusicBrainz's, not this app's. Discogs enrichment (above) helps fill this in.
- The MusicBrainz/Discogs response cache is persisted to the same SQLite DB as everything else, so it survives restarts/deploys instead of cold-starting every time.

## Ideas for next steps
- Artist pages (discography list, not just single albums) — done
- Persist cache to disk/SQLite so it survives restarts — done
- Swap/add Discogs as a second data source for personnel credits — done
- Pagination for search results — done
