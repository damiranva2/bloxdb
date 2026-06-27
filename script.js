import {
  searchGames,
  searchGamesPage,
  PAGE_SIZE,
  getApiConfig,
  getAllGames,
  getGameById,
  getPopularGames,
  getRecentlyUpdatedGames,
  getMostPlayedGames,
  getMostVisitedGames,
  getSimilarGames,
  getGenres,
  getTags,
  compactNumber,
  fullNumber,
  formatDate,
  getRobloxLikeRatio,
} from './api.js';

import {
  MIN_RATINGS_FOR_TOP,
  getAverageRating,
  getRatingCount,
  getRatingDistribution,
  getReviews,
  getUserRating,
  submitRating,
  getCurrentUserName,
  getTopRatedGameIdsAsync,
  preloadRatings,
  preloadRatingSummaries,
  getCommunityStorageStatus,
  clearLocalRatings,
} from './storage.js';

const app = document.querySelector('#app');
const navLinks = [...document.querySelectorAll('[data-nav]')];
const mobileToggle = document.querySelector('.mobile-toggle');
const siteNav = document.querySelector('.site-nav');
const toast = document.querySelector('#toast');

const DEFAULT_DESCRIPTION = 'BloxDB is a clean Roblox game database with search, Roblox stats, user ratings, reviews and game pages.';

const routeTitle = {
  '/': 'BloxDB — Roblox Game Database',
  '/search': 'Search Roblox Games — BloxDB',
  '/most-played': 'Most Played Roblox Games — BloxDB',
  '/recently-updated': 'Recently Updated Roblox Games — BloxDB',
  '/top-rated': 'Top Rated Roblox Games — BloxDB',
  '/404': 'Not Found — BloxDB',
};

