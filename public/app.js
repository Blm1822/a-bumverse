const homeView = document.getElementById('home-view');
const resultsEl = document.getElementById('results');
const artistEl = document.getElementById('artist');
const albumEl = document.getElementById('album');
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const statsEl = document.getElementById('stats');
const homeLink = document.getElementById('home-link');
const artistsGrid = document.getElementById('artists-grid');
const recentGrid = document.getElementById('recent-grid');

function fmtLength(ms) {
  if (!ms) return '';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function creditTags(list) {
  if (!list || !list.length) return '<span class="empty">—</span>';
  return list
    .map((c) => {
      const name = c.mbid
        ? `<a href="/artist/${c.mbid}" class="artist-link" data-id="${c.mbid}">${escapeHtml(c.name)}</a>`
        : escapeHtml(c.name);
      return `<span class="credit-tag">${name} <span class="role">(${escapeHtml(c.role || '')})</span></span>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setTitle(t) {
  document.title = t ? `${t} — Albumverse` : 'Albumverse';
}

function allViews() {
  return [homeView, resultsEl, artistEl, albumEl];
}

function showOnly(el) {
  for (const v of allViews()) v.classList.toggle('hidden', v !== el);
}

// --- Routing: every view gets a real, bookmarkable/shareable URL, and the
// browser's own back/forward buttons work via popstate. ---

function navigate(path) {
  history.pushState({}, '', path);
  route();
}

function route() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'album' && parts[1]) return renderAlbum(parts[1]);
  if (parts[0] === 'artist' && parts[1]) return renderArtist(parts[1]);
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    input.value = q;
    return renderSearch(q);
  }
  return renderHome();
}

window.addEventListener('popstate', route);

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    statsEl.textContent = `${s.artists.toLocaleString()} artists · ${s.albums.toLocaleString()} albums · ${s.tracks.toLocaleString()} tracks in the database`;
  } catch {
    statsEl.textContent = '';
  }
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function posterWrap(imgUrl, label) {
  const wrap = document.createElement('div');
  wrap.className = 'card-img-wrap';

  function showPlaceholder() {
    const hue = hashHue(label);
    wrap.innerHTML = '';
    wrap.style.background = `linear-gradient(135deg, hsl(${hue}, 55%, 28%), hsl(${(hue + 40) % 360}, 55%, 16%))`;
    const initial = document.createElement('div');
    initial.className = 'card-placeholder';
    initial.textContent = (label || '?').trim().charAt(0).toUpperCase();
    wrap.appendChild(initial);
  }

  if (imgUrl) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.addEventListener('error', showPlaceholder);
    img.src = imgUrl;
    wrap.appendChild(img);
  } else {
    showPlaceholder();
  }
  return wrap;
}

function albumCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(posterWrap(r.coverArtUrl, r.title));
  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <div class="title">${escapeHtml(r.title)}</div>
    <div class="meta">${escapeHtml(r.artist || '')} · ${escapeHtml(r.type || '')}${r.date ? ' · ' + escapeHtml(r.date.slice(0, 4)) : ''}</div>
  `;
  card.appendChild(body);
  card.addEventListener('click', () => navigate(`/album/${r.id}`));
  return card;
}

function artistCard(a) {
  const card = document.createElement('div');
  card.className = 'card';
  card.appendChild(posterWrap(a.coverArtUrl, a.name));
  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <div class="title">${escapeHtml(a.name)}</div>
    <div class="meta">${a.albumCount} album${a.albumCount === 1 ? '' : 's'}${a.disambiguation ? ' · ' + escapeHtml(a.disambiguation) : ''}</div>
  `;
  card.appendChild(body);
  card.addEventListener('click', () => navigate(`/artist/${a.id}`));
  return card;
}

async function renderHomeRails() {
  try {
    const res = await fetch('/api/artists');
    const data = await res.json();
    artistsGrid.innerHTML = '';
    for (const a of data.results || []) artistsGrid.appendChild(artistCard(a));
  } catch {
    artistsGrid.innerHTML = '<p class="empty">Could not load artists.</p>';
  }

  try {
    const res = await fetch('/api/recent');
    const data = await res.json();
    recentGrid.innerHTML = '';
    for (const r of data.results || []) recentGrid.appendChild(albumCard(r));
  } catch {
    recentGrid.innerHTML = '<p class="empty">Could not load recent albums.</p>';
  }
}

let homeTimer = null;

function renderHome() {
  input.value = '';
  setTitle(null);
  showOnly(homeView);
  loadStats();
  renderHomeRails();
  if (!homeTimer) homeTimer = setInterval(() => { if (!homeView.classList.contains('hidden')) renderHomeRails(); }, 10000);
}

async function renderSearch(query) {
  showOnly(resultsEl);
  setTitle(`Search: ${query}`);
  resultsEl.innerHTML = '<div class="loading">Searching…</div>';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.results || !data.results.length) {
      resultsEl.innerHTML = '<p class="empty">No albums found.</p>';
      return;
    }
    resultsEl.innerHTML = '<div class="grid" id="search-grid"></div>';
    const grid = document.getElementById('search-grid');
    for (const r of data.results) grid.appendChild(albumCard(r));
  } catch (err) {
    resultsEl.innerHTML = `<p class="error">Search failed: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderArtist(id) {
  showOnly(artistEl);
  artistEl.innerHTML = '<div class="loading">Loading artist…</div>';
  try {
    const res = await fetch(`/api/artist/${id}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTitle(data.name);

    artistEl.innerHTML = `
      <button class="back-btn" id="artist-back-btn">&larr; Back</button>
      <div class="album-head">
        ${data.coverArtUrl ? `<img src="${data.coverArtUrl}" alt="" onerror="this.style.visibility='hidden'" />` : ''}
        <div>
          <h2>${escapeHtml(data.name)}</h2>
          ${data.disambiguation ? `<div class="sub">${escapeHtml(data.disambiguation)}</div>` : ''}
          ${data.bio ? `<p class="bio">${escapeHtml(data.bio)}</p>` : ''}
          ${data.wikiUrl ? `<a class="wiki-link" href="${data.wikiUrl}" target="_blank" rel="noopener">via Wikipedia</a>` : ''}
        </div>
      </div>
      ${(data.albums || []).length ? `
        <h2 class="section-title">Discography</h2>
        <div class="grid" id="artist-albums-grid"></div>
      ` : ''}
      ${(data.appearances || []).length ? `
        <h2 class="section-title">Appears on</h2>
        <div class="grid" id="artist-appearances-grid"></div>
      ` : ''}
      ${!(data.albums || []).length && !(data.appearances || []).length ? '<p class="empty">Nothing on file for this artist yet.</p>' : ''}
    `;
    document.getElementById('artist-back-btn').addEventListener('click', () => history.back());
    const grid = document.getElementById('artist-albums-grid');
    if (grid) for (const al of data.albums || []) grid.appendChild(albumCard(al));
    const appearGrid = document.getElementById('artist-appearances-grid');
    if (appearGrid) for (const al of data.appearances || []) appearGrid.appendChild(albumCard(al));
  } catch (err) {
    artistEl.innerHTML = `<p class="error">Failed to load artist: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderAlbum(id) {
  showOnly(albumEl);
  albumEl.innerHTML = '<div class="loading">Loading tracklist and credits… (MusicBrainz is rate-limited, this can take a few seconds)</div>';
  try {
    const res = await fetch(`/api/album/${id}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTitle(data.title);

    const rows = data.tracks
      .map(
        (t) => `
        <tr>
          <td>${t.position}</td>
          <td>${escapeHtml(t.title)}</td>
          <td>${fmtLength(t.length)}</td>
          <td>${creditTags(t.writers)}</td>
          <td>${creditTags(t.performers)}</td>
        </tr>`
      )
      .join('');

    const artistLinks = (data.artists || []).length
      ? data.artists.map((a) => `<a href="/artist/${a.id}" class="artist-link" data-id="${a.id}">${escapeHtml(a.name)}</a>`).join(', ')
      : escapeHtml(data.artist);

    albumEl.innerHTML = `
      <button class="back-btn" id="back-btn">&larr; Back</button>
      <div class="album-head">
        <img src="${data.coverArtUrl}" alt="" onerror="this.style.visibility='hidden'" />
        <div>
          <h2>${escapeHtml(data.title)}</h2>
          <div class="sub">${artistLinks} · ${escapeHtml(data.type)}${data.date ? ' · ' + escapeHtml(data.date) : ''}</div>
          ${data.label ? `<div class="sub">Label: ${escapeHtml(data.label)}</div>` : ''}
        </div>
      </div>
      <div class="table-scroll">
        <table class="tracks">
          <thead>
            <tr><th>#</th><th>Title</th><th>Length</th><th>Writers</th><th>Performers</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => history.back());
    for (const link of albumEl.querySelectorAll('.artist-link')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.getAttribute('href'));
      });
    }
  } catch (err) {
    albumEl.innerHTML = `<p class="error">Failed to load album: ${escapeHtml(err.message)}</p>`;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  else navigate('/');
});

homeLink.addEventListener('click', (e) => {
  e.preventDefault();
  navigate('/');
});

route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
