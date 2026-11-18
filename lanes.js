// Two lanes for the rate-limited MusicBrainz and Discogs queues: requests made
// for a visitor go first; background jobs (credits refreshes) take the gaps.
// Background code runs inside runInBackground(); everything else is "visitor".
import { AsyncLocalStorage } from 'node:async_hooks';

const ctx = new AsyncLocalStorage();

export function runInBackground(fn) {
  return ctx.run(true, fn);
}

export function isBackground() {
  return ctx.getStore() === true;
}

// A paced queue: one job at a time, `spacingMs` between jobs, visitor jobs first.
export function pacedQueue(spacingMs) {
  const lanes = { visitor: [], background: [] };
  let busy = false;
  const pump = () => {
    if (busy) return;
    const job = lanes.visitor.shift() || lanes.background.shift();
    if (!job) return;
    busy = true;
    job().finally(() => setTimeout(() => { busy = false; pump(); }, spacingMs));
  };
  return {
    add(task) {
      return new Promise((resolve, reject) => {
        (isBackground() ? lanes.background : lanes.visitor).push(() => task().then(resolve, reject));
        pump();
      });
    },
    sizes: () => ({ visitor: lanes.visitor.length, background: lanes.background.length }),
  };
}
