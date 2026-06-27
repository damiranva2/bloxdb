// BloxDB Roblox API layer
//
// IMPORTANT: every Roblox request from the frontend goes through Cloudflare Worker.
// GitHub Pages / static browsers must not call Roblox JSON APIs directly because
// Roblox domains such as games.roblox.com and thumbnails.roblox.com do not always
// return CORS headers.
//
// Configure in index.html:
//   window.BLOXDB_CLOUDFLARE_WORKER_URL = 'https://your-worker.workers.dev';
//
// The Worker must accept:
//   ?url=<encoded Roblox API URL>

const browserWindow = typeof window !== 'undefined' ? window : undefined;

function normalizeWorkerUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/YOUR_|your-worker|your-subdomain|example\.com|replace-me/i.test(raw)) return '';

  try {
    const url = new URL(raw);
    const isLocalWrangler = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['8787', '8788'].includes(url.port);
    const isDeployedWorker = url.protocol === 'https:';
    if (!isLocalWrangler && !isDeployedWorker) return '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export const CLOUDFLARE_WORKER_URL = normalizeWorkerUrl(
  browserWindow?.BLOXDB_CLOUDFLARE_WORKER_URL || ''
);

export const API_PROXY_URL = CLOUDFLARE_WORKER_URL;

const REQUEST_TIMEOUT_MS = 8500;
// Roblox search/list/detail data is refreshed at least every 24 hours.
// This lets GitHub Pages show a stable searchable catalog while still picking up new/updated games daily.
const ROBLOX_DATA_REFRESH_MS = 1000 * 60 * 60 * 24;
const CACHE_TTL_MS = ROBLOX_DATA_REFRESH_MS;
const THUMBNAIL_CACHE_TTL_MS = ROBLOX_DATA_REFRESH_MS;
const MAX_BATCH_IDS = 50;
const API_COOLDOWN_MS = 1000 * 20;
const SESSION_KEY = 'bloxdb.roblox.sessionId';

const memoryCache = new Map();
const universeCache = new Map();
const exploreSortCache = new Map();
let apiBlockedUntil = 0;
let apiBlockedError = null;

export class RobloxApiUnavailableError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'RobloxApiUnavailableError';
    this.cause = cause;
  }
}

export function hasRobloxProxy() {
  return Boolean(CLOUDFLARE_WORKER_URL);
}

export function canUseRobloxApi() {
  return hasRobloxProxy();
}

export function getRobloxApiMode() {
  if (!hasRobloxProxy()) return 'cloudflare-worker-not-configured';
  try {
    const url = new URL(CLOUDFLARE_WORKER_URL);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'cloudflare-worker-local';
    return 'cloudflare-worker';
  } catch {
    return 'cloudflare-worker';
  }
}

export function withProxy(url) {
  if (!CLOUDFLARE_WORKER_URL) return '';
  if (CLOUDFLARE_WORKER_URL.includes('{url}')) return CLOUDFLARE_WORKER_URL.replace('{url}', encodeURIComponent(url));
  if (/[?&]url=$/.test(CLOUDFLARE_WORKER_URL) || CLOUDFLARE_WORKER_URL.endsWith('=')) return `${CLOUDFLARE_WORKER_URL}${encodeURIComponent(url)}`;
  const joiner = CLOUDFLARE_WORKER_URL.includes('?') ? '&' : '?';
  return `${CLOUDFLARE_WORKER_URL}${joiner}url=${encodeURIComponent(url)}`;
}

function cacheKey(url) {
  return `bloxdb.api.cache.${url}`;
}

function getBrowserCacheStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // fall through
  }
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch {
    // fall through
  }
  return null;
}

function readSessionCache(url) {
  try {
    const storage = getBrowserCacheStorage();
    if (!storage) return null;
    const raw = storage.getItem(cacheKey(url));
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || Date.now() - payload.time > payload.ttl) {
      storage.removeItem(cacheKey(url));
      return null;
    }
    return payload.value;
  } catch {
    return null;
  }
}

function writeSessionCache(url, value, ttl) {
  try {
    const storage = getBrowserCacheStorage();
    if (!storage) return;
    storage.setItem(cacheKey(url), JSON.stringify({ value, ttl, time: Date.now() }));
  } catch {
    // Memory cache still works.
  }
}