const metaDescription = document.querySelector('meta[name="description"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'description' }));
const canonicalLink = document.querySelector('link[rel="canonical"]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }));
const ogTitle = document.querySelector('meta[property="og:title"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { property: 'og:title' }));
const ogDescription = document.querySelector('meta[property="og:description"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { property: 'og:description' }));

function normalizeBasePath(value) {
  const raw = String(value || '/').trim();
  if (!raw || raw === '/') return '';
  const path = raw.startsWith('http') ? new URL(raw).pathname : raw;
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

const APP_BASE_PATH = normalizeBasePath(window.BLOXDB_BASE_PATH || '/');

function routeUrl(path = '/') {
  const value = String(path || '/');
  const [pathnameRaw, queryString = ''] = value.split('?');
  const pathname = `/${pathnameRaw.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  const url = `${APP_BASE_PATH}${pathname === '/' ? '/' : pathname}`.replace(/\/+/g, '/');
  return `${url}${queryString ? `?${queryString}` : ''}`;
}

function routeHref(path = '/') {
  return escapeHtml(routeUrl(path));
}

function currentRoutePath() {
  let pathname = location.pathname || '/';
  if (APP_BASE_PATH && (pathname === APP_BASE_PATH || pathname.startsWith(`${APP_BASE_PATH}/`))) {
    pathname = pathname.slice(APP_BASE_PATH.length) || '/';
  }
  return pathname.replace(/\/+$/, '') || '/';
}

function currentRouteWithSearch() {
  return `${currentRoutePath()}${location.search || ''}`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function debounce(callback, wait = 250) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), wait);
  };
}

function getRouteParts() {
  return { path: currentRoutePath(), params: new URLSearchParams(location.search) };
}

function navigate(path, { replace = false } = {}) {
  const nextUrl = routeUrl(path);
  if (replace) {
    history.replaceState({}, '', nextUrl);
  } else {
    history.pushState({}, '', nextUrl);
  }
  router();
}

function migrateLegacyHashRoute() {
  if (!location.hash.startsWith('#/')) return;
  const legacyRoute = location.hash.slice(1) || '/';
  history.replaceState({}, '', routeUrl(legacyRoute));
}

function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.className = 'toast';
  }, 3200);
}

function setActiveNav(path) {
  navLinks.forEach((link) => {
    const href = link.getAttribute('href') || '/';
    const targetUrl = new URL(href, location.origin);
    let target = targetUrl.pathname;
    if (APP_BASE_PATH && (target === APP_BASE_PATH || target.startsWith(`${APP_BASE_PATH}/`))) {
      target = target.slice(APP_BASE_PATH.length) || '/';
    }
    target = target.replace(/\/+$/, '') || '/';
    link.classList.toggle('active', path === target);
  });
}

function renderShell(title = routeTitle['/'], description = DEFAULT_DESCRIPTION, canonicalPath = currentRouteWithSearch()) {
  const canonicalUrl = new URL(routeUrl(canonicalPath), location.origin).href;
  document.title = title;
  metaDescription.setAttribute('content', description);
  canonicalLink.setAttribute('href', canonicalUrl);
  ogTitle.setAttribute('content', title);
  ogDescription.setAttribute('content', description);
}

function renderLoading(label = 'Loading BloxDB data...') {
  app.innerHTML = `
    <section class="page loading-page container">
      <div class="skeleton hero-skeleton"></div>
      <div class="section-heading">
        <span class="eyebrow">${escapeHtml(label)}</span>
        <h2 class="skeleton skeleton-line wide"></h2>
      </div>
      <div class="grid cards-grid">
        ${Array.from({ length: 8 }).map(() => `
          <article class="game-card skeleton-card">
            <div class="skeleton card-art"></div>
            <div class="card-body">
              <div class="skeleton skeleton-line"></div>
              <div class="skeleton skeleton-line short"></div>
              <div class="skeleton pill-row"></div>
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderError(error, action = 'Try again') {
  app.innerHTML = `
    <section class="container empty-state page">
      <div class="empty-icon">!</div>
      <h1>Something went wrong</h1>
      <p>${escapeHtml(error?.message || 'BloxDB could not load this page.')}</p>
      <button class="btn primary" data-reload>${escapeHtml(action)}</button>
    </section>
  `;
  app.querySelector('[data-reload]')?.addEventListener('click', () => router());
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function statPill(label, value) {
  return `<span class="stat-pill">${escapeHtml(label)} <strong>${value}</strong></span>`;
}


function imageMarkup(src, alt, className = '') {
  const safeAlt = escapeHtml(alt || 'Roblox game image');
  const safeSrc = src ? escapeHtml(src) : '';
  return `
    <div class="image-shell ${className} ${safeSrc ? 'is-loading' : 'is-placeholder'}">
      ${safeSrc ? `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy">` : ''}
      <div class="image-placeholder" aria-hidden="true">
        <span>BloxDB</span>
        <small>Roblox thumbnail unavailable</small>
      </div>
    </div>
  `;
}

function bindImageStates(root = app) {
  root.querySelectorAll('.image-shell img').forEach((img) => {
    const shell = img.closest('.image-shell');
    const done = () => shell?.classList.remove('is-loading');
    if (img.complete && img.naturalWidth > 0) done();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => {
      shell?.classList.remove('is-loading');
      shell?.classList.add('is-placeholder');
      img.remove();
    }, { once: true });
  });
}

function apiNoticeMarkup(result) {
  if (!result?.fallback && !result?.error) return '';
  const message = result?.fallback
    ? 'Roblox API is unavailable through the Cloudflare Worker right now, so BloxDB is showing local fallback games instead.'
    : result.error?.message || 'Some Roblox data could not be loaded.';
  return `<div class="api-notice" role="status">${escapeHtml(message)}</div>`;
}

function communityStorageNoticeMarkup() {
  const status = getCommunityStorageStatus();
  if (status.remoteOk) return '';

  if (!status.remoteConfigured) {
    return '<div class="api-notice" role="status">Community ratings server is not configured yet. New ratings will not be saved until Cloudflare D1 is connected.</div>';
  }

  if (status.lastError) {
    return `<div class="api-notice" role="status">Community ratings server is unavailable right now. New ratings will not be saved online. ${escapeHtml(status.lastError)}</div>`;
  }

  return '';
}

function bloxDbSummary(gameId) {
  const average = getAverageRating(gameId);
  const count = getRatingCount(gameId);
  if (average === null || count === 0) {
    return {
      average,
      count,
      short: 'No ratings',
      full: 'No BloxDB ratings yet',
      aria: 'No BloxDB ratings yet',
    };
  }

  return {
    average,
    count,
    short: `${average.toFixed(1)} / 10`,
    full: `${average.toFixed(1)} / 10`,
    aria: `${average.toFixed(1)} out of 10 from ${plural(count, 'rating')}`,
  };
}

function gameCard(game, options = {}) {
  const community = bloxDbSummary(game.id);
  const robloxRating = getRobloxLikeRatio(game);
  const compactVisits = compactNumber(game.visits);
  const compactPlayers = compactNumber(game.players);
  const size = options.large ? ' large' : '';

  return `
    <article class="game-card${size}" data-card-id="${game.id}">
      <a class="card-cover" href="${routeHref(`/game/${game.id}`)}" aria-label="Open ${escapeHtml(game.title)}">
        ${imageMarkup(game.cover, `${game.title} cover`, 'card-art-image')}
        <span class="badge genre">${escapeHtml(game.genre || 'Unknown')}</span>
      </a>
      <div class="card-body">
        <div class="card-title-row">
          <a class="card-title" href="${routeHref(`/game/${game.id}`)}">${escapeHtml(game.title)}</a>
          <span class="rating-chip ${community.count ? '' : 'empty'}" title="BloxDB community rating" aria-label="${escapeHtml(community.aria)}">${escapeHtml(community.short)}</span>
        </div>
        <p class="card-summary">${escapeHtml(game.tagline)}</p>
        <div class="meta-row">
          ${statPill('Players', compactPlayers)}
          ${statPill('Visits', compactVisits)}
          ${statPill('Roblox Rating', `${robloxRating.toFixed(0)}%`)}
        </div>
        <div class="card-footer">
          <span>${community.count ? plural(community.count, 'BloxDB rating') : 'No BloxDB ratings yet'}</span>
          <a href="${routeHref(`/game/${game.id}`)}">Details</a>
        </div>
      </div>
    </article>
  `;
}

function emptyState(title, text, actionHref = '/search', actionText = 'Search games') {
  return `
    <div class="empty-state compact">
      <div class="empty-icon">—</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      ${actionHref ? `<a class="btn primary" href="${actionHref}">${escapeHtml(actionText)}</a>` : ''}
    </div>
  `;
}

function sectionTemplate({ eyebrow, title, subtitle, games, actionHref, actionText = 'View all', emptyTitle, emptyText }) {
  return `
    <section class="container content-section reveal">
      <div class="section-heading with-action">
        <div>
          <span class="eyebrow">${escapeHtml(eyebrow)}</span>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        ${actionHref ? `<a class="btn ghost" href="${actionHref}">${escapeHtml(actionText)}</a>` : ''}
      </div>
      ${games.length ? `
        <div class="grid cards-grid">
          ${games.map((game) => gameCard(game)).join('')}
        </div>
      ` : emptyState(emptyTitle || 'No games to show', emptyText || 'This section will appear when data is available.', null)}
    </section>
  `;
}

function sortByBloxDbRating(games) {
  return [...games]
    .filter((game) => getRatingCount(game.id) >= MIN_RATINGS_FOR_TOP)
    .sort((a, b) => {
      const avgDiff = (getAverageRating(b.id) ?? -1) - (getAverageRating(a.id) ?? -1);
      return avgDiff || getRatingCount(b.id) - getRatingCount(a.id);
    });
}

function filterByBloxDbRating(games, minRating) {
  const min = Number(minRating || 0);
  if (!min) return games;
  return games.filter((game) => {
    const average = getAverageRating(game.id);
    return average !== null && average >= min;
  });
}

async function renderHome() {
  renderShell(routeTitle['/']);
  setActiveNav('/');
  renderLoading('Building homepage');

  const [popular, updated, mostPlayed, allGames, mostVisited] = await Promise.all([
    getPopularGames(8),
    getRecentlyUpdatedGames(6),
    getMostPlayedGames(6),
    getAllGames(),
    getMostVisitedGames(4),
  ]);

  const topRatedIds = await getTopRatedGameIdsAsync(6, MIN_RATINGS_FOR_TOP);
  const topRated = (await Promise.all(topRatedIds.map((id) => getGameById(id)))).filter(Boolean);
  const displayedGames = [...popular, ...updated, ...mostPlayed, ...mostVisited, ...topRated].filter(Boolean);
  await preloadRatingSummaries(displayedGames.map((game) => game.id));
  const heroGame = popular[0] || allGames[0];
  if (!heroGame) {
    renderError(new Error('No Roblox games could be loaded. Configure a proxy or try again later.'));
    return;
  }
  const heroCommunity = bloxDbSummary(heroGame.id);

  app.innerHTML = `
    <section class="hero page">
      <div class="container hero-inner">
        <div class="hero-copy reveal">
          <span class="eyebrow">Roblox Game Database</span>
          <h1>Discover, compare and rate Roblox games.</h1>
          <p>BloxDB separates official Roblox statistics from community ratings. Browse active players, visits, Roblox vote ratio, then add your own 1–10 score.</p>
          <form class="hero-search" data-hero-search>
            <span>⌕</span>
            <input name="q" type="search" placeholder="Search Roblox games, genres, creators..." autocomplete="off">
            <button class="btn primary" type="submit">Search</button>
          </form>
          <div class="hero-tags">
            <a href="${routeHref('/search?tag=Horror')}">Horror</a>
            <a href="${routeHref('/search?tag=Simulator')}">Simulator</a>
            <a href="${routeHref('/search?sort=bloxdbRating')}">Top Rated</a>
            <a href="${routeHref('/most-played')}">Most Played</a>
          </div>
        </div>
        <aside class="hero-card reveal" style="--delay: 100ms">
          ${imageMarkup(heroGame.cover, `${heroGame.title} cover`, 'hero-art-image')}
          <div class="hero-card-body">
            <span class="badge">Featured game</span>
            <h2>${escapeHtml(heroGame.title)}</h2>
            <p>${escapeHtml(heroGame.tagline)}</p>
            <div class="hero-score">
              <strong>${escapeHtml(heroCommunity.count ? heroCommunity.short : '—')}</strong>
              <span>${heroCommunity.count ? `${plural(heroCommunity.count, 'BloxDB rating')}` : 'No BloxDB ratings yet'}</span>
            </div>
            <a class="btn primary full" href="${routeHref(`/game/${heroGame.id}`)}">Open game page</a>
          </div>
        </aside>
      </div>
    </section>

    <section class="container metric-strip reveal">
      <div><strong>${fullNumber(allGames.length)}</strong><span>Loaded games</span></div>
      <div><strong>${compactNumber(allGames.reduce((sum, game) => sum + game.players, 0))}</strong><span>Active players</span></div>
      <div><strong>${compactNumber(allGames.reduce((sum, game) => sum + game.visits, 0))}</strong><span>Total visits</span></div>
      <div><strong>${compactNumber(allGames.reduce((sum, game) => sum + getRatingCount(game.id), 0))}</strong><span>BloxDB ratings</span></div>
    </section>

    ${sectionTemplate({
      eyebrow: 'Popular',
      title: 'Popular Roblox Games',
      subtitle: 'Loaded from Roblox API and ranked by active players, visits and activity signals.',
      games: popular,
      actionHref: routeUrl('/search?sort=popular'),
    })}

    ${sectionTemplate({
      eyebrow: 'Recently updated',
      title: 'Recently Updated Games',
      subtitle: 'Games ordered by the latest update date returned by Roblox when available.',
      games: updated,
      actionHref: routeUrl('/recently-updated'),
    })}

    ${sectionTemplate({
      eyebrow: 'Community',
      title: 'Top Rated Roblox Games',
      subtitle: `Only games with at least ${MIN_RATINGS_FOR_TOP} real BloxDB user rating are shown here.`,
      games: topRated,
      actionHref: routeUrl('/top-rated'),
      emptyTitle: 'No rated games yet',
      emptyText: 'Top Rated is empty until someone rates a game on BloxDB.',
    })}

    <section class="container split-showcase reveal">
      <div class="panel">
        <span class="eyebrow">Most Played</span>
        <h2>Active player leaderboard</h2>
        <div class="leader-list">
          ${mostPlayed.slice(0, 5).map((game, index) => `
            <a href="${routeHref(`/game/${game.id}`)}" class="leader-row">
              <span class="rank">#${index + 1}</span>
              ${imageMarkup(game.icon, `${game.title} icon`, 'leader-icon-image')}
              <span>${escapeHtml(game.title)}</span>
              <strong>${compactNumber(game.players)}</strong>
            </a>
          `).join('')}
        </div>
      </div>
      <div class="panel">
        <span class="eyebrow">Most Visited</span>
        <h2>All-time visits</h2>
        <div class="mini-grid">
          ${mostVisited.map((game) => `
            <a class="mini-card" href="${routeHref(`/game/${game.id}`)}">
              ${imageMarkup(game.cover, `${game.title} cover`, 'mini-art-image')}
              <strong>${escapeHtml(game.title)}</strong>
              <span>${compactNumber(game.visits)} visits</span>
            </a>
          `).join('')}
        </div>
      </div>
    </section>
  `;

  app.querySelector('[data-hero-search]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q')?.toString().trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  });

  bindImageStates();
}

function getSearchFiltersFromParams(params) {
  const rawSort = params.get('sort') || 'popular';
  return {
    query: params.get('q') || '',
    sort: rawSort === 'rating' ? 'bloxdbRating' : rawSort,
    minBloxdbRating: params.get('minBloxdbRating') || '0',
    minRobloxRating: params.get('minRobloxRating') || params.get('minRating') || '0',
    minPlayers: params.get('minPlayers') || '0',
    minVisits: params.get('minVisits') || '0',
    updatedWithin: params.get('updatedWithin') || 'any',
    genre: params.get('genre') || 'all',
    tag: params.get('tag') || 'all',
    page: Number(params.get('page') || '1'),
  };
}

function searchUrlFromForm(form) {
  const formData = new FormData(form);
  const params = new URLSearchParams();
  const basePath = form?.dataset.searchBase || '/search';

  for (const [key, value] of formData.entries()) {
    const clean = String(value).trim();
    if (!clean || clean === '0' || clean === 'all' || clean === 'any') continue;
    params.set(key, clean);
  }

  if (basePath !== '/search' && params.get('sort') === form?.dataset.lockSort) params.delete('sort');
  return `${basePath}${params.toString() ? `?${params}` : ''}`;
}

async function renderSearch(options = {}) {
  const { params } = getRouteParts();
  const routePath = options.routePath || '/search';
  const lockSort = options.lockSort || '';
  const filters = {
    ...getSearchFiltersFromParams(params),
    ...(lockSort ? { sort: lockSort } : {}),
  };
  const heading = options.heading || 'Search Roblox Games';
  const eyebrow = options.eyebrow || 'Discover';
  const description = options.description || 'Search uses Roblox API first. BloxDB community scores are stored on the configured community server and are never generated as fake ratings.';

  renderShell(options.title || routeTitle[routePath] || routeTitle['/search']);
  setActiveNav(routePath);
  renderLoading('Searching Roblox API');

  const [genres, tags] = await Promise.all([
    Promise.resolve(getGenres()),
    Promise.resolve(getTags()),
  ]);

  const isCommunitySorted = filters.sort === 'bloxdbRating' || Number(filters.minBloxdbRating) > 0;
  let games = [];
  let result = { games: [], nextCursor: null, source: 'Roblox API', fallback: false, error: null };

  if (isCommunitySorted) {
    const ratedIds = await getTopRatedGameIdsAsync(200, MIN_RATINGS_FOR_TOP);
    games = (await Promise.all(ratedIds.map((id) => getGameById(id)))).filter(Boolean);
    games = filterByBloxDbRating(games, filters.minBloxdbRating);
    if (filters.query) {
      const q = filters.query.toLowerCase();
      games = games.filter((game) => [game.title, game.description, game.creator?.name].join(' ').toLowerCase().includes(q));
    }
    games = sortByBloxDbRating(games);
    result = { games, nextCursor: null, source: 'BloxDB community ratings', fallback: false, error: null };
  } else {
    const page = Math.max(1, Number(filters.page || 1));
    const collected = new Map();
    let lastResult = null;

    for (let currentPage = 1; currentPage <= page; currentPage += 1) {
      lastResult = await searchGamesPage({ ...filters, sort: filters.sort }, { limit: PAGE_SIZE, page: currentPage });
      for (const game of lastResult.games) collected.set(String(game.id), game);
      if (!lastResult.nextCursor) break;
    }

    result = lastResult || result;
    games = [...collected.values()];
  }

  await preloadRatingSummaries(games.map((game) => game.id));

  const loadMoreParams = new URLSearchParams(params);
  if (lockSort && loadMoreParams.get('sort') === lockSort) loadMoreParams.delete('sort');
  loadMoreParams.set('page', String(Math.max(1, Number(filters.page || 1)) + 1));
  const loadMoreHref = routeUrl(`${routePath}?${loadMoreParams.toString()}`);

  app.innerHTML = `
    <section class="container page search-page">
      <div class="page-header reveal">
        <span class="eyebrow">${escapeHtml(eyebrow)}</span>
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>

      ${apiNoticeMarkup(result)}

      <div class="search-layout">
        <aside class="filters-panel reveal">
          <form data-search-form data-search-base="${escapeHtml(routePath)}" data-lock-sort="${escapeHtml(lockSort)}">
            <label class="field">
              <span>Game name</span>
              <input type="search" name="q" value="${escapeHtml(filters.query)}" placeholder="Blox Fruits, horror, pets..." autocomplete="off">
            </label>

            ${lockSort ? `<input type="hidden" name="sort" value="${escapeHtml(lockSort)}">` : `
              <label class="field">
                <span>Sort by</span>
                <select name="sort">
                  ${[
                    ['popular', 'Most popular'],
                    ['newest', 'Recently updated'],
                    ['visits', 'Most visited'],
                    ['bloxdbRating', 'Best BloxDB rating'],
                    ['robloxRating', 'Best Roblox rating'],
                    ['likes', 'Most Roblox upvotes'],
                    ['players', 'Most active players'],
                    ['favorites', 'Most favorites'],
                  ].map(([value, label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
              </label>
            `}

            <label class="field">
              <span>Genre</span>
              <select name="genre">
                <option value="all">All genres</option>
                ${genres.map((genre) => `<option value="${escapeHtml(genre)}" ${filters.genre === genre ? 'selected' : ''}>${escapeHtml(genre)}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Tag</span>
              <select name="tag">
                <option value="all">All tags</option>
                ${tags.map((tag) => `<option value="${escapeHtml(tag)}" ${filters.tag === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Minimum BloxDB rating</span>
              <select name="minBloxdbRating">
                ${[
                  ['0', 'Any BloxDB rating'], ['6', '6 / 10+'], ['7', '7 / 10+'], ['8', '8 / 10+'], ['9', '9 / 10+'],
                ].map(([value, label]) => `<option value="${value}" ${filters.minBloxdbRating === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Minimum Roblox rating</span>
              <select name="minRobloxRating">
                ${[
                  ['0', 'Any Roblox rating'], ['70', '70%+'], ['80', '80%+'], ['85', '85%+'], ['90', '90%+'], ['95', '95%+'],
                ].map(([value, label]) => `<option value="${value}" ${filters.minRobloxRating === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Minimum players</span>
              <select name="minPlayers">
                ${[
                  ['0', 'Any CCU'], ['1000', '1K+'], ['10000', '10K+'], ['25000', '25K+'], ['50000', '50K+'], ['100000', '100K+'],
                ].map(([value, label]) => `<option value="${value}" ${filters.minPlayers === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Minimum visits</span>
              <select name="minVisits">
                ${[
                  ['0', 'Any visits'], ['1000000', '1M+'], ['100000000', '100M+'], ['1000000000', '1B+'], ['5000000000', '5B+'], ['10000000000', '10B+'],
                ].map(([value, label]) => `<option value="${value}" ${filters.minVisits === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>

            <label class="field">
              <span>Updated</span>
              <select name="updatedWithin">
                ${[
                  ['any', 'Any date'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'],
                ].map(([value, label]) => `<option value="${value}" ${filters.updatedWithin === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>

            <div class="filter-actions">
              <button class="btn primary full" type="submit">Apply filters</button>
              <a class="btn ghost full" href="${routeHref(routePath)}">Reset</a>
            </div>
          </form>
        </aside>

        <main class="results-panel reveal" style="--delay: 100ms">
          <div class="results-toolbar">
            <div>
              <strong>${games.length}</strong> loaded game${games.length === 1 ? '' : 's'}
              ${filters.query ? `<span>for “${escapeHtml(filters.query)}”</span>` : ''}
            </div>
            <div class="view-hint">Source: ${escapeHtml(result.source || 'Roblox API')}</div>
          </div>

          ${games.length ? `
            <div class="grid cards-grid results-grid">
              ${games.map((game) => gameCard(game)).join('')}
            </div>
            ${!isCommunitySorted && result.nextCursor ? `
              <div class="load-more-wrap">
                <a class="btn ghost" href="${escapeHtml(loadMoreHref)}">Load more Roblox games</a>
              </div>
            ` : ''}
          ` : emptyState(
            isCommunitySorted ? 'No BloxDB ratings yet' : 'No games found',
            isCommunitySorted ? 'Top Rated and BloxDB rating filters stay empty until users rate games through the online community server.' : 'Try a broader query, clear filters, or check the Cloudflare Worker URL if Roblox data is unavailable.',
            routeUrl(routePath),
            'Clear filters',
          )}
        </main>
      </div>
    </section>
  `;

  const form = app.querySelector('[data-search-form]');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate(searchUrlFromForm(form));
  });

  const updateFromSelect = debounce(() => {
    if (form?.requestSubmit) {
      form.requestSubmit();
      return;
    }
    const next = searchUrlFromForm(form);
    if (next !== currentRouteWithSearch()) navigate(next);
  }, 180);

  form?.querySelectorAll('select').forEach((control) => {
    control.addEventListener('change', updateFromSelect);
  });

  bindImageStates();
}

function statCard(label, value, note) {
  return `
    <div class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ''}
    </div>
  `;
}

function distributionMarkup(gameId) {
  const count = getRatingCount(gameId);
  if (!count) {
    return emptyState('No BloxDB ratings yet', 'The rating distribution will appear after the first user score.', null);
  }

  const distribution = getRatingDistribution(gameId);
  const max = Math.max(1, ...distribution.map((item) => item.count));
  return `
    <div class="rating-chart" aria-label="BloxDB rating distribution from 1 to 10">
      ${distribution.map((item) => `
        <div class="chart-row">
          <span>${item.score}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${item.count ? Math.max(6, (item.count / max) * 100) : 0}%"></div></div>
          <strong>${item.count}</strong>
        </div>
      `).join('')}
    </div>
  `;
}

function reviewsMarkup(gameId) {
  const reviews = getReviews(gameId);
  if (!reviews.length) {
    return `
      <div class="empty-reviews">
        <strong>No BloxDB reviews yet.</strong>
        <p>Reviews appear only when users submit a score with non-empty text.</p>
      </div>
    `;
  }

  return `
    <div class="reviews-list">
      ${reviews.map((review) => `
        <article class="review-card">
          <div class="review-head">
            <div>
              <strong>${escapeHtml(review.user)}</strong>
              <span>${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(review.date))}</span>
            </div>
            <span class="rating-chip">${review.score}/10</span>
          </div>
          <p>${escapeHtml(review.review)}</p>
        </article>
      `).join('')}
    </div>
  `;
}

async function renderGamePage(gameId) {
  renderShell('Game — BloxDB', DEFAULT_DESCRIPTION, `/game/${gameId}`);
  setActiveNav('/game');
  renderLoading('Loading game profile');

  const [game, similar] = await Promise.all([
    getGameById(gameId),
    getSimilarGames(gameId, 4),
  ]);

  if (!game) {
    renderNotFound();
    return;
  }

  await preloadRatings(game.id);
  await preloadRatingSummaries(similar.map((item) => item.id));
  const gameMetaDescription = `See ratings and reviews for ${game.title} on BloxDB. Compare Roblox stats, active players, visits and community scores.`;
  renderShell(`${game.title} Ratings and Reviews — BloxDB`, gameMetaDescription, `/game/${game.id}`);
  const community = bloxDbSummary(game.id);
  const reviews = getReviews(game.id);
  const userRating = getUserRating(game.id);
  const robloxRating = getRobloxLikeRatio(game);

  app.innerHTML = `
    <section class="game-hero page">
      <div class="container game-hero-inner">
        <div class="game-cover reveal">
          ${imageMarkup(game.cover, `${game.title} cover`, 'game-cover-image')}
          <small>${escapeHtml(game.mediaSource || 'Roblox thumbnail')}</small>
        </div>
        <div class="game-hero-content reveal" style="--delay: 100ms">
          <div class="breadcrumbs"><a href="${routeHref('/')}">Home</a><span>/</span><a href="${routeHref('/search')}">Games</a><span>/</span>${escapeHtml(game.title)}</div>
          <div class="title-line">
            <h1>${escapeHtml(game.title)}</h1>
            <span class="badge genre">${escapeHtml(game.genre || 'Unknown')}</span>
          </div>
          <p class="tagline">${escapeHtml(game.tagline)}</p>
          <div class="quick-stats">
            ${statPill('Active Players', compactNumber(game.players))}
            ${statPill('Visits', compactNumber(game.visits))}
            ${statPill('Roblox Rating', `${robloxRating.toFixed(1)}%`)}
            ${statPill('BloxDB', community.full)}
          </div>
          <div class="action-row">
            <a class="btn primary" href="${escapeHtml(game.playUrl)}" target="_blank" rel="noreferrer">Play on Roblox</a>
            <a class="btn ghost" href="${routeHref(`/search?genre=${encodeURIComponent(game.genre)}`)}">More ${escapeHtml(game.genre)} games</a>
          </div>
        </div>
      </div>
    </section>

    <section class="container game-layout">
      <main class="game-main reveal">
        <section class="panel">
          <div class="section-heading small-heading">
            <span class="eyebrow">Roblox Stats</span>
            <h2>Official Roblox data</h2>
            <p>These values are separate from BloxDB user ratings.</p>
          </div>
          <div class="stats-grid roblox-stats-grid">
            ${statCard('Active Players', fullNumber(game.players), 'Current players / CCU')}
            ${statCard('Visits', compactNumber(game.visits), fullNumber(game.visits))}
            ${statCard('Upvotes', compactNumber(game.upvotes), fullNumber(game.upvotes))}
            ${statCard('Downvotes', compactNumber(game.downvotes), fullNumber(game.downvotes))}
            ${statCard('Roblox Rating', `${robloxRating.toFixed(1)}%`, 'Positive vote ratio')}
            ${statCard('Favorites', compactNumber(game.favorites), fullNumber(game.favorites))}
            ${statCard('Last Updated', formatDate(game.updatedAt), `Created ${formatDate(game.createdAt)}`)}
            ${statCard('Creator', escapeHtml(game.creator?.name || 'Unknown'), game.creator?.type || '')}
          </div>
          <div class="description-block">
            <h3>Description</h3>
            <p>${escapeHtml(game.description || 'No description available.')}</p>
          </div>
          <div class="tag-cloud">
            ${(game.tags || []).map((tag) => `<a href="${routeHref(`/search?tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`).join('')}
          </div>
        </section>

        <section class="panel community-panel">
          <div class="section-heading small-heading">
            <span class="eyebrow">BloxDB Community Rating</span>
            <h2>User score and reviews</h2>
            <p>BloxDB scores are calculated only from real user ratings synced through the BloxDB community server.</p>
          </div>

          ${communityStorageNoticeMarkup()}

          <div class="community-grid">
            <div class="rating-summary">
              <div class="score-box">
                <strong data-average-score>${community.count ? community.average.toFixed(1) : '—'}</strong>
                <span>/ 10</span>
              </div>
              <p data-rating-caption>${community.count ? `${plural(community.count, 'user rating')}. ${userRating ? `Your score is ${userRating.score}/10.` : 'Add your score below.'}` : 'No BloxDB ratings yet'}</p>
            </div>
            <div data-distribution-area>${distributionMarkup(game.id)}</div>
          </div>

          <div class="rate-form-card">
            <h3>${userRating ? 'Update your rating' : 'Rate this game'}</h3>
            <form data-rating-form>
              <label class="field">
                <span>Name</span>
                <input type="text" name="user" maxlength="32" value="${escapeHtml(getCurrentUserName())}" placeholder="Guest Player">
              </label>

              <label class="field">
                <span>Score</span>
                <select name="score" required>
                  <option value="">Choose 1–10</option>
                  ${Array.from({ length: 10 }, (_, index) => index + 1).map((score) => `<option value="${score}" ${userRating?.score === score ? 'selected' : ''}>${score} / 10</option>`).join('')}
                </select>
              </label>

              <label class="field wide-field">
                <span>Review <small>optional</small></span>
                <textarea name="review" rows="5" maxlength="800" placeholder="Optional: write a short review.">${escapeHtml(userRating?.review || '')}</textarea>
              </label>

              <button class="btn primary" type="submit">Save rating</button>
              <p class="form-note">Empty reviews are allowed. Empty or invalid scores are rejected.</p>
            </form>
          </div>

          <div class="reviews-section">
            <div class="section-heading small-heading">
              <span class="eyebrow">Reviews</span>
              <h2>Real user reviews</h2>
              <p data-review-count>${reviews.length ? plural(reviews.length, 'written review') : 'No written reviews yet'}</p>
            </div>
            <div data-reviews-area>${reviewsMarkup(game.id)}</div>
          </div>
        </section>

        <section class="panel">
          <div class="section-heading small-heading with-action">
            <div>
              <span class="eyebrow">More like this</span>
              <h2>Similar Roblox games</h2>
            </div>
            <a class="btn ghost" href="${routeHref(`/search?genre=${encodeURIComponent(game.genre)}`)}">Browse genre</a>
          </div>
          <div class="grid cards-grid similar-grid">
            ${similar.map((item) => gameCard(item)).join('')}
          </div>
        </section>
      </main>
    </section>
  `;

  app.querySelector('[data-rating-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const submitButton = form.querySelector('button[type="submit"]');
      submitButton?.setAttribute('disabled', 'disabled');
      submitRating(game.id, data)
        .then((rating) => {
          updateRatingAreas(game.id);
          showToast('Rating saved on the BloxDB server. Everyone can see the updated community score.');
        })
        .catch((error) => {
          showToast(error.message, 'error');
        })
        .finally(() => {
          submitButton?.removeAttribute('disabled');
        });
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  bindImageStates();
}

function updateRatingAreas(gameId) {
  const average = getAverageRating(gameId);
  const count = getRatingCount(gameId);
  const reviews = getReviews(gameId);
  const userRating = getUserRating(gameId);
  const scoreEl = app.querySelector('[data-average-score]');
  const captionEl = app.querySelector('[data-rating-caption]');
  const distributionArea = app.querySelector('[data-distribution-area]');
  const reviewsArea = app.querySelector('[data-reviews-area]');
  const reviewCount = app.querySelector('[data-review-count]');

  if (scoreEl) scoreEl.textContent = average !== null ? average.toFixed(1) : '—';
  if (captionEl) captionEl.textContent = count ? `${plural(count, 'user rating')}. ${userRating ? `Your score is ${userRating.score}/10.` : ''}` : 'No BloxDB ratings yet';
  if (distributionArea) distributionArea.innerHTML = distributionMarkup(gameId);
  if (reviewsArea) reviewsArea.innerHTML = reviewsMarkup(gameId);
  if (reviewCount) reviewCount.textContent = reviews.length ? plural(reviews.length, 'written review') : 'No written reviews yet';
}

function renderNotFound() {
  renderShell(routeTitle['/404']);
  setActiveNav('/404');
  app.innerHTML = `
    <section class="container empty-state page not-found">
      <div class="empty-icon">404</div>
      <h1>Game not found</h1>
      <p>The BloxDB page you opened does not exist, or this game has not been added to the prototype database yet.</p>
      <div class="action-row center">
        <a class="btn primary" href="${routeHref('/search')}">Search games</a>
        <a class="btn ghost" href="${routeHref('/')}">Back home</a>
      </div>
    </section>
  `;
}

async function renderTopRatedShortcut() {
  const topRatedIds = await getTopRatedGameIdsAsync(20, MIN_RATINGS_FOR_TOP);
  const sorted = (await Promise.all(topRatedIds.map((id) => getGameById(id)))).filter(Boolean);
  await preloadRatingSummaries(sorted.map((game) => game.id));
  renderShell('Top Rated Roblox Games — BloxDB');
  setActiveNav('/top-rated');
  app.innerHTML = `
    <section class="container page search-page">
      <div class="page-header reveal">
        <span class="eyebrow">BloxDB Community</span>
        <h1>Top Rated Roblox Games</h1>
        <p>Only games with at least ${MIN_RATINGS_FOR_TOP} real BloxDB user rating are eligible. Ratings and reviews come from the configured community server, not private localStorage.</p>
      </div>
      ${sorted.length ? `
        <div class="grid cards-grid results-grid reveal">
          ${sorted.map((game) => gameCard(game)).join('')}
        </div>
      ` : emptyState('No rated games yet', 'Rate a game from 1 to 10 to make it appear in this section.', routeUrl('/search'), 'Find a game to rate')}
    </section>
  `;
  bindImageStates();
}

async function renderResetDemo() {
  clearLocalRatings();
  showToast('Local BloxDB rating cache was cleared. Server ratings stay online.');
  navigate('/');
}

async function router() {
  const { path } = getRouteParts();
  try {
    if (siteNav?.classList.contains('open')) siteNav.classList.remove('open');
    mobileToggle?.setAttribute('aria-expanded', 'false');
    if (path === '/' || path === '') return await renderHome();
    if (path === '/search') return await renderSearch();
    if (path === '/most-played') {
      return await renderSearch({
        routePath: '/most-played',
        lockSort: 'players',
        heading: 'Most Played Roblox Games',
        eyebrow: 'Leaderboard',
        description: 'Browse games sorted by active player count. Filters still work, but the route keeps the Most Played ranking.',
      });
    }
    if (path === '/recently-updated') {
      return await renderSearch({
        routePath: '/recently-updated',
        lockSort: 'newest',
        heading: 'Recently Updated Roblox Games',
        eyebrow: 'Fresh updates',
        description: 'Browse Roblox games sorted by latest update date when Roblox returns that data.',
      });
    }
    if (path === '/top-rated') return await renderTopRatedShortcut();
    if (path === '/reset-demo') return await renderResetDemo();
    if (path.startsWith('/game/')) {
      const gameId = decodeURIComponent(path.split('/game/')[1] || '');
      return await renderGamePage(gameId);
    }
    return renderNotFound();
  } catch (error) {
    console.error(error);
    renderError(error);
  } finally {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function routeFromUrl(url) {
  let pathname = url.pathname || '/';
  if (APP_BASE_PATH && (pathname === APP_BASE_PATH || pathname.startsWith(`${APP_BASE_PATH}/`))) {
    pathname = pathname.slice(APP_BASE_PATH.length) || '/';
  }
  pathname = pathname.replace(/\/+$/, '') || '/';
  return `${pathname}${url.search || ''}`;
}

function handleDocumentClick(event) {
  const link = event.target.closest?.('a[href]');
  if (!link) return;
  if (link.target || link.hasAttribute('download') || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;

  const insideBase = !APP_BASE_PATH || url.pathname === APP_BASE_PATH || url.pathname.startsWith(`${APP_BASE_PATH}/`);
  const route = routeFromUrl(url);
  const routePath = route.split('?')[0];
  const isAppRoute = ['/', '/search', '/most-played', '/top-rated', '/recently-updated', '/reset-demo'].includes(routePath) || routePath.startsWith('/game/');
  if (!insideBase && !isAppRoute) return;
  if (!isAppRoute) return;

  event.preventDefault();
  navigate(route);
}

mobileToggle?.addEventListener('click', () => {
  const isOpen = siteNav?.classList.toggle('open');
  mobileToggle.setAttribute('aria-expanded', String(Boolean(isOpen)));
});

document.addEventListener('click', handleDocumentClick);
window.addEventListener('popstate', router);
window.addEventListener('hashchange', () => {
  migrateLegacyHashRoute();
  router();
});
window.addEventListener('DOMContentLoaded', () => {
  migrateLegacyHashRoute();
  router();
});
