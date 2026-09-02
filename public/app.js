const homeView = document.getElementById('home-view');
const resultsEl = document.getElementById('results');
const artistEl = document.getElementById('artist');
const albumEl = document.getElementById('album');
const decadeEl = document.getElementById('decade');
const genreEl = document.getElementById('genre');
const artistsPageEl = document.getElementById('artists-page');
const recentPageEl = document.getElementById('recent-page');
const navArtists = document.getElementById('nav-artists');
const navRecent = document.getElementById('nav-recent');
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const statsEl = document.getElementById('stats');
const homeLink = document.getElementById('home-link');
const artistsGrid = document.getElementById('artists-grid');
const recentGrid = document.getElementById('recent-grid');
const suggestDropdown = document.getElementById('suggest-dropdown');

// Fired once at load, awaited inside renderArtist() so even the first artist
// page view (not just later ones) gets the affiliate tag if one's set.
const configPromise = fetch('/api/config').then((r) => r.json()).catch(() => ({}));

function merchLink(artistName, amazonAssociateTag) {
  const q = encodeURIComponent(`${artistName} merch`);
  const tag = amazonAssociateTag ? `&tag=${encodeURIComponent(amazonAssociateTag)}` : '';
  return `https://www.amazon.com/s?k=${q}${tag}`;
}

// Search links, not deep links - we have no API access/credentials for any
// of these services, so this is "good enough, zero setup" the same way the
// merch link is a plain Amazon search rather than a matched product page.
function listenLinks(artistName, albumTitle) {
  const q = encodeURIComponent(`${artistName} ${albumTitle}`);
  return [
    { name: 'Spotify', url: `https://open.spotify.com/search/${q}` },
    { name: 'Apple Music', url: `https://music.apple.com/us/search?term=${q}` },
    { name: 'YouTube Music', url: `https://music.youtube.com/search?q=${q}` },
  ];
}

// SeatGeek search - not a real ticket marketplace of our own (no
// tickets ever change hands here), same "search link, no API key"
// approach as merchLink/listenLinks. SeatGeek runs a real affiliate
// program, so this is a genuine future revenue path once there's an
// account behind it, same story as Amazon Associates.
function ticketsLink(artistName) {
  return `https://seatgeek.com/search?search=${encodeURIComponent(artistName)}`;
}