function hasOnlyRobloxErrors(data) {
  return Array.isArray(data?.errors)
    && data.errors.length > 0
    && !data.data
    && !data.searchResults
    && !data.sorts
    && !data.contents
    && !data.games;
}

function firstRobloxErrorMessage(data) {
  return data?.errors?.map((item) => item?.message).filter(Boolean).join('; ') || 'Roblox API returned an error payload.';
}

export async function requestJson(url, { ttl = CACHE_TTL_MS, useCache = true } = {}) {
  if (useCache) {
    const memory = memoryCache.get(url);
    if (memory && Date.now() - memory.time <= memory.ttl) return memory.value;
    const session = readSessionCache(url);
    if (session) {
      memoryCache.set(url, { value: session, ttl, time: Date.now() });
      return session;
    }
  }

  if (!canUseRobloxApi()) {
    throw new RobloxApiUnavailableError(
      'Roblox API requires Cloudflare Worker. Set window.BLOXDB_CLOUDFLARE_WORKER_URL in index.html.'
    );
  }

  if (Date.now() < apiBlockedUntil) throw apiBlockedError;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(withProxy(url), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Roblox API returned HTTP ${response.status}`);
    const data = await response.json();
    if (hasOnlyRobloxErrors(data)) throw new Error(firstRobloxErrorMessage(data));

    apiBlockedUntil = 0;
    apiBlockedError = null;
    if (useCache) {
      memoryCache.set(url, { value: data, ttl, time: Date.now() });
      writeSessionCache(url, data, ttl);
    }
    return data;
  } catch (error) {
    const wrapped = error instanceof RobloxApiUnavailableError
      ? error
      : new RobloxApiUnavailableError(
        hasRobloxProxy()
          ? 'Cloudflare Worker proxy is unavailable, rate-limited, or Roblox rejected the endpoint.'
          : 'Roblox API is disabled until window.BLOXDB_CLOUDFLARE_WORKER_URL is configured.',
        error
      );
    apiBlockedUntil = Date.now() + API_COOLDOWN_MS;
    apiBlockedError = wrapped;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  return search.toString();
}

function chunk(list, size = MAX_BATCH_IDS) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

function asId(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function getSessionId() {
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(SESSION_KEY, created);
      return created;
    }
  } catch {
    // fall through
  }
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function getUniverseIdFromPlaceId(placeId) {
  const id = asId(placeId);
  if (!id) return null;
  if (universeCache.has(id)) return universeCache.get(id);

  const url = `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(id)}/universe`;
  const data = await requestJson(url, { ttl: CACHE_TTL_MS });
  const universeId = asId(data?.universeId);
  if (!universeId) throw new Error(`Universe ID was not found for placeId ${id}.`);
  universeCache.set(id, universeId);
  return universeId;
}

export async function getGameThumbnailByUniverseId(universeId) {
  const id = asId(universeId);
  if (!id) return null;

  const url = `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?${qs({
    universeIds: id,
    countPerUniverse: 1,
    defaults: true,
    size: '768x432',
    format: 'Png',
    isCircular: false,
  })}`;

  const data = await requestJson(url, { ttl: THUMBNAIL_CACHE_TTL_MS });
  return data?.data?.[0]?.thumbnails?.[0]?.imageUrl || data?.data?.[0]?.imageUrl || null;
}

export async function getGameIconByUniverseId(universeId) {
  const id = asId(universeId);
  if (!id) return null;

  const url = `https://thumbnails.roblox.com/v1/games/icons?${qs({
    universeIds: id,
    returnPolicy: 'PlaceHolder',
    size: '512x512',
    format: 'Png',
    isCircular: false,
  })}`;

  const data = await requestJson(url, { ttl: THUMBNAIL_CACHE_TTL_MS });
  return data?.data?.[0]?.imageUrl || null;
}

export async function getGameThumbnailByPlaceId(placeId) {
  const universeId = await getUniverseIdFromPlaceId(placeId);
  return getGameThumbnailByUniverseId(universeId);
}

export async function getGameIconByPlaceId(placeId) {
  const universeId = await getUniverseIdFromPlaceId(placeId);
  return getGameIconByUniverseId(universeId);
}

function thumbnailFromPayloadItem(item) {
  return item?.thumbnails?.[0]?.imageUrl || item?.imageUrl || null;
}

async function getGameThumbnailsByUniverseIds(universeIds = []) {
  const ids = [...new Set(universeIds.map(asId).filter(Boolean))];
  const map = new Map();
  for (const batch of chunk(ids)) {
    const url = `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?${qs({
      universeIds: batch.join(','),
      countPerUniverse: 1,
      defaults: true,
      size: '768x432',
      format: 'Png',
      isCircular: false,
    })}`;
    const data = await requestJson(url, { ttl: THUMBNAIL_CACHE_TTL_MS });
    for (const item of data?.data || []) {
      const key = asId(item?.universeId ?? item?.targetId);
      const imageUrl = thumbnailFromPayloadItem(item);
      if (key && imageUrl) map.set(key, imageUrl);
    }
  }
  return map;
}

async function getGameIconsByUniverseIds(universeIds = []) {
  const ids = [...new Set(universeIds.map(asId).filter(Boolean))];
  const map = new Map();
  for (const batch of chunk(ids)) {
    const url = `https://thumbnails.roblox.com/v1/games/icons?${qs({
      universeIds: batch.join(','),
      returnPolicy: 'PlaceHolder',
      size: '512x512',
      format: 'Png',
      isCircular: false,
    })}`;
    const data = await requestJson(url, { ttl: THUMBNAIL_CACHE_TTL_MS });
    for (const item of data?.data || []) {
      const key = asId(item?.targetId ?? item?.universeId);
      if (key && item?.imageUrl) map.set(key, item.imageUrl);
    }
  }
  return map;
}

export async function getMediaForGames(games = []) {
  const withUniverseIds = [];

  for (const game of games) {
    let universeId = asId(game.universeId);
    if (!universeId && game.placeId && canUseRobloxApi()) {
      try {
        universeId = await getUniverseIdFromPlaceId(game.placeId);
      } catch {
        // Keep row; UI shows placeholder.
      }
    }
    withUniverseIds.push({ ...game, universeId });
  }

  if (!canUseRobloxApi()) {
    return withUniverseIds.map((game) => ({
      ...game,
      cover: null,
      icon: null,
      mediaSource: 'Placeholder: configure Cloudflare Worker to load live Roblox thumbnails',
    }));
  }

  const universeIds = withUniverseIds.map((game) => game.universeId).filter(Boolean);
  let covers = new Map();
  let icons = new Map();

  try {
    [covers, icons] = await Promise.all([
      getGameThumbnailsByUniverseIds(universeIds),
      getGameIconsByUniverseIds(universeIds),
    ]);
  } catch {
    // Do not spam console for every card. api.js shows a single fallback notice.
  }

  return withUniverseIds.map((game) => ({
    ...game,
    cover: game.universeId ? covers.get(String(game.universeId)) || null : null,
    icon: game.universeId ? icons.get(String(game.universeId)) || null : null,
    mediaSource: game.universeId && (covers.has(String(game.universeId)) || icons.has(String(game.universeId)))
      ? ''
      : 'Placeholder: Roblox thumbnail unavailable',
  }));
}

export async function getGameDetailsByUniverseIds(universeIds = []) {
  const ids = [...new Set(universeIds.map(asId).filter(Boolean))];
  const output = [];
  for (const batch of chunk(ids, 50)) {
    const url = `https://games.roblox.com/v1/games?${qs({ universeIds: batch.join(',') })}`;
    const data = await requestJson(url, { ttl: CACHE_TTL_MS });
    output.push(...(data?.data || []));
  }
  return output;
}

