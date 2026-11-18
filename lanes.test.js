import test from 'node:test';
import assert from 'node:assert/strict';
import { pacedQueue, runInBackground, isBackground } from './lanes.js';

test('visitor requests go ahead of queued background jobs', async () => {
  const q = pacedQueue(5);
  const order = [];
  const job = (name) => () => new Promise((r) => setTimeout(() => { order.push(name); r(name); }, 2));
  const bg = runInBackground(() => Promise.all([q.add(job('bg1')), q.add(job('bg2')), q.add(job('bg3'))]));
  await new Promise((r) => setTimeout(r, 1));
  const visitor = q.add(job('visitor'));
  await Promise.all([bg, visitor]);
  assert.equal(order[0], 'bg1'); // already running
  assert.equal(order[1], 'visitor');
  assert.deepEqual(order.slice(2), ['bg2', 'bg3']);
});

test('background context follows async calls', async () => {
  assert.equal(isBackground(), false);
  await runInBackground(async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(isBackground(), true);
  });
});

test('failures reject only their own caller', async () => {
  const q = pacedQueue(1);
  const bad = q.add(() => Promise.reject(new Error('nope')));
  const good = q.add(() => Promise.resolve(7));
  await assert.rejects(bad, /nope/);
  assert.equal(await good, 7);
});
