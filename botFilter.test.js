import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'av-bots-'));
const db = await import('./db.js');

const OLD_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0';
const OLD_FF = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
// "Current" Chrome moves with the calendar, like the cutoff does.
const NEW_CHROME = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${db.oldBrowserCutoffs().Chrome + 10}.0.0.0 Safari/537.36`;
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

test('Nov 2026 scrapers: rolling version cutoffs, old desktop Safari, forged self-referrers', () => {
  const nov = Date.parse('2026-11-20T12:00:00Z');
  const c = db.oldBrowserCutoffs(nov);
  assert.ok(c.Chrome >= 140 && c.Chrome <= 146, `chrome cutoff ${c.Chrome}`);
  const mac = (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`;
  const win = (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
  const ff = (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
  // Seen in the analytics: all bots now.
  for (const ua of [mac('17.0'), mac('17.2'), win(125), win(130), win(135), ff(128),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.85 Safari/537.36']) {
    assert.equal(db.isOldDesktopBrowser(ua, nov), true, ua);
  }
  // Current browsers, Safari on an older Mac stuck at 17.6, Firefox ESR, and phones: people.
  for (const ua of [mac('17.6'), mac('26.1'), win(154), ff(140), ff(150),
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1']) {
    assert.equal(db.isOldDesktopBrowser(ua, nov), false, ua);
  }
  // A year later the same Chrome 154 counts as old, with no code change.
  assert.equal(db.isOldDesktopBrowser(win(154), Date.parse('2027-12-01T00:00:00Z')), true);
  // Forged referrers.
  const now = mac('26.1');
  assert.equal(db.isBotTraffic(now, 'http://albumverse.com'), true);
  assert.equal(db.isBotTraffic(now, 'http://albumverse.com/'), true);
  assert.equal(db.isBotTraffic(now, 'https://albumverse.com'), true);
  assert.equal(db.isBotTraffic(now, 'https://albumverse.com/'), false);
  assert.equal(db.isBotTraffic(now, 'https://albumverse.com/album/x'), false);
  assert.equal(db.isBotTraffic(now, 'https://www.google.com/'), false);
  assert.equal(db.isBotTraffic(now, 'https://www.google.com'), true, 'Google always sends the slash');
  assert.equal(db.isBotTraffic(now, 'https://duckduckgo.com'), true);
});

test('one visitor opening 40+ different pages in a day is a bot', () => {
  const before = human();
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
  for (let i = 0; i < 35; i++) db.logPageView({ path: `/album/fan${i}`, userAgent: ua, ip: '10.9.9.9' });
  assert.equal(human() - before, 35, 'a keen fan is fine');
  for (let i = 0; i < 10; i++) db.logPageView({ path: `/album/fan-more${i}`, userAgent: ua, ip: '10.9.9.8' });
  for (let i = 0; i < 10; i++) db.logPageView({ path: `/artist/scrape${i}`, userAgent: ua, ip: '10.9.9.9' });
  assert.equal(human() - before, 10, 'past 40 the whole visitor stops counting');
});
