import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-hook-'));
const { tributeHook, yearsAgoHook } = await import('./youtubeShort.js');
const { buildAssFile } = await import('./video.js');

test('first-second hooks', () => {
  assert.equal(tributeHook('Conrad Lant', '1966', '2026'), 'Conrad Lant\n1966–2026');
  assert.equal(tributeHook('Someone', '', '2026'), 'Someone\ndied 2026');
  assert.equal(yearsAgoHook('1981', new Date('2026-09-30T12:00:00Z')), '45 years ago today');
  assert.equal(yearsAgoHook('2025', new Date('2026-01-01T00:00:00Z')), '1 year ago today');
  assert.equal(yearsAgoHook('', new Date()), '');
});

test('the hook is drawn from the first frame, top of the screen, and left out when empty', () => {
  const ass = buildAssFile({ title: 'T', subtitle: 'S', hook: 'Conrad Lant\n1966–2026', durationSeconds: 9 });
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:09\.00,Hook,,0,0,0,,Conrad Lant\\N1966–2026/);
  assert.match(ass, /Style: Hook,Inter,100,.*,8,60,60,240/);
  assert.doesNotMatch(buildAssFile({ title: 'T', subtitle: 'S', durationSeconds: 9 }), /,Hook,/);
});