// Shared by album/artist pages. Scoped to a class + container query (not a
// global id) since a hidden previously-rendered page's old DOM can still be
// sitting around (showOnly() hides views, it doesn't remove their content),
// and a bare getElementById could silently grab the wrong page's button.
function shareLinksHtml(shareText) {
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(window.location.href)}`;
  return `
    <div class="share-links">
      <a href="${tweetUrl}" class="share-link" target="_blank" rel="noopener">Share on X</a>
      <button type="button" class="share-link copy-link-btn">Copy link</button>
    </div>
  `;
}

function wireShareLinks(container) {
  const btn = container.querySelector('.copy-link-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      // Clipboard API unavailable (unusual, but non-fatal) - link is still
      // shareable manually from the address bar either way.
    }
  });
}

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
  return [homeView, resultsEl, artistEl, albumEl, decadeEl, genreEl, artistsPageEl, recentPageEl];
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
  navArtists.classList.toggle('active', parts[0] === 'artists');
  navRecent.classList.toggle('active', parts[0] === 'recent');
  if (parts[0] === 'album' && parts[1]) return renderAlbum(parts[1]);
  if (parts[0] === 'artist' && parts[1]) return renderArtist(parts[1]);
  if (parts[0] === 'decade' && parts[1]) return renderDecade(parts[1]);
  if (parts[0] === 'genre') {
    const g = new URLSearchParams(location.search).get('name');
    if (g) return renderGenre(g);
  }
  if (parts[0] === 'artists' && !parts[1]) return renderArtistsPage();
  if (parts[0] === 'recent' && !parts[1]) return renderRecentPage();
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

async function loadHero() {
  const heroEl = document.getElementById('hero');
  try {
    const res = await fetch('/api/featured');
    const data = await res.json();
    if (!data || !data.id) {
      heroEl.classList.add('hidden');
      return;
    }
    heroEl.classList.remove('hidden');
    heroEl.innerHTML = `
      <div class="hero-art">${data.imageUrl ? `<img src="${data.imageUrl}" alt="" onerror="this.parentElement.style.visibility='hidden'" />` : ''}</div>
      <div class="hero-body">
        <div class="hero-eyebrow">Featured artist</div>
        <h1>${escapeHtml(data.name)}</h1>
        <div class="hero-meta">${data.disambiguation ? escapeHtml(data.disambiguation) : 'Browse the discography'}</div>
        <button class="hero-cta" type="button">View discography &rarr;</button>
      </div>
    `;
    heroEl.onclick = () => navigate(`/artist/${data.id}`);
  } catch {
    heroEl.classList.add('hidden');
  }
}

async function loadTrending() {
  const section = document.getElementById('trending-section');
  const rail = document.getElementById('trending-rail');
  try {
    const res = await fetch('/api/trending');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    rail.innerHTML = '';
    for (const t of items) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'trend-pill';
      pill.textContent = t.query;
      pill.addEventListener('click', () => navigate(`/search?q=${encodeURIComponent(t.query)}`));
      rail.appendChild(pill);
    }
  } catch {
    section.classList.add('hidden');
  }
}

function updateBrowseSelectSectionVisibility() {
  const anyVisible = !document.getElementById('decades-section').classList.contains('hidden')
    || !document.getElementById('genres-section').classList.contains('hidden');
  document.getElementById('browse-select-section').classList.toggle('hidden', !anyVisible);
}

async function loadDecades() {
  const group = document.getElementById('decades-section');
  const select = document.getElementById('decades-select');
  try {
    const res = await fetch('/api/decades');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      group.classList.add('hidden');
      updateBrowseSelectSectionVisibility();
      return;
    }
    group.classList.remove('hidden');
    updateBrowseSelectSectionVisibility();
    select.innerHTML = '<option value="">Choose a decade&hellip;</option>'
      + items.map((d) => `<option value="${d.decade}">${d.decade}s (${d.n})</option>`).join('');
  } catch {
    group.classList.add('hidden');
    updateBrowseSelectSectionVisibility();
  }
}

async function renderDecade(decade) {
  showOnly(decadeEl);
  setTitle(`${decade}s`);
  decadeEl.innerHTML = '<div class="loading">Loading…</div>';
  const decadeUrl = `/api/decade/${decade}`;
  try {
    const res = await fetch(decadeUrl);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const items = data.results || [];
    decadeEl.innerHTML = `
      <button class="back-btn" id="decade-back-btn">&larr; Back</button>
      <h2 class="section-title">${escapeHtml(decade)}s <span class="credits-source">A&ndash;Z by title</span></h2>
      ${items.length ? `
        <div class="grid" id="decade-grid"></div>
        <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="decade-load-more">Load more</button></div>
      ` : '<p class="empty">No albums on file for this decade yet.</p>'}
    `;
    document.getElementById('decade-back-btn').addEventListener('click', () => history.back());
    const grid = document.getElementById('decade-grid');
    if (!grid) return;
    for (const al of items) grid.appendChild(albumCard(al));

    let offset = items.length;
    const total = data.total || 0;
    const button = document.getElementById('decade-load-more');
    button.parentElement.classList.toggle('hidden', offset >= total);
    button.addEventListener('click', async () => {
      const next = await loadPage({ url: decadeUrl, grid, button, offset, cardFn: albumCard });
      offset = next.offset;
    });
  } catch (err) {
    decadeEl.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

// Shared "load more" pager for the /artists and /recent browse pages: fetches
// a page of items, appends cards to `grid`, and shows/hides the button
// depending on whether more remain.
async function loadPage({ url, grid, button, offset, cardFn }) {
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}offset=${offset}`);
    const data = await res.json();
    const items = data.results || [];
    for (const item of items) grid.appendChild(cardFn(item));
    const newOffset = offset + items.length;
    const hasMore = newOffset < (data.total || 0);
    button.disabled = false;
    button.textContent = 'Load more';
    button.parentElement.classList.toggle('hidden', !hasMore);
    return { offset: newOffset, total: data.total || 0 };
  } catch {
    button.disabled = false;
    button.textContent = 'Load more';
    return { offset, total: offset };
  }
}

