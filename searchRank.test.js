import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankAlbums, matchScore, hasStrongMatch, penalty } from './searchRank.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-search-'));
const db = await import('./db.js');

const top = (q, list) => rankAlbums(q, list)[0];

test('the real album beats a tribute with the same title', () => {
  const list = [
    { id: 'rip', title: 'Pet Sounds', artist: 'The Rip-Off Artist', date: '1990', releaseCount: 1 },
    { id: 'bb', title: 'Pet Sounds', artist: 'The Beach Boys', date: '1966-05-16', releaseCount: 25, coverArtUrl: 'x' },
  ];
  assert.equal(top('Pet Sounds', list).id, 'bb');
  assert.equal(top('pet sounds beach boys', list).id, 'bb');
});

test('a well-known album beats an obscure one with the same title', () => {
  const list = [
    { id: 'storm', title: 'Born to Run', artist: 'Storm Lee', date: '2019', type: 'Single', releaseCount: 1 },
    { id: 'bruce', title: 'Born to Run', artist: 'Bruce Springsteen', date: '1975-08-25', releaseCount: 25, artistAlbums: 20 },
  ];
  assert.equal(top('born to run', list).id, 'bruce');
});

test('demo and working versions sit below the album unless asked for', () => {
  const list = [
    { id: 'wv', title: 'Abbey Road Working Version', artist: 'The Beatles', date: '1969', releaseCount: 1, artistAlbums: 40 },
    { id: 'ar', title: 'Abbey Road', artist: 'The Beatles', date: '1969-09-26', releaseCount: 25, artistAlbums: 40 },
  ];
  assert.equal(top('abbey road', list).id, 'ar');
  assert.equal(penalty('abbey road working version', list[0]), 0);
  assert.equal(hasStrongMatch('abbey road', [list[0]]), false);
  assert.equal(hasStrongMatch('abbey road', list), true);
});

test('match levels', () => {
  assert.equal(matchScore('thriller', { title: 'Thriller', artist: 'Michael Jackson' }), 100);
  assert.equal(matchScore('thriller michael jackson', { title: 'Thriller', artist: 'Michael Jackson' }), 98);
  assert.ok(matchScore('thriller', { title: 'Thriller 25', artist: 'Michael Jackson' }) < 100);
  assert.equal(matchScore('michael jackson', { title: 'Bad', artist: 'Michael Jackson' }), 40);
});

test('local search: all words, title+artist, ranked', () => {
  const add = (id, title, artist, date) => db.upsertAlbum({ id, title, type: 'Album', date, artist, label: '', coverArtUrl: null, genres: [], tracks: [] }, []);
  add('a1', 'Pet Sounds', 'The Rip-Off Artist', '1990');
  add('a2', 'Pet Sounds', 'The Beach Boys', '1966-05-16');
  add('a3', 'Smiley Smile', 'The Beach Boys', '1967');
  db.saveSongCredits('a2', [], [], 25);
  assert.deepEqual(db.searchLocal('pet sounds').map((a) => a.id), ['a2', 'a1']);
  assert.deepEqual(db.searchLocal('beach boys pet').map((a) => a.id), ['a2']);
  assert.equal(db.countSearchLocal('beach boys'), 2);
  assert.ok(!('views' in db.searchLocal('pet sounds')[0]));
});

test('an exact title by an unknown act is not a strong match', () => {
  const covers = { id: 'c', title: 'Hotel California', artist: 'Jam on the Mutha', releaseCount: 1, known: false };
  assert.equal(hasStrongMatch('Hotel California', [covers]), false);
  const eagles = { id: 'e', title: 'Hotel California', artist: 'Eagles', releaseCount: 25 };
  assert.equal(hasStrongMatch('Hotel California', [covers, eagles]), true);
  assert.equal(rankAlbums('hotel california', [covers, eagles])[0].id, 'e');
});

test('an exact title by a prolific artist is still not the famous album', () => {
  const hotRods = { id: 'h', title: 'Thriller', artist: 'Eddie & the Hot Rods', releaseCount: 2, artistAlbums: 15, known: false };
  assert.equal(hasStrongMatch('Thriller', [hotRods]), false);
  const mj = { id: 'mj', title: 'Thriller', artist: 'Michael Jackson', releaseCount: 120 };
  assert.equal(rankAlbums('thriller', [hotRods, mj])[0].id, 'mj');
});
