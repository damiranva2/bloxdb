const STORAGE_KEY = 'bloxdb.community.ratings.v3.cache';
const SUMMARY_KEY = 'bloxdb.community.summary.v1.cache';
const USER_KEY = 'bloxdb.user.v1';
const CLIENT_KEY = 'bloxdb.client.id.v1';

export const MIN_RATINGS_FOR_TOP = 1;

const ratingsCache = new Map();
const summaryCache = new Map();
let lastRemoteError = null;
let lastRemoteOk = false;

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readLocalRatingsStore() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed = safeJsonParse(stored, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('BloxDB rating cache could not be parsed and was reset:', error);
    localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

function writeLocalRatingsStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function readLocalSummaryStore() {
  try {
    const stored = localStorage.getItem(SUMMARY_KEY);
    if (!stored) return {};
    const parsed = safeJsonParse(stored, {});
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('BloxDB summary cache could not be parsed and was reset:', error);
    localStorage.removeItem(SUMMARY_KEY);
    return {};
  }
}

function writeLocalSummaryStore(store) {
  localStorage.setItem(SUMMARY_KEY, JSON.stringify(store));
}

function cleanGameId(gameId) {
  return String(gameId || '').trim().slice(0, 96);
}

function cleanReview(value) {
  return String(value || '').trim().slice(0, 800);
}

function cleanUserName(value) {
  return String(value || '').trim().slice(0, 32) || 'Guest Player';
}

function normalizeRating(rating = {}) {
  return {
    id: String(rating.id || rating.rating_id || ''),
    gameId: cleanGameId(rating.gameId || rating.game_id),
    user: cleanUserName(rating.user || rating.userName || rating.user_name),
    score: Number(rating.score || 0),
    review: cleanReview(rating.review),
    date: String(rating.date || rating.updatedAt || rating.updated_at || rating.createdAt || rating.created_at || new Date().toISOString()),
    local: Boolean(rating.local),
  };
}

function normalizeSummary(summary = {}) {
  return {
    gameId: cleanGameId(summary.gameId || summary.game_id),
    average: summary.average === null || summary.average === undefined ? null : Number(Number(summary.average).toFixed(1)),
    count: Number(summary.count || 0),
  };
}

function sortRatings(ratings) {
  return [...ratings].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function cacheRatings(gameId, ratings) {
  const key = cleanGameId(gameId);
  const normalized = sortRatings((ratings || []).map(normalizeRating).filter((rating) => rating.gameId || key));
  const fixed = normalized.map((rating) => ({ ...rating, gameId: rating.gameId || key }));
  ratingsCache.set(key, fixed);

  const store = readLocalRatingsStore();
  store[key] = fixed;
  writeLocalRatingsStore(store);

  const count = fixed.length;
  const average = count ? Number((fixed.reduce((sum, rating) => sum + Number(rating.score || 0), 0) / count).toFixed(1)) : null;
  cacheSummaries([{ gameId: key, average, count }]);
  return fixed;
}

function cacheSummaries(items = []) {
  const store = readLocalSummaryStore();
  for (const item of items) {
    const summary = normalizeSummary(item);
    if (!summary.gameId) continue;
    summaryCache.set(summary.gameId, summary);
    store[summary.gameId] = summary;
  }
  writeLocalSummaryStore(store);
}

function getCommunityApiBase() {
  const explicit = window.BLOXDB_COMMUNITY_API_URL || window.BLOXDB_CLOUDFLARE_WORKER_URL || '';
  return String(explicit || '').trim().replace(/\/+$/, '');
}

function isRemoteConfigured() {
  const base = getCommunityApiBase();
  return Boolean(base && !base.includes('YOUR_WORKER_SUBDOMAIN'));
}

async function remoteJson(path, options = {}) {
  if (!isRemoteConfigured()) throw new Error('BloxDB community server is not configured.');

  const response = await fetch(`${getCommunityApiBase()}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || payload?.message || `BloxDB community server returned ${response.status}`;
    throw new Error(message);
  }

  lastRemoteError = null;
  lastRemoteOk = true;
  return payload;
}

function rememberRemoteError(error) {
  lastRemoteError = error;
  lastRemoteOk = false;
  console.warn('BloxDB community server unavailable, using browser cache:', error);
}

function readCachedRatings(gameId) {
  const key = cleanGameId(gameId);
  if (ratingsCache.has(key)) return ratingsCache.get(key);
  const store = readLocalRatingsStore();
  const ratings = sortRatings((store[key] || []).map(normalizeRating));
  if (ratings.length) ratingsCache.set(key, ratings);
  return ratings;
}

function readCachedSummary(gameId) {
  const key = cleanGameId(gameId);
  if (summaryCache.has(key)) return summaryCache.get(key);
  const store = readLocalSummaryStore();
  const summary = normalizeSummary(store[key] || {});
  if (summary.gameId) {
    summaryCache.set(key, summary);
    return summary;
  }
  const ratings = readCachedRatings(key);
  if (!ratings.length) return { gameId: key, average: null, count: 0 };
  const count = ratings.length;
  const average = Number((ratings.reduce((sum, rating) => sum + Number(rating.score || 0), 0) / count).toFixed(1));
  return { gameId: key, average, count };
}

export function getCurrentUserName() {
  return localStorage.getItem(USER_KEY) || 'Guest Player';
}

export function setCurrentUserName(name) {
  const clean = cleanUserName(name);
  localStorage.setItem(USER_KEY, clean);
  return clean;
}

export function getClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export function getCommunityStorageStatus() {
  return {
    remoteConfigured: isRemoteConfigured(),
    remoteOk: lastRemoteOk,
    lastError: lastRemoteError?.message || '',
    apiBase: getCommunityApiBase(),
  };
}

export async function preloadRatings(gameId, { force = false } = {}) {
  const key = cleanGameId(gameId);
  if (!key) return [];
  if (!force && ratingsCache.has(key)) return ratingsCache.get(key);

  try {
    const payload = await remoteJson(`/api/ratings?gameId=${encodeURIComponent(key)}&clientId=${encodeURIComponent(getClientId())}`);
    return cacheRatings(key, payload.ratings || []);
  } catch (error) {
    rememberRemoteError(error);
    return readCachedRatings(key);
  }
}

export async function preloadRatingSummaries(gameIds = []) {
  const uniqueIds = [...new Set(gameIds.map(cleanGameId).filter(Boolean))].slice(0, 100);
  if (!uniqueIds.length) return [];

  try {
    const payload = await remoteJson(`/api/ratings/summary?gameIds=${encodeURIComponent(uniqueIds.join(','))}`);
    cacheSummaries(payload.items || []);
  } catch (error) {
    rememberRemoteError(error);
  }

  return uniqueIds.map((gameId) => readCachedSummary(gameId));
}

export function getRatings(gameId) {
  return readCachedRatings(gameId);
}

export function getReviews(gameId) {
  return getRatings(gameId).filter((rating) => rating.review && rating.review.trim().length > 0);
}

export function getAverageRating(gameId) {
  const summary = readCachedSummary(gameId);
  return summary.count ? summary.average : null;
}

export function getRatingCount(gameId) {
  return readCachedSummary(gameId).count;
}

export function hasBloxDbRating(gameId) {
  return getRatingCount(gameId) > 0;
}

export function getRatingDistribution(gameId) {
  const distribution = Array.from({ length: 10 }, (_, index) => ({ score: index + 1, count: 0 }));
  for (const rating of getRatings(gameId)) {
    const score = Number(rating.score);
    if (score >= 1 && score <= 10) distribution[score - 1].count += 1;
  }
  return distribution.reverse();
}

export function getUserRating(gameId) {
  const key = cleanGameId(gameId);
  const clientId = getClientId();
  return getRatings(key).find((rating) => rating.id === `${key}:${clientId}` || rating.clientId === clientId || rating.local) || null;
}

export async function submitRating(gameId, payload) {
  const key = cleanGameId(gameId);
  const score = Number(payload?.score);
  const review = cleanReview(payload?.review);
  const user = setCurrentUserName(payload?.user || getCurrentUserName());
  const clientId = getClientId();

  if (!key) throw new Error('Game ID is missing.');

  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new Error('Выбери оценку от 1 до 10.');
  }

  const optimisticRating = normalizeRating({
    id: `${key}:${clientId}`,
    gameId: key,
    user,
    score,
    review,
    date: new Date().toISOString(),
    local: true,
  });

  try {
    const payloadFromServer = await remoteJson('/api/ratings', {
      method: 'POST',
      body: JSON.stringify({ gameId: key, clientId, user, score, review }),
    });
    const rating = normalizeRating(payloadFromServer.rating || optimisticRating);
    rating.local = false;
    const existing = getRatings(key).filter((item) => item.id !== rating.id);
    cacheRatings(key, [rating, ...existing]);
    await preloadRatingSummaries([key]);
    return rating;
  } catch (error) {
    rememberRemoteError(error);
    throw new Error(`Rating was not saved online. Please deploy/fix the Cloudflare Worker with D1 database first. ${error?.message || ''}`.trim());
  }
}

export function clearLocalRatings() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SUMMARY_KEY);
  ratingsCache.clear();
  summaryCache.clear();
  return {};
}

export function resetDemoRatings() {
  return clearLocalRatings();
}

export function getTopRatedGameIds(limit = 6, minRatings = MIN_RATINGS_FOR_TOP) {
  const store = readLocalSummaryStore();
  return Object.keys(store)
    .map((gameId) => readCachedSummary(gameId))
    .filter((item) => item.count >= minRatings && item.average !== null)
    .sort((a, b) => (b.average - a.average) || (b.count - a.count))
    .slice(0, limit)
    .map((item) => item.gameId);
}

export async function getTopRatedGameIdsAsync(limit = 6, minRatings = MIN_RATINGS_FOR_TOP) {
  try {
    const payload = await remoteJson(`/api/ratings/top?limit=${encodeURIComponent(limit)}&minRatings=${encodeURIComponent(minRatings)}`);
    cacheSummaries(payload.items || []);
    return (payload.items || []).map((item) => cleanGameId(item.gameId || item.game_id)).filter(Boolean);
  } catch (error) {
    rememberRemoteError(error);
    return getTopRatedGameIds(limit, minRatings);
  }
}
