import test from 'node:test';
import assert from 'node:assert/strict';
import { personShort, albumShort, rotation } from './shortScripts.js';
import { summarizeCredits, personCreditGroups } from './credits.js';

const mutt = { id: 'mutt', name: 'Mutt Lange' };
const rows = [
  ['producer', 'bib', 'Back in Black', 'AC/DC', '1980-07-25', 'Album'],
  ['producer', 'hys', 'Hysteria', 'Def Leppard', '1987-08-03', 'Album'],
  ['producer', 'pyro', 'Pyromania', 'Def Leppard', '1983-01-20', 'Album'],
  ['producer', 'coo', 'Come On Over', 'Shania Twain', '1997-11-04', 'Album'],
  ['producer', 'wun', 'Waking Up the Neighbours', 'Bryan Adams', '1991-09-24', 'Album'],
  ['producer', 'sgl', 'Some Single (remix)', 'Muse', '2015-01-01', 'Single'],
  ['songwriter', 'hys', 'Hysteria', 'Def Leppard', '1987-08-03', 'Album'],
].map(([category, rgId, rgTitle, byArtist, date, rgType]) => ({ category, role: category, rgId, rgTitle, byArtist, date, rgType }));

test('person short: one album per artist, albums first, oldest first', () => {
  const s = personShort(mutt, personCreditGroups(mutt, rows), 'https://albumverse.com');
  assert.equal(s.title, "Albums you didn't know Mutt Lange produced");
  assert.equal(s.narration, "Mutt Lange produced Back in Black for AC/DC, Pyromania for Def Leppard, Waking Up the Neighbours for Bryan Adams and Come On Over for Shania Twain. That's 6 albums of credits. See them all on Albumverse.");
  assert.equal(s.imageUrls.length, 4);
  assert.match(s.imageUrls[0], /release-group\/bib\/front-500$/);
  assert.equal(s.url, 'https://albumverse.com/artist/mutt?ref=yt');
  assert.equal(s.contentType, 'person_credits_yt');
});

test('person short needs at least 3 different artists', () => {
  const few = rows.filter((r) => ['AC/DC', 'Def Leppard'].includes(r.byArtist));
  assert.equal(personShort(mutt, personCreditGroups(mutt, few), 'x'), null);
});

test('album short: producers, musicians with instruments, writers', () => {
  const album = { id: 'rum', title: 'Rumours', artist: 'Fleetwood Mac', date: '1977-02-04', coverArtUrl: 'c.jpg',
    tracks: [{ position: 1, title: 'Dreams', writers: [{ name: 'Stevie Nicks', role: 'writer' }],
      performers: [{ name: 'Mick Fleetwood', role: 'drums' }, { name: 'John McVie', role: 'bass' }, { name: 'Stevie Nicks', role: 'lead vocals' }] }],
    credits: [{ name: 'Ken Caillat', role: 'Producer' }, { name: 'Richard Dashut', role: 'Producer' }, { name: 'Someone', role: 'producer [assistant]' }] };
  const s = albumShort(album, summarizeCredits(album), 'https://albumverse.com', ['p1.jpg']);
  assert.equal(s.title, 'Who played on Rumours?');
  assert.equal(s.subtitle, 'Fleetwood Mac · 1977');
  assert.equal(s.narration, 'Who played on Rumours by Fleetwood Mac? Produced by Ken Caillat and Richard Dashut. John McVie on bass, Mick Fleetwood on drums and Stevie Nicks on vocals. Written by Stevie Nicks. Every credit is on Albumverse.');
  assert.deepEqual(s.imageUrls, ['c.jpg', 'p1.jpg']);
});

test('album short skipped when credits are too thin', () => {
  const thin = { id: 'x', title: 'X', artist: 'Y', tracks: [], credits: [{ name: 'A', role: 'Producer' }] };
  assert.equal(albumShort(thin, summarizeCredits(thin), 'x'), null);
});

test('rotation: album and On This Day alternate, songwriter once a week', () => {
  const firsts = [];
  for (let d = 0; d < 7; d++) {
    const r = rotation(new Date(Date.UTC(2026, 10, 18 + d)));
    assert.equal(new Set(r).size, 3, 'every format stays in the fallback order');
    firsts.push(r[0]);
  }
  assert.equal(firsts.filter((k) => k === 'person').length, 1);
  assert.equal(firsts.filter((k) => k === 'album').length, 3);
  assert.equal(firsts.filter((k) => k === 'on_this_day').length, 3);
});
