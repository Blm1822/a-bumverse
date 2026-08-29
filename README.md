# Albumverse

A music database. Search an album, see its tracklist, writers/composers, and (where available) performer credits.

## Stack
- Node + Express backend, proxies and rate-limits calls to the [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) (free, open, no API key).
- Cover art pulled from the [Cover Art Archive](https://coverartarchive.org/).
- Plain HTML/CSS/JS frontend, no build step.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Notes
- MusicBrainz limits unauthenticated clients to ~1 request/second. The server serializes all calls and caches responses in memory for 30 minutes, so repeat lookups are fast but a first-time album load (especially fetching per-track writer credits) can take 10-20+ seconds.
- Performer credits (who played what instrument) are much less consistently filled in on MusicBrainz than composer/lyricist credits — that data gap is MusicBrainz's, not this app's. Discogs has richer session-musician credits if that's ever worth swapping in.
- Cache is in-memory only; restarting the server clears it.

## Ideas for next steps
- Artist pages (discography list, not just single albums)
- Persist cache to disk/SQLite so it survives restarts
- Swap/add Discogs as a second data source for personnel credits
- Pagination for search results
