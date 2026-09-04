const homeView = document.getElementById('home-view');
const resultsEl = document.getElementById('results');
const artistEl = document.getElementById('artist');
const albumEl = document.getElementById('album');
const profilePageEl = document.getElementById('profile-page');
const decadeEl = document.getElementById('decade');
const genreEl = document.getElementById('genre');
const artistsPageEl = document.getElementById('artists-page');
const recentPageEl = document.getElementById('recent-page');
const trendingPageEl = document.getElementById('trending-page');
const topRatedPageEl = document.getElementById('top-rated-page');
const onThisDayPageEl = document.getElementById('on-this-day-page');
const navArtists = document.getElementById('nav-artists');
const navRecent = document.getElementById('nav-recent');
const navTrending = document.getElementById('nav-trending');
const navTopRated = document.getElementById('nav-top-rated');
const navOnThisDay = document.getElementById('nav-on-this-day');
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const statsEl = document.getElementById('stats');
const homeLink = document.getElementById('home-link');
const artistsGrid = document.getElementById('artists-grid');
const recentGrid = document.getElementById('recent-grid');
const suggestDropdown = document.getElementById('suggest-dropdown');
const authNavEl = document.getElementById('auth-nav');
const authModalOverlay = document.getElementById('auth-modal-overlay');
const authModalBody = document.getElementById('auth-modal-body');
const authModalClose = document.getElementById('auth-modal-close');

// Fired once at load, awaited inside renderArtist() so even the first artist
// page view (not just later ones) gets the affiliate tag if one's set.
const configPromise = fetch('/api/config').then((r) => r.json()).catch(() => ({}));

// --- Accounts: sign-in state lives in a cookie session (server.js), this is
// just the client-side mirror of it so the UI (nav, rating widgets) knows
// whether to show "sign in" or the signed-in view. ---

let currentUser = null;

// Fired once at load (same pattern as configPromise above), and awaited
// anywhere an initial render needs to know sign-in state before it can
// decide what to show (e.g. the rate widget, or a profile page's "is this
// your own profile" check) - without awaiting this, that render can win a
// race against this fetch on a fresh page load/reload and wrongly render as
// signed-out for a signed-in visitor. Post-login/logout state changes still
// just set currentUser directly and re-render, no re-fetch needed.
const currentUserPromise = fetch('/api/auth/me')
  .then((r) => r.json())
  .catch(() => null)
  .then((data) => {
    currentUser = data;
    renderAuthNav();
    return data;
  });

function renderAuthNav() {
  if (currentUser && currentUser.username) {
    authNavEl.innerHTML = `
      <a href="/user/${encodeURIComponent(currentUser.username)}" class="auth-username-link" id="auth-profile-link">${escapeHtml(currentUser.username)}</a>
      <button type="button" class="auth-link" id="auth-signout-btn">Sign out</button>
    `;
    document.getElementById('auth-profile-link').addEventListener('click', (e) => {
      e.preventDefault();
      navigate(e.currentTarget.getAttribute('href'));
    });
    document.getElementById('auth-signout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      currentUser = null;
      renderAuthNav();
      route();
    });
  } else {
    authNavEl.innerHTML = '<button type="button" class="auth-link" id="auth-signin-btn">Sign in</button>';
    document.getElementById('auth-signin-btn').addEventListener('click', () => openAuthModal('login'));
  }
}

function closeAuthModal() {
  authModalOverlay.classList.add('hidden');
  authModalBody.innerHTML = '';
}

// Generic modal opener - openAuthModal(mode) is the common case (sign in/up),
// but the recovery-code display step and the reset-password form also need
// the same overlay/close plumbing without going through renderAuthForm.
function showModal(renderFn) {
  renderFn();
  authModalOverlay.classList.remove('hidden');
}

function openAuthModal(mode) {
  showModal(() => renderAuthForm(mode));
}

// Shown once right after signup, and again after a successful reset/
// regenerate (each of those rotates the code, so the old one on screen
// stops working the moment a new one is issued) - this is the only time the
// raw code is ever visible, since only its hash is stored.
function renderRecoveryCodeStep(code, { message, continueLabel, onContinue }) {
  authModalBody.innerHTML = `
    <h2>Save your recovery code</h2>
    <p class="auth-recovery-hint">${escapeHtml(message)}</p>
    <div class="recovery-code">${escapeHtml(code)}</div>
    <button type="button" class="auth-link" id="recovery-copy-btn">Copy code</button>
    <div class="recovery-continue-wrap">
      <button type="button" class="auth-submit" id="recovery-continue-btn">${escapeHtml(continueLabel)}</button>
    </div>
  `;
  document.getElementById('recovery-copy-btn').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(code);
      const btn = e.currentTarget;
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      // Clipboard API unavailable - the code is still selectable/visible to copy by hand.
    }
  });
  document.getElementById('recovery-continue-btn').addEventListener('click', onContinue);
}

