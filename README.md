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

## Growing the library

Seed artist lists live in `artists.txt`, `artists_expansion.txt`, and
`artists_expansion_2.txt` (~280 artists across rock, metal, classical,
country, soul, jazz, blues, folk, pop, hip-hop, grunge, indie, EDM, K-pop,
Latin, punk, prog, and more). Import them with:

```bash
npm run import -- --file artists.txt
npm run import -- --file artists_expansion.txt
npm run import -- --file artists_expansion_2.txt
```

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
