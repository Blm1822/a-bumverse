import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-songs-'));
const { parseTrackSpec, discogsTrackCredits, matchTracks, mergeDiscogsIntoTracks, normTitle } = await import('./trackCredits.js');
const { relRole } = await import('./mb.js');
const { cleanDiscogsName } = await import('./discogs.js');
const { isOldMaster } = await import('./home.js');
const db = await import('./db.js');

const release = {
  tracklist: [
    { position: 'A1', type_: 'track', title: 'Wanna Be Startin’ Somethin’', extraartists: [{ name: 'Greg Phillinganes', role: 'Keyboards' }] },
    { position: 'A2', type_: 'track', title: 'Baby Be Mine' },
    { position: '', type_: 'heading', title: 'Side B' },
    { position: 'B1', type_: 'track', title: 'Thriller', extraartists: [{ name: 'Vincent Price', role: 'Voice [Rap]' }, { name: 'Rod Temperton', role: 'Written-By' }] },
    { position: 'B2', type_: 'track', title: 'Beat It (Single Version)' },
  ],
  extraartists: [
    { name: 'Eddie Van Halen', role: 'Guitar [Solo]', tracks: 'B2' },
    { name: 'Jeff Porcaro', anv: 'Jeff Porcaro', role: 'Drums', tracks: 'A2 to B2' },
    { name: 'Quincy Jones', role: 'Producer', tracks: '' },
    { name: 'Bernie Grundman', role: 'Mastered By', tracks: 'A1' },
  ],
};

test('Discogs track scopes and names', () => {
  const pos = ['A1', 'A2', 'B1', 'B2'];
  assert.deepEqual([...parseTrackSpec('A2 to B2', pos)], [1, 2, 3]);
  assert.deepEqual([...parseTrackSpec('A1, B2', pos)], [0, 3]);
  assert.deepEqual([...parseTrackSpec('C9', pos)], []);
  assert.equal(cleanDiscogsName({ name: 'Paul Jackson (2)' }), 'Paul Jackson');
  assert.equal(cleanDiscogsName({ name: 'Steve Lukather', anv: 'Luke' }), 'Steve Lukather');
  assert.equal(normTitle('Beat It (Single Version)'), 'beat it');
});

test('per-track and track-scoped Discogs credits land on the right songs', () => {
  const t = discogsTrackCredits(release);
  assert.equal(t.length, 4);
  assert.deepEqual(t[3].credits.map((c) => c.name), ['Eddie Van Halen', 'Jeff Porcaro']);
  assert.ok(t[2].credits.some((c) => c.name === 'Vincent Price'));
  assert.ok(!t.some((x) => x.credits.some((c) => c.name === 'Quincy Jones')), 'album-wide credits stay album-wide');
});

test('merge adds musicians, skips mastering, keeps MusicBrainz entries, fills empty writers', () => {
  const tracks = [
    { position: 1, title: 'Wanna Be Startin’ Somethin’', performers: [], writers: [{ name: 'Michael Jackson', role: 'writer' }] },
    { position: 2, title: 'Baby Be Mine', performers: [{ name: 'Jeff Porcaro', role: 'drums (drum set)', mbid: 'x' }], writers: [] },
    { position: 3, title: 'Thriller', performers: [], writers: [] },
    { position: 4, title: 'Beat It', performers: [], writers: [] },
  ];
  assert.equal(mergeDiscogsIntoTracks(tracks, release), 3);
  assert.deepEqual(tracks[0].performers.map((p) => p.name), ['Greg Phillinganes']);
  assert.equal(tracks[1].performers.length, 1, 'Porcaro already credited by MusicBrainz');
  assert.deepEqual(tracks[2].writers.map((w) => w.name), ['Rod Temperton']);
  assert.deepEqual(tracks[2].performers.map((p) => p.name), ['Vincent Price', 'Jeff Porcaro']);
  assert.deepEqual(tracks[3].performers.map((p) => p.name), ['Eddie Van Halen', 'Jeff Porcaro']);
});

test('a Discogs release with different songs is not used', () => {
  const ours = [{ title: 'Go Your Own Way' }, { title: 'Dreams' }, { title: 'Songbird' }];
  assert.equal(matchTracks(ours, discogsTrackCredits(release)), null);
  const tracks = ours.map((t) => ({ ...t, performers: [], writers: [] }));
  assert.equal(mergeDiscogsIntoTracks(tracks, release), 0);
});

test('MusicBrainz roles read naturally', () => {
  assert.equal(relRole({ type: 'instrument', attributes: ['guitar'] }), 'guitar');
  assert.equal(relRole({ type: 'vocal', attributes: ['lead vocals'] }), 'lead vocals');
  assert.equal(relRole({ type: 'producer', attributes: ['executive'] }), 'executive producer');
  assert.equal(relRole({ type: 'mix', attributes: [] }), 'mix');
});