function renderResetForm() {
  authModalBody.innerHTML = `
    <h2>Reset your password</h2>
    <form id="reset-form">
      <label class="auth-label">Username
        <input type="text" id="reset-username" autocomplete="username" required />
      </label>
      <label class="auth-label">Recovery code
        <input type="text" id="reset-code" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required />
      </label>
      <label class="auth-label">New password
        <input type="password" id="reset-password" autocomplete="new-password" required />
      </label>
      <p class="auth-error hidden" id="auth-error"></p>
      <button type="submit" class="auth-submit">Reset password</button>
    </form>
    <button type="button" class="auth-switch" id="auth-back-to-login-btn">Back to sign in</button>
  `;
  document.getElementById('auth-back-to-login-btn').addEventListener('click', () => renderAuthForm('login'));
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reset-username').value.trim();
    const recoveryCode = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, recoveryCode, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Could not reset your password.';
        errorEl.classList.remove('hidden');
        return;
      }
      renderRecoveryCodeStep(data.recoveryCode, {
        message: 'Your password was reset and every other signed-in session was signed out. Your recovery code was refreshed too - the old one no longer works. Save this new one somewhere safe.',
        continueLabel: 'Continue to sign in',
        onContinue: () => renderAuthForm('login'),
      });
    } catch {
      errorEl.textContent = 'Network error - try again.';
      errorEl.classList.remove('hidden');
    }
  });
}