async function renderArtistsPage() {
  showOnly(artistsPageEl);
  setTitle('Artists');
  artistsPageEl.innerHTML = `
    <h2 class="section-title">Artists</h2>
    <div class="grid" id="artists-page-grid"></div>
    <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="artists-load-more">Load more</button></div>
  `;
  const grid = document.getElementById('artists-page-grid');
  const button = document.getElementById('artists-load-more');
  let offset = 0;
  const first = await loadPage({ url: '/api/artists/all', grid, button, offset, cardFn: artistCard });
  offset = first.offset;
  button.addEventListener('click', async () => {
    const next = await loadPage({ url: '/api/artists/all', grid, button, offset, cardFn: artistCard });
    offset = next.offset;
  });
}

async function renderRecentPage() {
  showOnly(recentPageEl);
  setTitle('Recently added');
  recentPageEl.innerHTML = `
    <h2 class="section-title">Recently added</h2>
    <div class="grid" id="recent-page-grid"></div>
    <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="recent-load-more">Load more</button></div>
  `;
  const grid = document.getElementById('recent-page-grid');
  const button = document.getElementById('recent-load-more');
  let offset = 0;
  const first = await loadPage({ url: '/api/recent/all', grid, button, offset, cardFn: albumCard });
  offset = first.offset;
  button.addEventListener('click', async () => {
    const next = await loadPage({ url: '/api/recent/all', grid, button, offset, cardFn: albumCard });
    offset = next.offset;
  });
}

async function loadGenres() {
  const group = document.getElementById('genres-section');
  const select = document.getElementById('genres-select');
  try {
    const res = await fetch('/api/genres');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      group.classList.add('hidden');
      updateBrowseSelectSectionVisibility();
      return;
    }
    group.classList.remove('hidden');
    updateBrowseSelectSectionVisibility();
    select.innerHTML = '<option value="">Choose a genre&hellip;</option>'
      + items.map((g) => `<option value="${escapeHtml(g.genre)}">${escapeHtml(g.genre)} (${g.n})</option>`).join('');
  } catch {
    group.classList.add('hidden');
    updateBrowseSelectSectionVisibility();
  }
}