export async function getGameVotesByUniverseIds(universeIds = []) {
  const ids = [...new Set(universeIds.map(asId).filter(Boolean))];
  const output = [];
  for (const batch of chunk(ids, 50)) {
    const url = `https://games.roblox.com/v1/games/votes?${qs({ universeIds: batch.join(',') })}`;
    const data = await requestJson(url, { ttl: CACHE_TTL_MS });
    output.push(...(data?.data || []));
  }
  return output;
}

function normalizeRobloxGame(raw = {}) {
  const content = raw.content || raw.item || raw.game || raw.experience || raw;
  const universeId = asId(content.universeId ?? content.universeID ?? content.universe?.id ?? content.gameId ?? content.id);
  const placeId = asId(content.rootPlaceId ?? content.placeId ?? content.placeID ?? content.PlaceID ?? content.rootPlace?.id ?? content.universeRootPlaceId);
  const title = content.name || content.Name || content.title || content.displayName || content.experienceName || 'Untitled Roblox Game';
  const upvotes = Number(content.upVotes ?? content.totalUpVotes ?? content.TotalUpVotes ?? content.voteCount ?? 0);
  const downvotes = Number(content.downVotes ?? content.totalDownVotes ?? content.TotalDownVotes ?? 0);
  const creator = content.creator || content.creatorTarget || content.creatorInfo || {};

  return {
    id: placeId || universeId,
    placeId,
    universeId,
    title,
    slug: String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(placeId || universeId),
    tagline: content.description ? String(content.description).split('\n').find(Boolean)?.slice(0, 130) : 'Roblox experience',
    description: content.description || content.Description || 'No description available from Roblox API.',
    creator: {
      name: creator.name || content.creatorName || content.CreatorName || content.creator?.name || 'Unknown',
      type: creator.type || content.creatorType || content.CreatorType || content.creator?.type || '',
      id: creator.id || content.creatorId || content.CreatorID || content.creator?.id || null,
    },
    genre: content.genre || content.Genre || 'Roblox',
    tags: content.genre ? [content.genre] : [],
    players: Number(content.playing ?? content.playerCount ?? content.PlayerCount ?? content.ccu ?? 0),
    visits: Number(content.visits ?? content.placeVisits ?? content.Plays ?? content.totalVisits ?? 0),
    upvotes,
    downvotes,
    favorites: Number(content.favoritedCount ?? content.favorites ?? content.Favorites ?? 0),
    updatedAt: content.updated ? String(content.updated).slice(0, 10) : content.updatedAt || content.lastUpdated || '',
    createdAt: content.created ? String(content.created).slice(0, 10) : content.createdAt || '',
    cover: null,
    icon: null,
    playUrl: placeId ? `https://www.roblox.com/games/${encodeURIComponent(placeId)}` : 'https://www.roblox.com/discover',
    popularity: Number(content.playing ?? content.playerCount ?? content.PlayerCount ?? content.ccu ?? 0),
    source: 'Roblox API',
  };
}

function looksLikeGameObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasGameId = value.rootPlaceId || value.placeId || value.universeId || value.universe?.id || value.gameId;
  const hasName = value.name || value.title || value.displayName || value.experienceName;
  const type = String(value.contentType || value.itemType || value.type || value.verticalType || '').toLowerCase();
  return Boolean(hasGameId && hasName && (!type || /game|experience|universe|place|content/.test(type)));
}

function collectGameObjects(payload, output = [], seen = new WeakSet()) {
  if (!payload || typeof payload !== 'object') return output;
  if (seen.has(payload)) return output;
  seen.add(payload);

  if (Array.isArray(payload)) {
    payload.forEach((item) => collectGameObjects(item, output, seen));
    return output;
  }

  if (looksLikeGameObject(payload)) output.push(payload);

  // Search API commonly returns { searchResults: [{ contents: [game, ...] }] }
  // Explore API commonly returns nested content arrays. Traverse conservatively.
  for (const key of ['searchResults', 'contents', 'content', 'items', 'games', 'data', 'results', 'gameList', 'sorts']) {
    if (payload[key]) collectGameObjects(payload[key], output, seen);
  }
  return output;
}

function dedupeRawGames(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const game = normalizeRobloxGame(row);
    const key = game.universeId || game.placeId || game.title;
    if (!key) continue;
    const existing = map.get(String(key));
    if (!existing) {
      map.set(String(key), row);
      continue;
    }
    const existingScore = Object.keys(existing || {}).length;
    const nextScore = Object.keys(row || {}).length;
    if (nextScore > existingScore) map.set(String(key), row);
  }
  return [...map.values()];
}

