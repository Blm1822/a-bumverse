import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSpotlight, songwriterStory, albumStory } from './home.js';
import { personCreditGroups, summarizeCredits } from './credits.js';

test('spotlight rotates daily through the candidates', () => {
  const c = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const d1 = pickSpotlight(c, new Date(Date.UTC(2026, 10, 18)));
  const d2 = pickSpotlight(c, new Date(Date.UTC(2026, 10, 19)));
  assert.notEqual(d1.id, d2.id);
  assert.equal(pickSpotlight([], new Date()), null);
});

test('songwriter story needs 5+ albums and names the acts', () => {
  const p = { id: 'sk', name: 'Savan Kotecha' };
  const rows = ['Britney Spears', 'Ariana Grande', 'Ed Sheeran', 'Tate McRae', 'Ariana Grande', 'Demi Lovato']
    .map((by, i) => ({ category: 'songwriter', role: 'writer', rgId: `r${i}`, rgTitle: `A${i}`, date: `20${10 + i}`, byArtist: by }));
  const st = songwriterStory(p, personCreditGroups(p, rows));
  assert.equal(st.title, 'Savan Kotecha’s songs are on 6 albums');
  assert.match(st.text, /^Recorded by /);
  assert.equal(songwriterStory(p, personCreditGroups(p, rows.slice(0, 3))), null);
});

test('album story leads with main producers', () => {
  const album = { id: 'rum', title: 'Rumours', artist: 'Fleetwood Mac', date: '1977-02-04', tracks: [],
    credits: [{ name: 'Ken Caillat', role: 'Producer' }, { name: 'Richard Dashut', role: 'Producer' }, { name: 'X', role: 'producer [assistant]' }] };
  const st = albumStory(album, summarizeCredits(album));
  assert.equal(st.title, 'Who played on Rumours?');
  assert.equal(st.text, 'Fleetwood Mac, 1977. Produced by Ken Caillat and Richard Dashut. Every musician and writer, track by track.');
  assert.equal(albumStory({ ...album, credits: [] }, summarizeCredits({ ...album, credits: [] })), null);
});
