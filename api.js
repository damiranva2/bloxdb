import { mockGames } from './data.js';
import {
  API_PROXY_URL,
  getRobloxApiMode,
  canUseRobloxApi,
  getUniverseIdFromPlaceId,
  getGameThumbnailByUniverseId,
  getGameThumbnailByPlaceId,
  getGameIconByUniverseId,
  getGameIconByPlaceId,
  getMediaForGames,
  searchRobloxGames,
  getPopularRobloxGames,
  getRobloxGameByPlaceOrUniverseId,
  getRecommendationsByUniverseId,
} from './robloxApi.js';

const FALLBACK_NOTICE = 'Cloudflare Worker URL is not configured or Roblox API could not be reached through the Worker. Showing emergency fallback data.';

export const PAGE_SIZE = 24;

export function getApiConfig() {
  return {
    apiProxyUrl: API_PROXY_URL,
    apiMode: getRobloxApiMode(),
    canUseRobloxApi: canUseRobloxApi(),
    primaryMode: 'Roblox API through Cloudflare Worker only, fallback data only when Worker/API fails',
    fallbackNotice: FALLBACK_NOTICE,
  };
}

export function setApiConfig() {
  console.warn('Runtime API config is handled in robloxApi.js through window.BLOXDB_CLOUDFLARE_WORKER_URL.');
}

export { getUniverseIdFromPlaceId, getGameThumbnailByUniverseId, getGameThumbnailByPlaceId, getGameIconByUniverseId, getGameIconByPlaceId };

export function compactNumber(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
}

export function fullNumber(value) {
  return new Intl.NumberFormat('en').format(Number(value || 0));
}

export function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(String(dateString));
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function getRobloxLikeRatio(game) {
  const total = Number(game?.upvotes || 0) + Number(game?.downvotes || 0);
  if (!total) return 0;
  return (Number(game.upvotes || 0) / total) * 100;
}

export function getRobloxGameUrl(placeId) {
  return placeId ? `https://www.roblox.com/games/${encodeURIComponent(placeId)}` : 'https://www.roblox.com/discover';
}

function normalize(text = '') {
  return String(text).toLowerCase().trim();
}

const TAG_KEYWORD_ALIASES = {
  horror: ['horror', 'scary', 'survival', 'monster', 'haunted', 'nightmare', 'piggy', 'doors'],
  simulator: ['simulator', 'simulate', 'tycoon', 'collect', 'grind', 'pets', 'clicker'],
  anime: ['anime', 'blox fruits', 'ninja', 'dragon', 'hero', 'rpg'],
  rpg: ['rpg', 'level', 'quest', 'boss', 'adventure'],
  pvp: ['pvp', 'combat', 'battle', 'fight', 'shooter', 'competitive'],
  roleplay: ['roleplay', 'rp', 'social', 'city', 'house', 'life'],
  obby: ['obby', 'parkour', 'tower', 'platformer'],
  pets: ['pet', 'pets', 'hatch', 'trade', 'collect'],
  trading: ['trade', 'trading', 'market'],
  survival: ['survival', 'survive', 'survivor'],
};

function getSearchableText(game = {}) {
  return normalize([
    game.title,
    String(game.tagline || '').replace(/\bRoblox\b|\bBloxDB\b/gi, ''),
    String(game.description || '').replace(/\bRoblox\b|\bBloxDB\b/gi, ''),
    game.creator?.name,
    game.genre,
    ...(game.tags || []),
  ].join(' '));
}

function tagMatchesGame(game, tag) {
  if (!tag || tag === 'all') return true;
  const cleanTag = normalize(tag);
  const exactTags = (game.tags || []).map(normalize);
  if (exactTags.includes(cleanTag)) return true;

  const haystack = getSearchableText(game);
  const isCuratedFallback = String(game.source || '').toLowerCase().includes('fallback');
  if (isCuratedFallback) return normalize(game.genre) === cleanTag;

  if (haystack.includes(cleanTag)) return true;

  const aliases = TAG_KEYWORD_ALIASES[cleanTag] || [];
  return aliases.some((keyword) => haystack.includes(keyword));
}