function renderAuthForm(mode) {
  const isLogin = mode === 'login';
  authModalBody.innerHTML = `
    <h2>${isLogin ? 'Sign in' : 'Create an account'}</h2>
    <form id="auth-form">
      <label class="auth-label">Username
        <input type="text" id="auth-username" autocomplete="username" required />
      </label>
      <label class="auth-label">Password
        <input type="password" id="auth-password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required />
      </label>
      <p class="auth-error hidden" id="auth-error"></p>
      <button type="submit" class="auth-submit">${isLogin ? 'Sign in' : 'Create account'}</button>
    </form>
    ${isLogin ? '<button type="button" class="auth-switch" id="auth-forgot-btn">Forgot password?</button>' : ''}
    <button type="button" class="auth-switch" id="auth-switch-btn">${isLogin ? 'Need an account? Sign up' : 'Already have an account? Sign in'}</button>
  `;
  if (isLogin) {
    document.getElementById('auth-forgot-btn').addEventListener('click', () => renderResetForm());
  }
  document.getElementById('auth-switch-btn').addEventListener('click', () => renderAuthForm(isLogin ? 'signup' : 'login'));
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');
    errorEl.classList.add('hidden');
    try {
      const res = await fetch(`/api/auth/${isLogin ? 'login' : 'signup'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Something went wrong.';
        errorEl.classList.remove('hidden');
        return;
      }
      currentUser = { id: data.id, username: data.username };
      renderAuthNav();
      if (!isLogin && data.recoveryCode) {
        renderRecoveryCodeStep(data.recoveryCode, {
          message: "This code is the only way back into your account if you forget your password - we can't recover it for you, so save it somewhere safe now.",
          continueLabel: "I've saved it - continue",
          onContinue: () => { closeAuthModal(); route(); },
        });
      } else {
        closeAuthModal();
        route();
      }
    } catch {
      errorEl.textContent = 'Network error - try again.';
      errorEl.classList.remove('hidden');
    }
  });
}

authModalClose.addEventListener('click', closeAuthModal);
authModalOverlay.addEventListener('click', (e) => {
  if (e.target === authModalOverlay) closeAuthModal();
});

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
  return [homeView, resultsEl, artistEl, albumEl, decadeEl, genreEl, artistsPageEl, recentPageEl, trendingPageEl, topRatedPageEl, onThisDayPageEl, profilePageEl];
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
  navTrending.classList.toggle('active', parts[0] === 'trending');
  navTopRated.classList.toggle('active', parts[0] === 'top-rated');
  navOnThisDay.classList.toggle('active', parts[0] === 'on-this-day');
  if (parts[0] === 'album' && parts[1]) return renderAlbum(parts[1]);
  if (parts[0] === 'artist' && parts[1]) return renderArtist(parts[1]);
  if (parts[0] === 'user' && parts[1]) return renderProfilePage(parts[1]);
  if (parts[0] === 'decade' && parts[1]) return renderDecade(parts[1]);
  if (parts[0] === 'genre') {
    const g = new URLSearchParams(location.search).get('name');
    if (g) return renderGenre(g);
  }
  if (parts[0] === 'artists' && !parts[1]) return renderArtistsPage();
  if (parts[0] === 'recent' && !parts[1]) return renderRecentPage();
  if (parts[0] === 'trending' && !parts[1]) return renderTrendingPage();
  if (parts[0] === 'top-rated' && !parts[1]) return renderTopRatedPage();
  if (parts[0] === 'on-this-day' && !parts[1]) return renderOnThisDayPage();
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

async function loadOnThisDay() {
  const section = document.getElementById('on-this-day-section');
  const rail = document.getElementById('on-this-day-rail');
  const titleEl = document.getElementById('on-this-day-title');
  try {
    const res = await fetch('/api/on-this-day');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    titleEl.textContent = `On this day: ${data.label}`;
    rail.innerHTML = '';
    for (const al of items) rail.appendChild(albumCard(al));
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

async function renderOnThisDayPage() {
  showOnly(onThisDayPageEl);
  onThisDayPageEl.innerHTML = '<div class="loading">Loading…</div>';
  const url = '/api/on-this-day/all';
  try {
    const res = await fetch(url);
    const data = await res.json();
    const items = data.results || [];
    setTitle(`On this day: ${data.label}`);
    onThisDayPageEl.innerHTML = `
      <button class="back-btn" id="otd-back-btn">&larr; Back</button>
      <h2 class="section-title">Released on ${escapeHtml(data.label)}</h2>
      <p class="hint">Albums in the database first released on this date, across every year on file.</p>
      ${items.length ? `
        <div class="grid" id="otd-grid"></div>
        <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="otd-load-more">Load more</button></div>
      ` : '<p class="empty">No albums on file with a confirmed release date of exactly this day - check back tomorrow, or browse a decade or genre instead.</p>'}
    `;
    document.getElementById('otd-back-btn').addEventListener('click', () => history.back());
    const grid = document.getElementById('otd-grid');
    if (!grid) return;
    for (const al of items) grid.appendChild(albumCard(al));

    let offset = items.length;
    const total = data.total || 0;
    const button = document.getElementById('otd-load-more');
    button.parentElement.classList.toggle('hidden', offset >= total);
    button.addEventListener('click', async () => {
      const next = await loadPage({ url, grid, button, offset, cardFn: albumCard });
      offset = next.offset;
    });
  } catch (err) {
    onThisDayPageEl.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
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

async function renderTrendingPage() {
  showOnly(trendingPageEl);
  setTitle('Trending this week');
  trendingPageEl.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const res = await fetch('/api/trending-albums');
    const data = await res.json();
    const items = data.results || [];
    trendingPageEl.innerHTML = `
      <h2 class="section-title">Trending this week</h2>
      <p class="hint">The most-viewed albums on Albumverse over the last 7 days. Also see <a href="/top-rated" id="see-top-rated-link">top rated albums</a>.</p>
      ${items.length ? '<div class="chart-list" id="chart-list"></div>' : '<p class="empty">Not enough traffic yet this week to rank anything - check back soon.</p>'}
    `;
    document.getElementById('see-top-rated-link').addEventListener('click', (e) => {
      e.preventDefault();
      navigate('/top-rated');
    });
    const list = document.getElementById('chart-list');
    if (!list) return;
    items.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'chart-row';

      const rank = document.createElement('div');
      rank.className = 'chart-rank';
      rank.textContent = i + 1;
      row.appendChild(rank);

      const thumb = posterWrap(r.coverArtUrl, r.title);
      thumb.classList.add('chart-thumb');
      row.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'chart-info';
      info.innerHTML = `
        <div class="chart-title">${escapeHtml(r.title)}</div>
        <div class="chart-meta">${escapeHtml(r.artist || '')}${r.date ? ' · ' + escapeHtml(r.date.slice(0, 4)) : ''}</div>
      `;
      row.appendChild(info);

      const views = document.createElement('div');
      views.className = 'chart-views';
      views.textContent = `${r.views.toLocaleString()} view${r.views === 1 ? '' : 's'}`;
      row.appendChild(views);

      row.addEventListener('click', () => navigate(`/album/${r.id}`));
      list.appendChild(row);
    });
  } catch (err) {
    trendingPageEl.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderTopRatedPage() {
  showOnly(topRatedPageEl);
  setTitle('Top rated albums');
  topRatedPageEl.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const res = await fetch('/api/top-rated');
    const data = await res.json();
    const items = data.results || [];
    topRatedPageEl.innerHTML = `
      <h2 class="section-title">Top rated albums</h2>
      <p class="hint">The highest user-rated albums on Albumverse (needs a few ratings to qualify). Also see <a href="/trending" id="see-trending-link">what's trending this week</a>.</p>
      ${items.length ? '<div class="chart-list" id="chart-list"></div>' : '<p class="empty">Not enough ratings yet to rank anything - be the first to rate an album!</p>'}
    `;
    document.getElementById('see-trending-link').addEventListener('click', (e) => {
      e.preventDefault();
      navigate('/trending');
    });
    const list = document.getElementById('chart-list');
    if (!list) return;
    items.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'chart-row';

      const rank = document.createElement('div');
      rank.className = 'chart-rank';
      rank.textContent = i + 1;
      row.appendChild(rank);

      const thumb = posterWrap(r.coverArtUrl, r.title);
      thumb.classList.add('chart-thumb');
      row.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'chart-info';
      info.innerHTML = `
        <div class="chart-title">${escapeHtml(r.title)}</div>
        <div class="chart-meta">${escapeHtml(r.artist || '')}${r.date ? ' · ' + escapeHtml(r.date.slice(0, 4)) : ''}</div>
      `;
      row.appendChild(info);

      const rating = document.createElement('div');
      rating.className = 'chart-views';
      rating.textContent = `${r.average}/10 (${r.count} rating${r.count === 1 ? '' : 's'})`;
      row.appendChild(rating);

      row.addEventListener('click', () => navigate(`/album/${r.id}`));
      list.appendChild(row);
    });
  } catch (err) {
    topRatedPageEl.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
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

async function loadRecentReviews() {
  const section = document.getElementById('recent-reviews-section');
  const list = document.getElementById('recent-reviews-list');
  try {
    const res = await fetch('/api/recent-reviews');
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    list.innerHTML = '';
    for (const r of items) list.appendChild(recentReviewRow(r));
  } catch {
    section.classList.add('hidden');
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
  loadOnThisDay();
  loadDecades();
  loadGenres();
  renderHomeRails();
  loadRecentReviews();
  if (!homeTimer) {
    homeTimer = setInterval(() => {
      if (homeView.classList.contains('hidden')) return;
      renderHomeRails();
      loadTrending();
      loadRecentReviews();
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
          <div class="rating-summary" id="rating-summary">${renderRatingSummaryHtml(data.rating)}</div>
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
      <div id="reviews-section">
        <h2 class="section-title">Ratings &amp; reviews</h2>
        <div id="rate-widget"></div>
        <div id="reviews-list"></div>
        <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="reviews-load-more">Load more</button></div>
      </div>
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
    loadReviews(data.id);
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

// --- Ratings & reviews: a 1-10 score plus optional text, one per user per
// album (posting again just updates it - see the upsert in db.js). The
// average badge (renderRatingSummaryHtml) is always shown; the interactive
// picker below it only renders once we know whether the visitor is signed in
// and, if so, whether they've already rated this album. ---

function renderRatingSummaryHtml(rating) {
  return rating && rating.count
    ? `<span class="rating-score">${rating.average}</span><span class="rating-outof">/10</span><span class="rating-count">(${rating.count} rating${rating.count === 1 ? '' : 's'})</span>`
    : '<span class="rating-none">Not yet rated</span>';
}

function updateRatingSummary(rating) {
  const el = document.getElementById('rating-summary');
  if (el) el.innerHTML = renderRatingSummaryHtml(rating);
}

function renderRateWidget(albumId, yourReview) {
  const widget = document.getElementById('rate-widget');
  if (!widget) return;

  if (!currentUser) {
    widget.innerHTML = '<button type="button" class="auth-link" id="rate-signin-btn">Sign in to rate this album</button>';
    document.getElementById('rate-signin-btn').addEventListener('click', () => openAuthModal('login'));
    return;
  }

  let picked = yourReview ? yourReview.rating : 0;
  const picks = Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button type="button" class="rate-num${n === picked ? ' selected' : ''}" data-n="${n}">${n}</button>`)
    .join('');
  widget.innerHTML = `
    <div class="rate-picker">${picks}</div>
    <textarea id="rate-body" placeholder="Write a review (optional)" maxlength="4000">${escapeHtml((yourReview && yourReview.body) || '')}</textarea>
    <div class="rate-actions">
      <button type="button" class="rate-submit" id="rate-submit-btn"${picked ? '' : ' disabled'}>${yourReview ? 'Update rating' : 'Submit rating'}</button>
      ${yourReview ? '<button type="button" class="rate-remove" id="rate-remove-btn">Remove my rating</button>' : ''}
    </div>
    <p class="auth-error hidden" id="rate-error"></p>
  `;

  const buttons = widget.querySelectorAll('.rate-num');
  const submitBtn = document.getElementById('rate-submit-btn');
  for (const b of buttons) {
    b.addEventListener('click', () => {
      picked = Number(b.dataset.n);
      for (const b2 of buttons) b2.classList.toggle('selected', Number(b2.dataset.n) === picked);
      submitBtn.disabled = false;
    });
  }

  submitBtn.addEventListener('click', async () => {
    const errorEl = document.getElementById('rate-error');
    errorEl.classList.add('hidden');
    try {
      const res = await fetch(`/api/album/${albumId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: picked, body: document.getElementById('rate-body').value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'Could not save your rating.';
        errorEl.classList.remove('hidden');
        return;
      }
      updateRatingSummary(data.rating);
      loadReviews(albumId);
    } catch {
      errorEl.textContent = 'Network error - try again.';
      errorEl.classList.remove('hidden');
    }
  });

  const removeBtn = document.getElementById('rate-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      const res = await fetch(`/api/album/${albumId}/review`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        updateRatingSummary(data.rating);
        loadReviews(albumId);
      }
    });
  }
}

function reviewRow(r) {
  const row = document.createElement('div');
  row.className = 'review-row';
  row.innerHTML = `
    <div class="review-head">
      <a href="/user/${encodeURIComponent(r.username)}" class="review-user-link">${escapeHtml(r.username)}</a>
      <span class="review-rating">${r.rating}/10</span>
      <span class="review-date">${escapeHtml((r.updatedAt || '').slice(0, 10))}</span>
    </div>
    ${r.body ? `<p class="review-body">${escapeHtml(r.body)}</p>` : ''}
  `;
  row.querySelector('.review-user-link').addEventListener('click', (e) => {
    e.preventDefault();
    navigate(e.currentTarget.getAttribute('href'));
  });
  return row;
}

// Reuses the chart-row/chart-thumb layout the Trending/Top Rated pages use
// (thumbnail + info + a right-aligned figure), just with the album's own
// rating/review text instead of a play/view count - same shape of data.
function profileReviewRow(r) {
  const row = document.createElement('div');
  row.className = 'chart-row profile-review-row';

  const thumb = posterWrap(r.albumCoverArtUrl, r.albumTitle);
  thumb.classList.add('chart-thumb');
  row.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'chart-info';
  info.innerHTML = `
    <div class="chart-title">${escapeHtml(r.albumTitle)}</div>
    <div class="chart-meta">${escapeHtml(r.albumArtist || '')}</div>
    ${r.body ? `<p class="review-body">${escapeHtml(r.body)}</p>` : ''}
  `;
  row.appendChild(info);

  const rating = document.createElement('div');
  rating.className = 'chart-views';
  rating.innerHTML = `${r.rating}/10<br /><span class="review-date">${escapeHtml((r.updatedAt || '').slice(0, 10))}</span>`;
  row.appendChild(rating);

  row.addEventListener('click', () => navigate(`/album/${r.albumId}`));
  return row;
}

// Same row shape as profileReviewRow, but for the homepage's site-wide feed
// (not one person's page) - so who wrote it has to be shown too, as a second
// clickable target alongside the row's own album click, hence stopPropagation
// on the username link so it doesn't also fire the row's navigate-to-album.
function recentReviewRow(r) {
  const row = document.createElement('div');
  row.className = 'chart-row profile-review-row';

  const thumb = posterWrap(r.albumCoverArtUrl, r.albumTitle);
  thumb.classList.add('chart-thumb');
  row.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'chart-info';
  info.innerHTML = `
    <div class="chart-title">${escapeHtml(r.albumTitle)}</div>
    <div class="chart-meta">${escapeHtml(r.albumArtist || '')} &middot; reviewed by <a href="/user/${encodeURIComponent(r.username)}" class="review-user-link">${escapeHtml(r.username)}</a></div>
    ${r.body ? `<p class="review-body">${escapeHtml(r.body)}</p>` : ''}
  `;
  row.appendChild(info);
  info.querySelector('.review-user-link').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(e.currentTarget.getAttribute('href'));
  });

  const rating = document.createElement('div');
  rating.className = 'chart-views';
  rating.textContent = `${r.rating}/10`;
  row.appendChild(rating);

  row.addEventListener('click', () => navigate(`/album/${r.albumId}`));
  return row;
}

async function renderProfilePage(username) {
  showOnly(profilePageEl);
  profilePageEl.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [res] = await Promise.all([fetch(`/api/user/${encodeURIComponent(username)}`), currentUserPromise]);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTitle(`${data.username}'s reviews`);
    const isOwnProfile = !!(currentUser && currentUser.username.toLowerCase() === data.username.toLowerCase());

    profilePageEl.innerHTML = `
      <button class="back-btn" id="profile-back-btn">&larr; Back</button>
      <h2 class="section-title">${escapeHtml(data.username)}</h2>
      <p class="hint">Joined ${escapeHtml((data.createdAt || '').slice(0, 10))}</p>
      ${isOwnProfile ? '<button type="button" class="auth-link profile-action-link" id="regen-recovery-btn">Get a new account recovery code</button>' : ''}
      <div id="profile-reviews-list"></div>
      <div class="load-more-wrap hidden"><button class="load-more-btn" type="button" id="profile-load-more">Load more</button></div>
    `;
    document.getElementById('profile-back-btn').addEventListener('click', () => history.back());
    if (isOwnProfile) {
      document.getElementById('regen-recovery-btn').addEventListener('click', async () => {
        const res = await fetch('/api/auth/recovery-code/regenerate', { method: 'POST' });
        const regen = await res.json();
        if (!res.ok) return;
        showModal(() => renderRecoveryCodeStep(regen.recoveryCode, {
          message: "Any previous recovery code for this account no longer works. Save this new one somewhere safe - it's the only way back in if you forget your password.",
          continueLabel: 'Done',
          onContinue: closeAuthModal,
        }));
      });
    }

    const list = document.getElementById('profile-reviews-list');
    const button = document.getElementById('profile-load-more');
    const url = `/api/user/${encodeURIComponent(username)}/reviews`;
    const first = await loadPage({ url, grid: list, button, offset: 0, cardFn: profileReviewRow });
    if (!first.offset) list.innerHTML = '<p class="empty">No reviews yet.</p>';
    let offset = first.offset;
    button.addEventListener('click', async () => {
      const next = await loadPage({ url, grid: list, button, offset, cardFn: profileReviewRow });
      offset = next.offset;
    });
  } catch (err) {
    profilePageEl.innerHTML = err.message === 'User not found.'
      ? '<p class="error">User not found.</p>'
      : `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadReviews(albumId, offset = 0) {
  const list = document.getElementById('reviews-list');
  const button = document.getElementById('reviews-load-more');
  if (!list) return;
  try {
    // currentUserPromise: renderRateWidget below decides sign-in-prompt vs.
    // the interactive picker off the client-side currentUser variable, which
    // needs to be resolved first or a fresh page load can race it and
    // wrongly render the signed-out state for a signed-in visitor.
    const [res] = await Promise.all([fetch(`/api/album/${albumId}/reviews?offset=${offset}`), currentUserPromise]);
    const data = await res.json();
    const items = data.results || [];

    if (offset === 0) {
      renderRateWidget(albumId, data.yourReview);
      list.innerHTML = items.length ? '' : '<p class="empty">No reviews yet — be the first.</p>';
    }
    for (const r of items) list.appendChild(reviewRow(r));

    const newOffset = offset + items.length;
    const hasMore = newOffset < (data.total || 0);
    if (button) {
      button.onclick = () => loadReviews(albumId, newOffset);
      button.parentElement.classList.toggle('hidden', !hasMore);
    }
  } catch {
    if (offset === 0) list.innerHTML = '<p class="error">Failed to load reviews.</p>';
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

for (const link of [navArtists, navRecent, navTrending, navTopRated, navOnThisDay]) {
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
