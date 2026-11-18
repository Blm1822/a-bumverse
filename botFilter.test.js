import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-bots-'));
const db = await import('./db.js');

const OLD_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0';
const OLD_FF = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const NEW_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const OLD_ANDROID = 'Mozilla/5.0 (Linux; Android 7.0; SM-G930V) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const human = () => db.analyticsSummary().today;

test('old desktop browser IDs are bots; current ones and old phones are not', () => {
  assert.equal(db.isOldDesktopBrowser(OLD_EDGE), true);
  assert.equal(db.isOldDesktopBrowser(OLD_FF), true);
  assert.equal(db.isOldDesktopBrowser(NEW_CHROME), false);
  assert.equal(db.isOldDesktopBrowser(OLD_ANDROID), false);
  assert.equal(db.isOldDesktopBrowser(IPHONE), false);
  assert.equal(db.isBotTraffic(OLD_EDGE), true);
  assert.equal(db.isBotTraffic(NEW_CHROME, null, '{search_term_string}'), true);
  assert.equal(db.isBotTraffic(NEW_CHROME), false);
});

test('one visitor opening 100+ different pages becomes a bot; many people sharing a browser ID do not', () => {
  const before = human();
  // 30 real people on the same iPhone + Safari, 5 pages each = 150 distinct pages for that browser ID.
  for (let u = 0; u < 30; u++) for (let i = 0; i < 5; i++) db.logPageView({ path: `/album/p${u}-${i}`, userAgent: IPHONE, ip: `10.0.0.${u}` });
  assert.equal(human() - before, 150);
  // One scraper with the same ID from one address.
  for (let i = 0; i < 130; i++) db.logPageView({ path: `/artist/s${i}`, userAgent: IPHONE, ip: '203.0.113.9' });
  assert.equal(human() - before, 150, 'scraper pages, including its first 100, stop counting');
  assert.equal(db.isBotTraffic(IPHONE, null, null, '203.0.113.9'), true);
  assert.equal(db.isBotTraffic(IPHONE, null, null, '10.0.0.1'), false);
});

test('reclassify catches stored rows from before the new rules', () => {
  const before = human();
  db.logPageView({ path: '/search', query: '{"q":"x"}', userAgent: NEW_CHROME, ip: '10.1.1.1' });
  assert.equal(human() - before, 1);
  assert.ok(db.reclassifyBotTraffic() >= 0);
  assert.equal(human() - before, 1, 'real visit kept');
});