function getApiSearchQuery(filters = {}) {
  const query = String(filters.query || '').trim();
  if (query) return query;

  const tag = String(filters.tag || 'all').trim();
  if (tag && tag !== 'all') return tag;

  const genre = String(filters.genre || 'all').trim();
  if (genre && genre !== 'all') return genre;

  return '';
}

function inUpdatedWindow(game, windowValue) {
  if (!windowValue || windowValue === 'any') return true;
  const days = Number(windowValue);
  const updated = new Date(game.updatedAt || 0).getTime();
  if (!updated) return true;
  return Date.now() - updated <= days * 86_400_000;
}

function getSortName(sort = 'popular') {
  const map = {
    bloxdbRating: 'popular',
    rating: 'popular',
    robloxRating: 'robloxRating',
    likes: 'robloxRating',
    favorites: 'popular',
    newest: 'newest',
    visits: 'popular',
    players: 'players',
    popular: 'popular',
  };
  return map[sort] || 'popular';
}

function sortGames(games, sort = 'popular') {
  const copy = [...games];
  const sorters = {
    popular: (a, b) => ((b.players || 0) * 2 + (b.visits || 0) / 1_000_000) - ((a.players || 0) * 2 + (a.visits || 0) / 1_000_000),
    newest: (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
    visits: (a, b) => (b.visits || 0) - (a.visits || 0),
    robloxRating: (a, b) => getRobloxLikeRatio(b) - getRobloxLikeRatio(a),
    rating: (a, b) => getRobloxLikeRatio(b) - getRobloxLikeRatio(a),
    likes: (a, b) => (b.upvotes || 0) - (a.upvotes || 0),
    players: (a, b) => (b.players || 0) - (a.players || 0),
    favorites: (a, b) => (b.favorites || 0) - (a.favorites || 0),
  };
  return copy.sort(sorters[sort] || sorters.popular);
}

function applyFilters(games, filters = {}) {
  const q = normalize(filters.query);
  const minRobloxRating = Number(filters.minRobloxRating ?? filters.minRating ?? 0);
  const minPlayers = Number(filters.minPlayers || 0);
  const minVisits = Number(filters.minVisits || 0);
  const genre = normalize(filters.genre || 'all');
  const tag = normalize(filters.tag || 'all');

  return games.filter((game) => {
    const haystack = getSearchableText(game);

    const queryOk = !q || haystack.includes(q);
    const robloxRatingOk = getRobloxLikeRatio(game) >= minRobloxRating;
    const playersOk = Number(game.players || 0) >= minPlayers;
    const visitsOk = Number(game.visits || 0) >= minVisits;
    const genreOk = genre === 'all' || normalize(game.genre) === genre || haystack.includes(genre);
    const tagOk = tagMatchesGame(game, tag);
    const updatedOk = inUpdatedWindow(game, filters.updatedWithin);

    return queryOk && robloxRatingOk && playersOk && visitsOk && genreOk && tagOk && updatedOk;
  });
}

function cleanGame(game, source = game?.source || 'Roblox API') {
  const placeId = game.placeId ? String(game.placeId) : game.id ? String(game.id) : null;
  return {
    ...game,
    id: placeId || String(game.universeId || game.title),
    placeId,
    universeId: game.universeId ? String(game.universeId) : null,
    title: game.title || 'Untitled Roblox Game',
    tagline: game.tagline || (game.description ? String(game.description).split('\n').find(Boolean)?.slice(0, 130) : 'Roblox experience'),
    description: game.description || 'No description available.',
    creator: game.creator || { name: 'Unknown', type: '' },
    genre: game.genre || 'Roblox',
    tags: game.tags || [],
    players: Number(game.players || 0),
    visits: Number(game.visits || 0),
    upvotes: Number(game.upvotes || 0),
    downvotes: Number(game.downvotes || 0),
    favorites: Number(game.favorites || 0),
    playUrl: game.playUrl || getRobloxGameUrl(placeId),
    source,
  };
}

async function fallbackGames({ filters = {}, limit = PAGE_SIZE, page = 1, sourceError = null } = {}) {
  const hydrated = await getMediaForGames(mockGames.map((game) => cleanGame(game, 'Fallback demo data')));
  const filtered = applyFilters(hydrated, filters);
  const sorted = sortGames(filtered, filters.sort || 'popular');
  const end = Math.max(1, Number(page || 1)) * limit;
  return {
    games: sorted.slice(0, end).map((game) => ({ ...game, fallback: true })),
    nextCursor: end < sorted.length ? String(end) : null,
    source: 'Fallback demo data',
    fallback: true,
    error: sourceError || new Error(FALLBACK_NOTICE),
  };
}

function cursorStoreKey(filters = {}, page = 1, limit = PAGE_SIZE) {
  const stable = {
    query: filters.query || '',
    sort: getSortName(filters.sort),
    minRobloxRating: filters.minRobloxRating || filters.minRating || '0',
    minPlayers: filters.minPlayers || '0',
    minVisits: filters.minVisits || '0',
    updatedWithin: filters.updatedWithin || 'any',
    genre: filters.genre || 'all',
    tag: filters.tag || 'all',
    limit,
    page,
  };
  return `bloxdb.roblox.cursor.${btoa(unescape(encodeURIComponent(JSON.stringify(stable))))}`;
}

function readStoredCursor(filters = {}, page = 1, limit = PAGE_SIZE) {
  if (page <= 1) return '';
  try {
    return sessionStorage.getItem(cursorStoreKey(filters, page - 1, limit)) || '';
  } catch {
    return '';
  }
}

function writeStoredCursor(filters = {}, page = 1, limit = PAGE_SIZE, nextCursor = null) {
  if (!nextCursor) return;
  try {
    sessionStorage.setItem(cursorStoreKey(filters, page, limit), String(nextCursor));
  } catch {
    // Cursor cache is optional. Search still works for the first page.
  }
}

async function safeRobloxSearch(filters = {}, { limit = PAGE_SIZE, page = 1 } = {}) {
  const query = getApiSearchQuery(filters);
  const sort = getSortName(filters.sort);
  const currentPage = Math.max(1, Number(page || 1));
  const storedCursor = readStoredCursor(filters, currentPage, limit);
  const cursor = query ? storedCursor : String((currentPage - 1) * limit);

  try {
    const live = await searchRobloxGames({ query, sort, limit, cursor });
    writeStoredCursor(filters, currentPage, limit, live.nextCursor);
    let games = live.games.map((game) => cleanGame(game, 'Roblox API'));
    games = applyFilters(games, filters);
    games = sortGames(games, filters.sort === 'bloxdbRating' ? 'popular' : filters.sort || 'popular');

    if (!games.length && (filters.query || filters.tag !== 'all' || filters.genre !== 'all')) {
      const local = await fallbackGames({ filters, limit, page, sourceError: null });
      if (local.games.length) {
        return {
          ...local,
          source: `${live.source || 'Roblox API'} + local tag fallback`,
          fallback: false,
          error: null,
        };
      }
    }

    return {
      games,
      nextCursor: live.nextCursor,
      source: live.source || 'Roblox API',
      fallback: false,
      error: null,
    };
  } catch (error) {
    console.warn('Roblox API search failed; using fallback data.', error);
    return fallbackGames({ filters, limit, page, sourceError: error });
  }
}

export async function searchGamesPage(filters = {}, options = {}) {
  return safeRobloxSearch(filters, options);
}

export async function searchGames(filters = {}) {
  const result = await searchGamesPage(filters, { limit: PAGE_SIZE, page: Number(filters.page || 1) });
  return result.games;
}

export async function getAllGames() {
  const result = await searchGamesPage({}, { limit: 60, page: 1 });
  return result.games;
}

export async function getGameById(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;

  try {
    const game = await getRobloxGameByPlaceOrUniverseId(cleanId);
    if (game) return cleanGame(game, 'Roblox API');
  } catch (error) {
    console.warn('Roblox game page lookup failed; checking fallback data.', error);
  }

  const fallback = mockGames.find((item) => [item.id, item.placeId, item.universeId, item.slug].map(String).includes(cleanId));
  if (!fallback) return null;
  const [hydrated] = await getMediaForGames([cleanGame(fallback, 'Fallback demo data')]);
  return { ...cleanGame(hydrated, 'Fallback demo data'), fallback: true };
}

export async function getGameStats(id) {
  const game = await getGameById(id);
  if (!game) return null;
  return {
    players: game.players,
    visits: game.visits,
    upvotes: game.upvotes,
    downvotes: game.downvotes,
    robloxRating: getRobloxLikeRatio(game),
    favorites: game.favorites,
    updatedAt: game.updatedAt,
    creator: game.creator,
    description: game.description,
  };
}

export async function getGameIcon(id) {
  const game = await getGameById(id);
  return game?.icon || null;
}

export async function getGameThumbnail(id) {
  const game = await getGameById(id);
  return game?.cover || null;
}

export async function getCreatorData(id) {
  const game = await getGameById(id);
  return game?.creator || null;
}

async function getRobloxList(limit = 6, sort = 'popular') {
  const result = await searchGamesPage({ sort }, { limit, page: 1 });
  return result.games;
}

export async function getPopularGames(limit = 6) {
  return getRobloxList(limit, 'popular');
}

export async function getRecentlyUpdatedGames(limit = 6) {
  const result = await searchGamesPage({ sort: 'newest' }, { limit: Math.max(limit * 2, 12), page: 1 });
  return sortGames(result.games, 'newest').slice(0, limit);
}

export async function getMostPlayedGames(limit = 6) {
  const result = await searchGamesPage({ sort: 'players' }, { limit: Math.max(limit * 2, 12), page: 1 });
  return sortGames(result.games, 'players').slice(0, limit);
}

export async function getMostVisitedGames(limit = 6) {
  const result = await searchGamesPage({ sort: 'popular' }, { limit: Math.max(limit * 2, 12), page: 1 });
  return sortGames(result.games, 'visits').slice(0, limit);
}

export async function getSimilarGames(id, limit = 4) {
  const game = await getGameById(id);
  if (!game) return [];

  if (game.universeId && !game.fallback) {
    try {
      const recommended = await getRecommendationsByUniverseId(game.universeId, limit);
      if (recommended.games.length) return recommended.games.map((item) => cleanGame(item, 'Roblox API')).slice(0, limit);
    } catch (error) {
      console.warn('Roblox recommendations failed; using fallback similarity.', error);
    }
  }

  const tags = new Set((game.tags || []).map(normalize));
  const scored = mockGames
    .filter((item) => String(item.id) !== String(game.id) && String(item.placeId) !== String(game.placeId))
    .map((item) => {
      const tagMatches = (item.tags || []).filter((tagName) => tags.has(normalize(tagName))).length;
      const genreMatch = normalize(item.genre) === normalize(game.genre) ? 2 : 0;
      return { item, score: tagMatches + genreMatch + (item.players || 0) / 100000 };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => cleanGame(item, 'Fallback demo data'));

  const hydrated = await getMediaForGames(scored.slice(0, limit));
  return hydrated.map((item) => ({ ...item, fallback: true }));
}

export function getGenres() {
  return [...new Set(mockGames.map((game) => game.genre).filter(Boolean))].sort();
}

export function getTags() {
  return [...new Set(mockGames.flatMap((game) => game.tags || []))].sort();
}