async function enrichGames(rawGames = []) {
  let games = dedupeRawGames(rawGames).map(normalizeRobloxGame).filter((game) => game.placeId || game.universeId);

  for (const game of games) {
    if (!game.universeId && game.placeId) {
      try {
        game.universeId = await getUniverseIdFromPlaceId(game.placeId);
      } catch {
        // Keep row; it can still be listed with placeholder media.
      }
    }
  }

  const universeIds = games.map((game) => game.universeId).filter(Boolean);

  try {
    const [details, votes] = await Promise.all([
      getGameDetailsByUniverseIds(universeIds),
      getGameVotesByUniverseIds(universeIds),
    ]);

    const detailsById = new Map(details.map((item) => [String(item.id), normalizeRobloxGame(item)]));
    const votesById = new Map(votes.map((item) => [String(item.id), item]));

    games = games.map((game) => {
      const detail = game.universeId ? detailsById.get(String(game.universeId)) : null;
      const vote = game.universeId ? votesById.get(String(game.universeId)) : null;
      return {
        ...game,
        ...detail,
        id: detail?.placeId || game.placeId || game.id,
        placeId: detail?.placeId || game.placeId,
        universeId: detail?.universeId || game.universeId,
        title: detail?.title || game.title,
        players: Number(detail?.players ?? game.players ?? 0),
        visits: Number(detail?.visits ?? game.visits ?? 0),
        favorites: Number(detail?.favorites ?? game.favorites ?? 0),
        updatedAt: detail?.updatedAt || game.updatedAt,
        upvotes: Number(vote?.upVotes ?? detail?.upvotes ?? game.upvotes ?? 0),
        downvotes: Number(vote?.downVotes ?? detail?.downvotes ?? game.downvotes ?? 0),
        source: 'Roblox API',
      };
    });
  } catch {
    // Details/votes are optional enrichment. Show search/discover-level rows if available.
  }

  return getMediaForGames(games);
}

function extractNextCursor(payload = {}) {
  return payload.nextPageToken || payload.nextPageCursor || payload.nextCursor || payload.pageToken || null;
}

function sortLabelMatches(sort, label) {
  const clean = String(label || '').toLowerCase();
  if (!clean) return false;
  if (sort === 'players' || sort === 'popular' || sort === 'visits') return /top|popular|playing|now|engag|featured|recommended/.test(clean);
  if (sort === 'newest') return /new|up.?and.?coming|recent|updated/.test(clean);
  if (sort === 'robloxRating' || sort === 'likes') return /top.?rated|rated|like|vote/.test(clean);
  if (sort === 'favorites') return /favorite/.test(clean);
  return false;
}

function getFallbackSortIds(sort = 'popular') {
  const fallbacks = {
    popular: ['top-playing-now', 'popular', 'recommended', 'featured'],
    players: ['top-playing-now', 'popular'],
    visits: ['top-playing-now', 'popular'],
    newest: ['up-and-coming', 'top-playing-now'],
    robloxRating: ['top-rated', 'top-playing-now'],
    likes: ['top-rated', 'top-playing-now'],
    favorites: ['top-playing-now'],
  };
  return fallbacks[sort] || fallbacks.popular;
}

export async function getExploreSorts() {
  if (exploreSortCache.size) return exploreSortCache;
  const url = `https://apis.roblox.com/explore-api/v1/get-sorts?${qs({
    sessionId: getSessionId(),
    device: 'computer',
    country: 'all',
  })}`;
  const data = await requestJson(url, { ttl: CACHE_TTL_MS });
  const candidates = collectSortObjects(data);

  for (const sort of candidates) {
    const id = sort.sortId || sort.id || sort.token || sort.sortToken;
    const label = sort.displayName || sort.name || sort.topic || sort.title || id;
    if (!id) continue;
    for (const key of ['popular', 'players', 'visits', 'newest', 'robloxRating', 'likes', 'favorites']) {
      if (!exploreSortCache.has(key) && sortLabelMatches(key, label)) exploreSortCache.set(key, String(id));
    }
  }

  for (const [key, ids] of Object.entries({
    popular: getFallbackSortIds('popular'),
    players: getFallbackSortIds('players'),
    visits: getFallbackSortIds('visits'),
    newest: getFallbackSortIds('newest'),
    robloxRating: getFallbackSortIds('robloxRating'),
    likes: getFallbackSortIds('likes'),
    favorites: getFallbackSortIds('favorites'),
  })) {
    if (!exploreSortCache.has(key)) exploreSortCache.set(key, ids[0]);
  }

  return exploreSortCache;
}

