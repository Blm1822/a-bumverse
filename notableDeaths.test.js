import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-deaths-'));
const N = await import('./notableDeaths.js');

const now = Date.parse('2026-11-21T12:00:00Z');
const d = (mbid, links, diedDate = '2026-11-20') => ({ mbid, links, diedDate });

test('only well-known, recent, missing, untried deaths are picked, most famous first', () => {
  const picked = N.pickNotableMissing(
    [d('a', 40), d('b', 5), d('c', 60, '2026-09-01'), d('d', 30), d('e', 80), d('f', 20), d('g', 90)],
    { exists: (m) => m === 'd', tried: (m) => m === 'g', now },
  );
  assert.deepEqual(picked.map((x) => x.mbid), ['e', 'a', 'f'], 'not b (obscure), c (old), d (already here), g (tried); capped at 3');
});

test('albums: studio albums and EPs in release order, no live or compilations', () => {
  const rg = (id, primaryType, date, secondaryTypes = []) => ({ id, primaryType, date, secondaryTypes });
  const out = N.pickAlbums([rg('late', 'Album', '1990'), rg('live', 'Album', '1975', ['Live']), rg('ep', 'EP', '1972'), rg('first', 'Album', '1970'), rg('single', 'Single', '1969')]);
  assert.deepEqual(out.map((x) => x.id), ['first', 'ep', 'late']);
});

test('imports a famous musician missing from the site, once', async () => {
  const saved = { artists: [], albums: [], tried: new Set() };
  const deps = {
    exists: () => false,
    tried: (m) => saved.tried.has(m),
    markTried: (m) => saved.tried.add(m),
    upsertArtist: (a) => saved.artists.push(a),
    setArtistLifespan: () => {},
    albumExists: () => false,
    saveAlbum: (al) => saved.albums.push(al.id),
    mb: {
      getArtistDetail: async () => ({ name: 'Famous Singer', type: 'Person', disambiguation: '', bornDate: '1940', endDate: '2026-11-20' }),
      getArtistReleaseGroups: async () => [{ id: 'r1', primaryType: 'Album', date: '1970', secondaryTypes: [] }],
      getAlbumDetail: async (id) => ({ id }),
    },
  };
  const first = await N.importNotableDeaths([d('x', 50)], deps);
  assert.deepEqual(first, [{ mbid: 'x', name: 'Famous Singer', albums: 1 }]);
  assert.deepEqual(saved.albums, ['r1']);
  assert.deepEqual(await N.importNotableDeaths([d('x', 50)], deps), [], 'never tried twice');
});