async function renderGenre(genre) {
  showOnly(genreEl);
  setTitle(genre);
  genreEl.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const res = await fetch(`/api/genre?name=${encodeURIComponent(genre)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const items = data.results || [];
    genreEl.innerHTML = `
      <button class="back-btn" id="genre-back-btn">&larr; Back</button>
      <h2 class="section-title">${escapeHtml(genre)}</h2>
      ${items.length ? '<div class="grid" id="genre-grid"></div>' : '<p class="empty">No albums on file for this genre yet.</p>'}
    `;
    document.getElementById('genre-back-btn').addEventListener('click', () => history.back());
    const grid = document.getElementById('genre-grid');
    if (grid) for (const al of items) grid.appendChild(albumCard(al));
  } catch (err) {
    genreEl.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
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
  loadHero();
  loadTrending();
  loadDecades();
  loadGenres();
  renderHomeRails();
  if (!homeTimer) {
    homeTimer = setInterval(() => {
      if (homeView.classList.contains('hidden')) return;
      renderHomeRails();
      loadTrending();
    }, 10000);
  }
}

async function renderSearch(query) {
  showOnly(resultsEl);
  setTitle(`Search: ${query}`);
  resultsEl.innerHTML = '<div class="loading">Searching…</div>';
  const searchUrl = `/api/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(searchUrl);
    const data = await res.json();
    if (!data.results || !data.results.length) {
      resultsEl.innerHTML = '<p class="empty">No albums found.</p>';
      return;
    }
    resultsEl.innerHTML = `
      <div class="grid" id="search-grid"></div>
      <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="search-load-more">Load more</button></div>
    `;
    const grid = document.getElementById('search-grid');
    for (const r of data.results) grid.appendChild(albumCard(r));

    let offset = data.results.length;
    const total = data.total || 0;
    const button = document.getElementById('search-load-more');
    button.parentElement.classList.toggle('hidden', offset >= total);
    button.addEventListener('click', async () => {
      const next = await loadPage({ url: searchUrl, grid, button, offset, cardFn: albumCard });
      offset = next.offset;
    });
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
    const config = await configPromise;

    artistEl.innerHTML = `
      <button class="back-btn" id="artist-back-btn">&larr; Back</button>
      <div class="album-head">
        ${data.coverArtUrl ? `<img src="${data.coverArtUrl}" alt="" onerror="this.style.visibility='hidden'" />` : ''}
        <div>
          <h2>${escapeHtml(data.name)}</h2>
          ${data.disambiguation ? `<div class="sub">${escapeHtml(data.disambiguation)}</div>` : ''}
          ${data.bio ? `<p class="bio">${escapeHtml(data.bio)}</p>` : ''}
          <div class="artist-links">
            ${data.wikiUrl ? `<a class="wiki-link" href="${data.wikiUrl}" target="_blank" rel="noopener">via Wikipedia</a>` : ''}
            <a class="tickets-link" href="${ticketsLink(data.name)}" target="_blank" rel="noopener sponsored">Find ${escapeHtml(data.name)} tickets &rarr;</a>
            <a class="merch-link" href="${merchLink(data.name, config.amazonAssociateTag)}" target="_blank" rel="noopener sponsored">Shop ${escapeHtml(data.name)} merch &rarr;</a>
          </div>
          ${shareLinksHtml(`${data.name} — on Albumverse`)}
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
      <div id="similar-artists-section" class="hidden">
        <h2 class="section-title">Similar artists</h2>
        <div class="grid" id="similar-artists-grid"></div>
      </div>
    `;
    document.getElementById('artist-back-btn').addEventListener('click', () => history.back());
    const grid = document.getElementById('artist-albums-grid');
    if (grid) for (const al of data.albums || []) grid.appendChild(albumCard(al));
    const appearGrid = document.getElementById('artist-appearances-grid');
    if (appearGrid) for (const al of data.appearances || []) appearGrid.appendChild(albumCard(al));
    wireShareLinks(artistEl);
    loadSimilarArtists(data.id);
  } catch (err) {
    artistEl.innerHTML = `<p class="error">Failed to load artist: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadSimilarArtists(id) {
  const section = document.getElementById('similar-artists-section');
  const grid = document.getElementById('similar-artists-grid');
  if (!section || !grid) return;
  try {
    const res = await fetch(`/api/artist/${id}/similar`);
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) return;
    for (const a of items) grid.appendChild(artistCard(a));
    section.classList.remove('hidden');
  } catch {
    // leave hidden
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
          ${(data.genres || []).length ? `<div class="genre-tags">${data.genres.map((g) => `<a href="/genre?name=${encodeURIComponent(g)}" class="genre-tag" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</a>`).join('')}</div>` : ''}
          <div class="listen-links">
            ${listenLinks(data.artist, data.title).map((l) => `<a href="${l.url}" class="listen-link" target="_blank" rel="noopener">Listen on ${l.name} &rarr;</a>`).join('')}
          </div>
          ${shareLinksHtml(`${data.title} by ${data.artist} — on Albumverse`)}
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
      ${(data.credits || []).length ? `
        <h2 class="section-title credits-title">Additional credits <span class="credits-source">via Discogs</span></h2>
        <div class="credits-wrap">${creditTags(data.credits)}</div>
      ` : ''}
      <div id="similar-albums-section" class="hidden">
        <h2 class="section-title">Similar albums</h2>
        <div class="grid" id="similar-albums-grid"></div>
      </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => history.back());
    for (const link of albumEl.querySelectorAll('.genre-tag')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.getAttribute('href'));
      });
    }
    for (const link of albumEl.querySelectorAll('.artist-link')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.getAttribute('href'));
      });
    }
    wireShareLinks(albumEl);
    loadSimilarAlbums(data.id);
  } catch (err) {
    albumEl.innerHTML = `<p class="error">Failed to load album: ${escapeHtml(err.message)}</p>`;
  }
}

// Loaded separately from the main album fetch (not baked into
// getAlbumLocal's response) since the SSR route also calls getAlbumLocal
// just to build meta tags/JSON-LD and has no use for this.
async function loadSimilarAlbums(id) {
  const section = document.getElementById('similar-albums-section');
  const grid = document.getElementById('similar-albums-grid');
  if (!section || !grid) return;
  try {
    const res = await fetch(`/api/album/${id}/similar`);
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) return;
    for (const al of items) grid.appendChild(albumCard(al));
    section.classList.remove('hidden');
  } catch {
    // leave hidden
  }
}

// --- Search-box typeahead: local-only, debounced, race-safe (a slow
// response for an earlier keystroke is discarded if a newer one already
// landed). Deliberately hits /api/suggest, never /api/search - the latter
// can fall through to a several-second MusicBrainz retry on thin results,
// which would make typing feel broken. ---

let suggestTimer = null;
let suggestToken = 0;

function closeSuggest() {
  suggestDropdown.classList.add('hidden');
  suggestDropdown.innerHTML = '';
}

function suggestItem(r) {
  const item = document.createElement('div');
  item.className = 'suggest-item';
  item.innerHTML = `
    ${r.coverArtUrl ? `<img class="suggest-thumb" src="${r.coverArtUrl}" alt="" onerror="this.remove()" />` : '<div class="suggest-thumb"></div>'}
    <div class="suggest-text">
      <div class="suggest-title">${escapeHtml(r.title)}</div>
      <div class="suggest-meta">${escapeHtml(r.artist || '')}</div>
    </div>
  `;
  // mousedown (not click) + preventDefault fires before the input's blur
  // would close the dropdown, and keeps focus from ever leaving the input.
  item.addEventListener('mousedown', (e) => {
    e.preventDefault();
    closeSuggest();
    navigate(`/album/${r.id}`);
  });
  return item;
}

input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = input.value.trim();
  if (!q) {
    closeSuggest();
    return;
  }
  suggestTimer = setTimeout(async () => {
    const myToken = ++suggestToken;
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (myToken !== suggestToken) return;
      const items = data.results || [];
      if (!items.length) {
        closeSuggest();
        return;
      }
      suggestDropdown.innerHTML = '';
      for (const r of items) suggestDropdown.appendChild(suggestItem(r));
      suggestDropdown.classList.remove('hidden');
    } catch {
      closeSuggest();
    }
  }, 200);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSuggest();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-input-wrap')) closeSuggest();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  closeSuggest();
  const q = input.value.trim();
  if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  else navigate('/');
});

homeLink.addEventListener('click', (e) => {
  e.preventDefault();
  navigate('/');
});

for (const link of [navArtists, navRecent]) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(link.getAttribute('href'));
  });
}

document.getElementById('decades-select').addEventListener('change', (e) => {
  if (e.target.value) navigate(`/decade/${e.target.value}`);
});
document.getElementById('genres-select').addEventListener('change', (e) => {
  if (e.target.value) navigate(`/genre?name=${encodeURIComponent(e.target.value)}`);
});

route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
