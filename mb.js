// Shared, rate-limited MusicBrainz client. MusicBrainz asks unauthenticated
// clients to stay at ~1 request/second, so every call funnels through one
// serialized queue with an in-memory cache to avoid re-hitting it needlessly.

const MB_ROOT = 'https://musicbrainz.org/ws/2';
export const CAA_ROOT = 'https://coverartarchive.org';
const USER_AGENT = 'Albumverse/0.3.0 (music database project; contact: none)';

let queue = Promise.resolve();
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(`MusicBrainz ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

export function mbFetch(url) {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.data);

  const run = () =>
    runWithRetry(url).then((data) => {
      cache.set(url, { data, expires: Date.now() + CACHE_TTL_MS });
      return data;
    });

  const result = queue.then(() => run());
  queue = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1300)));
  return result;
}

export async function searchReleaseGroups(query, limit = 15) {
  const url = `${MB_ROOT}/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
  const data = await mbFetch(url);
  return (data['release-groups'] || []).map((rg) => ({
    id: rg.id,
    title: rg.title,
    type: rg['primary-type'] || 'Release',
    date: rg['first-release-date'] || '',
    artist: (rg['artist-credit'] || []).map((a) => a.name).join(', '),
  }));
}

export async function searchArtist(name) {
  const url = `${MB_ROOT}/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`;
  const data = await mbFetch(url);
  const best = (data.artists || [])[0];
  if (!best) return null;
  return { mbid: best.id, name: best.name, disambiguation: best.disambiguation || null };
}

export async function getArtistReleaseGroups(artistMbid) {
  const groups = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `${MB_ROOT}/release-group?artist=${artistMbid}&fmt=json&limit=${limit}&offset=${offset}`;
    const data = await mbFetch(url);
    for (const rg of data['release-groups'] || []) {
      groups.push({
        id: rg.id,
        title: rg.title,
        primaryType: rg['primary-type'] || 'Other',
        secondaryTypes: rg['secondary-types'] || [],
        date: rg['first-release-date'] || '',
      });
    }
    offset += limit;
    if (offset >= (data['release-group-count'] || 0)) break;
  }
  return groups;
}

// Pick a representative release for a release-group and pull its full
// tracklist + credits (performers directly, writers via each track's work).
export async function getAlbumDetail(rgId) {
  const rgUrl = `${MB_ROOT}/release-group/${rgId}?inc=releases+artist-credits&fmt=json`;
  const rg = await mbFetch(rgUrl);

  const releases = rg.releases || [];
  if (!releases.length) throw new Error('no releases found for this release-group');
  const chosen = releases.find((r) => r.status === 'Official') || releases[0];

  const relUrl =
    `${MB_ROOT}/release/${chosen.id}` +
    `?inc=recordings+artist-credits+recording-level-rels+work-rels+work-level-rels+labels&fmt=json`;
  const release = await mbFetch(relUrl);

  const tracks = [];
  const workIds = new Set();
  for (const medium of release.media || []) {
    for (const track of medium.tracks || []) {
      const recording = track.recording || {};
      const performers = [];
      let workRef = null;

      for (const rel of recording.relations || []) {
        if (rel['target-type'] === 'artist' && rel.artist) {
          performers.push({
            name: rel.artist.name,
            mbid: rel.artist.id,
            role: rel.attributes && rel.attributes.length ? rel.attributes.join(', ') : rel.type,
          });
        } else if (rel['target-type'] === 'work' && rel.work) {
          workRef = { id: rel.work.id, title: rel.work.title };
          workIds.add(rel.work.id);
        }
      }

      tracks.push({
        position: track.position,
        title: track.title,
        length: track.length,
        artist: (track['artist-credit'] || []).map((a) => a.name).join(', '),
        recordingMbid: recording.id,
        performers,
        workId: workRef ? workRef.id : null,
      });
    }
  }

  const workCredits = {};
  for (const workId of workIds) {
    try {
      const workUrl = `${MB_ROOT}/work/${workId}?inc=artist-rels&fmt=json`;
      const work = await mbFetch(workUrl);
      workCredits[workId] = (work.relations || [])
        .filter((r) => r['target-type'] === 'artist' && r.artist)
        .map((r) => ({
          name: r.artist.name,
          mbid: r.artist.id,
          role: r.attributes && r.attributes.length ? r.attributes.join(', ') : r.type,
        }));
    } catch {
      workCredits[workId] = [];
    }
  }

  for (const t of tracks) {
    t.writers = t.workId ? workCredits[t.workId] || [] : [];
    delete t.workId;
  }

  return {
    id: rg.id,
    title: rg.title,
    type: rg['primary-type'] || 'Release',
    date: release.date || rg['first-release-date'] || '',
    artist: (rg['artist-credit'] || []).map((a) => a.name).join(', '),
    artistCredits: (rg['artist-credit'] || [])
      .filter((a) => a.artist)
      .map((a) => ({ mbid: a.artist.id, name: a.artist.name })),
    label: (release['label-info'] || []).map((l) => l.label && l.label.name).filter(Boolean).join(', '),
    coverArtUrl: `${CAA_ROOT}/release-group/${rg.id}/front-250`,
    tracks,
  };
}
