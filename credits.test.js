import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCredits, creditsDescription, creditsTitle, creditsHtml } from './credits.js';

const album = {
  title: 'Rumours', artist: 'Fleetwood Mac', date: '1977-02-04', label: 'Warner Bros.',
  tracks: [
    { position: 1, title: 'Second Hand News',
      writers: [{ name: 'Lindsey Buckingham', role: 'writer', mbid: 'lb' }],
      performers: [{ name: 'Mick Fleetwood', role: 'drums', mbid: 'mf' }, { name: 'Lindsey Buckingham', role: 'guitar', mbid: 'lb' }] },
    { position: 2, title: 'Dreams',
      writers: [{ name: 'Stevie Nicks', role: 'writer', mbid: 'sn' }],
      performers: [{ name: 'Mick Fleetwood', role: 'drums', mbid: 'mf' }, { name: 'Stevie Nicks', role: 'vocals' }] },
  ],
  credits: [
    { name: 'Ken Caillat', role: 'Producer, Engineer' },
    { name: 'Richard Dashut', role: 'Producer' },
    { name: 'Herbert Worthington', role: 'Photography By' },
    { name: 'Lindsey Buckingham', role: 'Arranged By' },
  ],
};

test('groups people by what they did, producers first', () => {
  const g = summarizeCredits(album);
  assert.deepEqual(g.map((x) => x.key), ['producers', 'writers', 'musicians', 'arrangement', 'artwork']);
  assert.deepEqual(g[0].people.map((p) => p.name).sort(), ['Ken Caillat', 'Richard Dashut']);
  const drums = g.find((x) => x.key === 'musicians').people.find((p) => p.name === 'Mick Fleetwood');
  assert.equal(drums.tracks, 2);
  assert.equal(drums.allTracks, true);
  assert.deepEqual(drums.roles, ['drums']);
});

test('one person appears once per group with merged roles', () => {
  const g = summarizeCredits(album);
  const mus = g.find((x) => x.key === 'musicians').people;
  assert.equal(mus.filter((p) => p.name === 'Lindsey Buckingham').length, 1);
  const sn = mus.find((p) => p.name === 'Stevie Nicks');
  assert.equal(sn.mbid, null);
});

test('description names the people and stays short', () => {
  const d = creditsDescription(album);
  assert.ok(d.startsWith('Who wrote, produced and played on Rumours (1977) by Fleetwood Mac.'));
  assert.match(d, /Produced by/);
  assert.ok(d.length <= 158, d);
  assert.equal(creditsTitle(album), 'Rumours by Fleetwood Mac: Credits & Personnel');
});

test('server HTML escapes text and links people with ids', () => {
  const h = creditsHtml({ ...album, title: 'A <b>' });
  assert.match(h, /<h1>A &lt;b&gt; credits<\/h1>/);
  assert.match(h, /<a href="\/artist\/mf">Mick Fleetwood<\/a>/);
  assert.match(h, /Track-by-track credits/);
});

test('empty album does not crash', () => {
  assert.deepEqual(summarizeCredits({}), []);
  assert.match(creditsHtml({ title: 'X', artist: 'Y' }), /No credits recorded yet/);
});

import { personSummary, personTitle, personDescription, personHtml, normalizeRole } from './credits.js';

const person = {
  name: 'Quinn Allman', type: 'Person', disambiguation: 'guitarist', bio: 'Quinn Allman is an American musician.',
  albums: [],
  appearances: [
    { id: 'a1', title: 'The Used', artist: 'The Used', date: '2002-06-25', roles: ['guitar', 'writer'] },
    { id: 'a2', title: 'In Love and Death', artist: 'The Used', date: '2004-09-28', roles: ['guitar', 'composer'] },
    { id: 'a3', title: 'Lies for the Liars', artist: 'The Used', date: '2007-05-22', roles: ['guitar'] },
  ],
};

test('person role line comes from what they did, plus their main act', () => {
  const s = personSummary(person);
  assert.equal(s.roleLine, 'guitar, songwriter · The Used');
  assert.equal(personTitle(person), 'Quinn Allman: guitar, songwriter · The Used · Credits & Albums');
});

test('person description names albums and stays short', () => {
  const d = personDescription(person);
  assert.ok(d.startsWith('Quinn Allman (guitar, songwriter · The Used): credited on Lies for the Liars, In Love and Death and The Used.'), d);
  assert.ok(d.length <= 158);
});

test('groups get a discography title; people without credits fall back to bio', () => {
  assert.equal(personTitle({ name: 'Yellowcard', type: 'Group', albums: [] }), 'Yellowcard: Discography & Album Credits');
  assert.equal(personDescription({ name: 'X', bio: 'X is a singer.' }), 'X is a singer.');
  assert.equal(personSummary({ name: 'X', disambiguation: 'UK producer' }).roleLine, 'UK producer');
});

test('roles are normalized and person HTML lists credits', () => {
  assert.equal(normalizeRole('Producer'), 'producer');
  assert.equal(normalizeRole('lead vocals'), 'vocals');
  assert.equal(normalizeRole('Written-By'), 'songwriter');
  const h = personHtml(person);
  assert.match(h, /<h1>Quinn Allman<\/h1>/);
  assert.match(h, /<a href="\/album\/a2">In Love and Death<\/a> by The Used \(2004\): guitar, composer/);
});
