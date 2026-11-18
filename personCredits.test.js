import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, pickOriginal, roleOf, categoryOf } from './personCredits.js';

const rel = (r, date = '2004-09-28', secondary = []) => ({
  id: r, title: 'X', date, 'release-group': { id: `rg-${r}`, title: `Album ${r}`, 'primary-type': 'Album', 'secondary-types': secondary },
});

test('roles and categories', () => {
  assert.equal(roleOf({ type: 'instrument', attributes: ['electric guitar'] }), 'electric guitar');
  assert.equal(roleOf({ type: 'vocal', attributes: [] }), 'vocals');
  assert.equal(roleOf({ type: 'producer', attributes: ['executive'] }), 'executive producer');
  assert.equal(roleOf({ type: 'producer', attributes: ['co'] }), 'co-producer');
  assert.equal(categoryOf('producer'), 'producer');
  assert.equal(categoryOf('writer'), 'songwriter');
  assert.equal(categoryOf('instrument'), 'performer');
  assert.equal(categoryOf('mix'), 'engineering');
  assert.equal(categoryOf('arranger'), 'arrangement');
});

test('original album: no compilations or live, albums first, earliest first', () => {
  const pick = pickOriginal([rel('comp', '2003-01-01', ['Compilation']), rel('late', '2010-01-01'), rel('orig', '2004-01-01'),
    { id: 's', date: '2001-01-01', 'release-group': { id: 'rg-single', 'primary-type': 'Single', 'secondary-types': [] } }]);
  assert.equal(pick.id, 'rg-orig');
  assert.equal(pickOriginal([rel('c', '2001', ['Live'])]), null);
});

test('builds rows from releases, recordings and works, deduplicated', () => {
  const relations = [
    { 'target-type': 'release', type: 'producer', attributes: [], release: { id: 'r1' } },
    { 'target-type': 'recording', type: 'instrument', attributes: ['guitar'], recording: { id: 'rec1', title: 'Take It Away' } },
    { 'target-type': 'recording', type: 'instrument', attributes: ['guitar'], recording: { id: 'rec1', title: 'Take It Away' } },
    { 'target-type': 'work', type: 'writer', attributes: [], work: { id: 'w1', title: 'Take It Away' } },
    { 'target-type': 'recording', type: 'instrument', attributes: ['guitar'], recording: { id: 'missing', title: 'Nope' } },
  ];
  const r1 = { ...rel('r1', '2002-06-25'), 'artist-credit': [{ name: 'The Used' }] };
  const rec1 = { id: 'rec1', title: 'Take It Away', 'artist-credit': [{ name: 'The Used' }],
    releases: [rel('comp', '2005', ['Compilation']), rel('lad', '2004-09-28')] };
  const rows = buildRows({
    relations,
    releasesById: new Map([['r1', r1]]),
    recordingsById: new Map([['rec1', rec1]]),
    recordingsByWork: new Map([['w1', [rec1]]]),
  });
  assert.equal(rows.length, 3);
  const prod = rows.find((r) => r.category === 'producer');
  assert.deepEqual([prod.rgId, prod.rgTitle, prod.by, prod.date], ['rg-r1', 'Album r1', 'The Used', '2002-06-25']);
  const gtr = rows.find((r) => r.category === 'performer');
  assert.deepEqual([gtr.rgId, gtr.role, gtr.song], ['rg-lad', 'guitar', 'Take It Away']);
  const wr = rows.find((r) => r.category === 'songwriter');
  assert.deepEqual([wr.rgId, wr.song, wr.source], ['rg-lad', 'Take It Away', 'work']);
});

test('album year is the earliest release seen for that release group', () => {
  const reissue = { id: 'r2018', date: '2018-05-01', 'release-group': { id: 'rg-hc', title: 'Heartbeat City', 'primary-type': 'Album', 'secondary-types': [] }, 'artist-credit': [{ name: 'The Cars' }] };
  const original = { id: 'r1984', date: '1984-03-13', 'release-group': { id: 'rg-hc', title: 'Heartbeat City', 'primary-type': 'Album', 'secondary-types': [] } };
  const rows = buildRows({
    relations: [{ 'target-type': 'release', type: 'producer', attributes: [], release: { id: 'r2018' } },
                { 'target-type': 'recording', type: 'producer', attributes: [], recording: { id: 'rec', title: 'Drive' } }],
    releasesById: new Map([['r2018', reissue]]),
    recordingsById: new Map([['rec', { id: 'rec', title: 'Drive', releases: [reissue, original] }]]),
  });
  assert.ok(rows.every((r) => r.date === '1984-03-13'), JSON.stringify(rows));
});

test('original album beats a remix or edit single', () => {
  const mk = (id, title, type, date) => ({ id, date, 'release-group': { id: `rg-${id}`, title, 'primary-type': type, 'secondary-types': [] } });
  assert.equal(pickOriginal([mk('rmx', 'Azizam (Chris Barnes remix)', 'Single', '2025-01-01'), mk('alb', 'Play', 'Album', '2025-09-12')]).id, 'rg-alb');
  assert.equal(pickOriginal([mk('ed', 'Kick Ass (Edit)', 'Single', '2021-01-01'), mk('s', 'Kick Ass', 'Single', '2021-02-01')]).id, 'rg-s');
});
