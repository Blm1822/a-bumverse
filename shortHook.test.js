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

test('tribute script: band, age, date and note', async () => {
  const { tributeScript, ageAt } = await import('./youtubeShort.js');
  assert.equal(ageAt('1961-02-16', '2026-11-23'), 65);
  const s = tributeScript({
    person: { id: 'p1', name: 'Andy Taylor', bornDate: '1961-02-16', imageUrl: 'https://x/p.jpg' },
    band: { id: 'b1', name: 'Duran Duran' }, diedDate: '2026-11-23', role: 'founding guitarist',
    note: 'He co-wrote Rio and Hungry Like the Wolf', bandCovers: ['https://x/rio.jpg'],
  });
  assert.equal(s.title, 'Remembering Andy Taylor of Duran Duran');
  assert.equal(s.hook, 'Andy Taylor\n1961–2026');
  assert.match(s.narration, /^Remembering Andy Taylor, founding guitarist of Duran Duran, who passed away on November 23, 2026, at 65\. He co-wrote Rio and Hungry Like the Wolf\. See every/);
  assert.deepEqual(s.imageUrls, ['https://x/p.jpg', 'https://x/rio.jpg']);
  assert.equal(s.contentType, 'in_memoriam_yt');
});