function collectSortObjects(payload, output = [], seen = new WeakSet()) {
  if (!payload || typeof payload !== 'object') return output;
  if (seen.has(payload)) return output;
  seen.add(payload);
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectSortObjects(item, output, seen));
    return output;
  }
  if ((payload.sortId || payload.id || payload.token || payload.sortToken) && (payload.displayName || payload.name || payload.topic || payload.title)) {
    output.push(payload);
  }
  for (const key of ['sorts', 'data', 'content', 'contents', 'items', 'results']) {
    if (payload[key]) collectSortObjects(payload[key], output, seen);
  }
  return output;
}

async function getExploreContent({ sort = 'popular', limit = 24, cursor = '0' } = {}) {
  const sorts = await getExploreSorts();
  const primarySortId = sorts.get(sort) || sorts.get('popular');
  const candidates = [...new Set([primarySortId, ...getFallbackSortIds(sort)].filter(Boolean))];
  let lastError = null;

  for (const sortId of candidates) {
    try {
      const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?${qs({
        sessionId: getSessionId(),
        sortId,
        device: 'computer',
        country: 'all',
      })}`;
      const payload = await requestJson(url, { ttl: CACHE_TTL_MS });
      const rows = dedupeRawGames(collectGameObjects(payload));
      if (!rows.length) continue;

      const start = Math.max(0, Number(cursor || 0) || 0);
      const end = start + Number(limit || 24);
      const pageRows = rows.slice(start, end);
      const games = await enrichGames(pageRows);
      return {
        games,
        nextCursor: end < rows.length ? String(end) : null,
        source: `Roblox Explore API (${sortId})`,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new RobloxApiUnavailableError('Roblox Explore API returned no games.');
}

async function searchOmni({ query = '', limit = 24, cursor = '' } = {}) {
  const url = `https://apis.roblox.com/search-api/omni-search?${qs({
    searchQuery: query,
    pageToken: cursor || '',
    sessionId: getSessionId(),
    pageType: 'all',
  })}`;
  const payload = await requestJson(url, { ttl: CACHE_TTL_MS });
  const rows = dedupeRawGames(collectGameObjects(payload));
  const games = await enrichGames(rows.slice(0, Number(limit || 24)));
  return {
    games,
    nextCursor: extractNextCursor(payload),
    source: 'Roblox Search API',
    error: null,
  };
}

export async function searchRobloxGames({ query = '', sort = 'popular', limit = 24, cursor = '0' } = {}) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery) return searchOmni({ query: cleanQuery, limit, cursor });
  return getExploreContent({ sort, limit, cursor });
}

export async function getPopularRobloxGames({ limit = 24, cursor = '0', sort = 'popular' } = {}) {
  return searchRobloxGames({ query: '', sort, limit, cursor });
}

export async function getRobloxGameByPlaceOrUniverseId(id) {
  const clean = asId(id);
  if (!clean) return null;

  let universeId = null;
  let placeId = null;

  try {
    universeId = await getUniverseIdFromPlaceId(clean);
    placeId = clean;
  } catch {
    universeId = clean;
  }

  const details = await getGameDetailsByUniverseIds([universeId]);
  if (!details.length && !placeId) return null;

  const votes = await getGameVotesByUniverseIds([universeId]).catch(() => []);
  let game = normalizeRobloxGame(details[0] || { universeId, rootPlaceId: placeId });
  const vote = votes?.[0];

  game = {
    ...game,
    id: game.placeId || placeId || clean,
    placeId: game.placeId || placeId,
    universeId: game.universeId || universeId,
    upvotes: Number(vote?.upVotes ?? game.upvotes ?? 0),
    downvotes: Number(vote?.downVotes ?? game.downvotes ?? 0),
    source: 'Roblox API',
  };

  return (await getMediaForGames([game]))[0];
}

export async function getRecommendationsByUniverseId(universeId, limit = 6) {
  const id = asId(universeId);
  if (!id) return { games: [], nextCursor: null, source: 'Roblox API', error: null };
  const url = `https://games.roblox.com/v1/games/recommendations/game/${encodeURIComponent(id)}?${qs({ maxRows: limit })}`;
  const payload = await requestJson(url, { ttl: CACHE_TTL_MS });
  const rows = dedupeRawGames(collectGameObjects(payload));
  return {
    games: await enrichGames(rows.slice(0, limit)),
    nextCursor: null,
    source: 'Roblox recommendations API',
    error: null,
  };
}
