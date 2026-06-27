// Cloudflare Worker proxy + community-rating API for BloxDB.
//
// Roblox proxy:
//   GET /?url=<encoded Roblox API URL>
//
// Community ratings, backed by Cloudflare D1 when the DB binding exists:
//   GET  /api/ratings?gameId=<placeId>
//   POST /api/ratings
//   GET  /api/ratings/summary?gameIds=<id,id,id>
//   GET  /api/ratings/top?limit=20&minRatings=1

const ROBLOX_HOSTS = new Set([
  'apis.roblox.com',
  'games.roblox.com',
  'thumbnails.roblox.com',
  'www.roblox.com',
]);

const ROBLOX_DATA_CACHE_SECONDS = 60 * 60 * 24; // refresh Roblox search/list/detail data every 24 hours

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Accept,Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/health') {
      return json({ ok: true, service: 'BloxDB Cloudflare Worker Roblox proxy + community API', hasDatabase: Boolean(env?.DB) });
    }

    if (requestUrl.pathname.startsWith('/api/ratings')) {
      return handleRatingsApi(request, env, requestUrl);
    }

    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return handleRobloxProxy(request, requestUrl);
  },
};

async function handleRatingsApi(request, env, requestUrl) {
  if (!env?.DB) {
    return json({
      error: 'Cloudflare D1 database is not configured. Add a DB binding in wrangler.toml and run db/schema.sql.',
    }, 503);
  }

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/ratings') {
      const gameId = cleanGameId(requestUrl.searchParams.get('gameId'));
      if (!gameId) return json({ error: 'Missing gameId.' }, 400);

      const { results } = await env.DB.prepare(`
        SELECT id, game_id, user_name, score, review, created_at, updated_at
        FROM ratings
        WHERE game_id = ?
        ORDER BY updated_at DESC
        LIMIT 100
      `).bind(gameId).all();

      return json({ ratings: (results || []).map(rowToRating) });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/ratings/summary') {
      const ids = [...new Set(String(requestUrl.searchParams.get('gameIds') || '')
        .split(',')
        .map(cleanGameId)
        .filter(Boolean))]
        .slice(0, 100);

      if (!ids.length) return json({ items: [] });

      const placeholders = ids.map(() => '?').join(',');
      const { results } = await env.DB.prepare(`
        SELECT game_id, ROUND(AVG(score), 1) AS average, COUNT(*) AS count
        FROM ratings
        WHERE game_id IN (${placeholders})
        GROUP BY game_id
      `).bind(...ids).all();

      const found = new Map((results || []).map((item) => [String(item.game_id), rowToSummary(item)]));
      return json({
        items: ids.map((gameId) => found.get(gameId) || { gameId, average: null, count: 0 }),
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/ratings/top') {
      const limit = clampNumber(requestUrl.searchParams.get('limit'), 1, 100, 20);
      const minRatings = clampNumber(requestUrl.searchParams.get('minRatings'), 1, 100, 1);

      const { results } = await env.DB.prepare(`
        SELECT game_id, ROUND(AVG(score), 1) AS average, COUNT(*) AS count
        FROM ratings
        GROUP BY game_id
        HAVING COUNT(*) >= ?
        ORDER BY average DESC, count DESC, game_id ASC
        LIMIT ?
      `).bind(minRatings, limit).all();

      return json({ items: (results || []).map(rowToSummary) });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/ratings') {
      const body = await request.json().catch(() => null);
      const gameId = cleanGameId(body?.gameId);
      const clientId = cleanClientId(body?.clientId);
      const user = cleanUserName(body?.user);
      const score = Number(body?.score);
      const review = cleanReview(body?.review);

      if (!gameId) return json({ error: 'Missing gameId.' }, 400);
      if (!clientId) return json({ error: 'Missing clientId.' }, 400);
      if (!Number.isInteger(score) || score < 1 || score > 10) return json({ error: 'Score must be an integer from 1 to 10.' }, 400);

      const id = `${gameId}:${clientId}`;
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO ratings (id, game_id, client_id, user_name, score, review, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_name = excluded.user_name,
          score = excluded.score,
          review = excluded.review,
          updated_at = excluded.updated_at
      `).bind(id, gameId, clientId, user, score, review, now, now).run();

      return json({
        rating: {
          id,
          gameId,
          user,
          score,
          review,
          date: now,
          local: false,
        },
      }, 201);
    }

    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    return json({ error: 'BloxDB community API failed.', detail: String(error?.message || error) }, 500);
  }
}

async function handleRobloxProxy(request, requestUrl) {
  const targetRaw = requestUrl.searchParams.get('url');
  if (!targetRaw) return json({ error: 'Missing ?url=<encoded Roblox API URL>' }, 400);
  if (targetRaw.length > 3000) return json({ error: 'Target URL is too long' }, 414);

  let target;
  try {
    target = new URL(targetRaw);
  } catch {
    return json({ error: 'Invalid target URL' }, 400);
  }

  if (target.protocol !== 'https:' || !ROBLOX_HOSTS.has(target.hostname)) {
    return json({ error: 'Only approved Roblox API hosts are allowed' }, 403);
  }

  const upstreamRequest = new Request(target.toString(), {
    method: 'GET',
    headers: {
      Accept: request.headers.get('accept') || 'application/json',
    },
  });

  try {
    const upstream = await fetch(upstreamRequest, {
      cf: {
        cacheEverything: true,
        cacheTtl: getCacheTtl(target),
      },
    });

    const headers = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    headers.set('Cache-Control', `public, max-age=${getCacheTtl(target)}`);
    headers.set('Vary', 'Accept');
    headers.delete('set-cookie');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return json({ error: 'Cloudflare Worker could not reach Roblox API', detail: String(error?.message || error) }, 502);
  }
}

function getCacheTtl(target) {
  // Keep the public Roblox catalog cache for one day. Ratings are handled by /api/ratings and are never cached.
  if (ROBLOX_HOSTS.has(target.hostname)) return ROBLOX_DATA_CACHE_SECONDS;
  return 120;
}

function cleanGameId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
}

function cleanClientId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
}

function cleanUserName(value) {
  return String(value || '').trim().slice(0, 32) || 'Guest Player';
}

function cleanReview(value) {
  return String(value || '').trim().slice(0, 800);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function rowToRating(row) {
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    user: String(row.user_name || 'Guest Player'),
    score: Number(row.score),
    review: String(row.review || ''),
    date: String(row.updated_at || row.created_at || new Date().toISOString()),
    local: false,
  };
}

function rowToSummary(row) {
  return {
    gameId: String(row.game_id),
    average: row.average === null || row.average === undefined ? null : Number(Number(row.average).toFixed(1)),
    count: Number(row.count || 0),
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