test('old masters are kept off the homepage', () => {
  assert.equal(isOldMaster({ name: 'Antonio Vivaldi', bornDate: '1678-03-04' }), true);
  assert.equal(isOldMaster({ name: 'Antonio Vivaldi', bio: 'Antonio Lucio Vivaldi (4 March 1678 – 28 July 1741) was an Italian composer' }), true);
  assert.equal(isOldMaster({ name: 'X', disambiguation: 'Italian Baroque composer' }), true);
  assert.equal(isOldMaster({ name: 'Jon Walker', bornDate: '1985-09-17', bio: 'Jon Walker (born September 17, 1985) is an American musician' }), false);
  assert.equal(isOldMaster({ name: 'Savan Kotecha' }), false);
});

test('saving song credits replaces musicians, keeps writers, marks the album', () => {
  db.upsertAlbum({
    id: 'rg1', title: 'T', type: 'Album', date: '1982', artist: 'A', label: '', coverArtUrl: null, genres: [],
    tracks: [
      { position: 1, title: 'One', recordingMbid: 'r1', performers: [{ name: 'Old', role: 'bass' }], writers: [{ name: 'W', role: 'writer' }] },
      { position: 2, title: 'Two', recordingMbid: 'r2', performers: [], writers: [] },
    ],
  }, []);
  assert.equal(db.albumSongCreditsAt('rg1'), null);
  assert.ok(db.albumsNeedingSongCredits(10).some((a) => a.id === 'rg1'));
  const n = db.saveSongCredits('rg1', [
    { position: 1, recordingMbid: 'r1', performers: [{ name: 'New', role: 'guitar', mbid: 'p1' }], writers: [{ name: 'Other', role: 'writer' }] },
    { position: 2, recordingMbid: 'r2', performers: [{ name: 'Drummer', role: 'Drums' }], writers: [{ name: 'Discogs Writer', role: 'Written-By' }] },
  ], [{ name: 'Q', role: 'producer', source: 'musicbrainz' }]);
  assert.equal(n, 2);
  const a = db.getAlbumLocal('rg1');
  assert.deepEqual(a.tracks[0].performers.map((p) => p.name), ['New']);
  assert.deepEqual(a.tracks[0].writers.map((w) => w.name), ['W']);
  assert.deepEqual(a.tracks[1].writers.map((w) => w.name), ['Discogs Writer']);
  assert.deepEqual(a.credits.map((c) => c.source), ['musicbrainz']);
  assert.ok(db.albumSongCreditsAt('rg1'));
  assert.ok(!db.albumsNeedingSongCredits(10).some((x) => x.id === 'rg1'));
});

test('songs for a person: by id, by name when unique, one row per song, roles merged', async () => {
  const { personHtml, personDescription } = await import('./credits.js');
  db.upsertArtist({ mbid: 'luke', name: 'Steve Lukather', disambiguation: null });
  const mk = (id, title, date, artist, tracks) => db.upsertAlbum({ id, title, type: 'Album', date, artist, label: '', coverArtUrl: null, genres: [], tracks }, []);
  mk('thr', 'Thriller', '1982-11-30', 'Michael Jackson', [
    { position: 1, title: 'Beat It', recordingMbid: 'b1', performers: [{ name: 'Steve Lukather', role: 'guitar', mbid: 'luke' }, { name: 'Steve Lukather', role: 'Bass' }], writers: [] },
    { position: 2, title: 'Human Nature', recordingMbid: 'h1', performers: [{ name: 'Steve Lukather', role: 'Guitar' }], writers: [{ name: 'Steve Porcaro', role: 'writer' }] },
  ]);
  mk('hits', 'Number Ones', '2003-11-18', 'Michael Jackson', [
    { position: 1, title: 'Beat It (Single Version)', recordingMbid: 'b2', performers: [{ name: 'Steve Lukather', role: 'guitar', mbid: 'luke' }], writers: [] },
  ]);
  const songs = db.songsForPerson('luke', 'Steve Lukather', { withName: true });
  assert.deepEqual(songs.map((x) => x.song), ['Beat It', 'Human Nature']);
  assert.equal(songs[0].album, 'Thriller');
  assert.equal(songs[0].alsoOn, 1);
  assert.deepEqual(songs[0].roles.sort(), ['bass', 'guitar']);
  assert.equal(db.songsForPerson('luke', 'Steve Lukather', { withName: false }).length, 1, 'name-only credits need withName');
  const a = { id: 'luke', name: 'Steve Lukather', songs, creditGroups: [] };
  assert.match(personHtml(a, undefined, a), /Songs \(2\)/);
  assert.match(personDescription(a), /credited on 2 songs/);
});
