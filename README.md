# BloxDB — Roblox Game Database

BloxDB is a clean Roblox game database prototype with live Roblox data, clean URLs, game pages, community ratings and reviews.

This build is configured for:

```txt
https://damiranva2.github.io/bloxdb/
```

## What changed in this build

- GitHub Pages subpath support: all static assets load from `/bloxdb/...`.
- Clean app routes still look like `/bloxdb/game/<placeId>` instead of `/#/game/<placeId>`.
- `404.html` is a copy of the app, so GitHub Pages direct links such as `/bloxdb/game/11928087342` can load the SPA instead of showing GitHub's default “File not found” page.
- BloxDB ratings/reviews are server-first through the Cloudflare Worker + D1 API.
- New ratings are **not silently saved as private local-only ratings** when the server is unavailable. If D1 is not configured, the app shows an error so you know the rating was not saved online.
- Roblox search/list/detail data is cached for 24 hours in the browser and by the Worker. After 24 hours the app refreshes from Roblox, so new/updated games can appear in search.
- Game pages still get unique English meta descriptions and canonical URLs.

## Project structure

```txt
bloxdb/
├── index.html
├── 404.html
├── style.css
├── script.js
├── api.js
├── robloxApi.js
├── data.js
├── storage.js
├── dev-server.js
├── package.json
├── wrangler.toml
├── wrangler.d1.example.toml
├── db/
│   └── schema.sql
├── proxy/
│   └── cloudflare-worker.js
└── README.md
```

## GitHub Pages clean URLs

The app routes are:

```txt
/bloxdb/
/bloxdb/search
/bloxdb/top-rated
/bloxdb/most-played
/bloxdb/recently-updated
/bloxdb/game/2753915549
```

Important GitHub Pages limitation: GitHub Pages does not support real rewrite rules for single-page apps. A direct refresh on `/bloxdb/game/11928087342` is internally served through `404.html`. This is normal for GitHub Pages. The user should see the actual game page, not GitHub's default “File not found” screen, because `404.html` loads the same app.

Keep `404.html` in the repository root. Do not delete it.

## Assets / base path

This build is already configured in `index.html` and `404.html`:

```js
window.BLOXDB_BASE_PATH = '/bloxdb';
```

Static files are linked like this:

```html
<link rel="stylesheet" href="/bloxdb/style.css">
<script type="module" src="/bloxdb/script.js"></script>
<link rel="icon" href="/bloxdb/favicon.ico" sizes="any">
```

If you later move the site to a custom domain root, change `/bloxdb` back to an empty string and change asset URLs back to `/style.css`, `/script.js`, and `/favicon.ico`.

## SEO meta / canonical

`script.js` updates these tags on every route:

- `<title>`
- `<meta name="description">`
- `<link rel="canonical">`
- Open Graph title/description

Game pages get a unique English description like:

```txt
See ratings and reviews for Blox Fruits on BloxDB. Compare Roblox stats, active players, visits and community scores.
```

Canonical URLs are generated without `#`, for example:

```txt
https://damiranva2.github.io/bloxdb/game/2753915549
```

## Roblox API Worker

Roblox API calls go through the Cloudflare Worker because browser CORS blocks many direct Roblox JSON API calls.

Frontend config in `index.html`:

```js
const BLOXDB_PRODUCTION_WORKER_URL = 'https://bloxdb-roblox-api.damiryoubro.workers.dev';
window.BLOXDB_CLOUDFLARE_WORKER_URL = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? BLOXDB_LOCAL_WORKER_URL
  : BLOXDB_PRODUCTION_WORKER_URL;
window.BLOXDB_COMMUNITY_API_URL = window.BLOXDB_CLOUDFLARE_WORKER_URL;
```

After deploying your own Worker, replace `BLOXDB_PRODUCTION_WORKER_URL` with your real Worker URL.

Health check:

```txt
https://your-worker.your-subdomain.workers.dev/health
```

The Worker only allows these Roblox API hosts:

- `apis.roblox.com`
- `games.roblox.com`
- `thumbnails.roblox.com`
- `www.roblox.com`

## Community ratings server with Cloudflare D1

GitHub Pages cannot store shared ratings by itself. For ratings/reviews that every visitor can see, you need the included free Cloudflare Worker + Cloudflare D1 database.

The Worker exposes:

```txt
GET  /api/ratings?gameId=<placeId>
POST /api/ratings
GET  /api/ratings/summary?gameIds=<id,id,id>
GET  /api/ratings/top?limit=20&minRatings=1
```

### 1. Install / login

```bash
cd bloxdb
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create bloxdb-community
```

Cloudflare prints a `database_id`. Copy it.

### 3. Add the D1 binding

Open `wrangler.d1.example.toml`, copy the `[[d1_databases]]` block into `wrangler.toml`, and replace:

```txt
PASTE_YOUR_D1_DATABASE_ID_HERE
```

with your real database id.

### 4. Create the ratings table

For local Worker testing:

```bash
npx wrangler d1 execute bloxdb-community --local --file db/schema.sql
```

For the deployed Worker database:

```bash
npx wrangler d1 execute bloxdb-community --remote --file db/schema.sql
```

### 5. Deploy Worker

```bash
npm run worker:deploy
```

Then put the deployed Worker URL into `index.html`:

```js
const BLOXDB_PRODUCTION_WORKER_URL = 'https://bloxdb-roblox-api.your-subdomain.workers.dev';
```

## 24-hour Roblox search refresh

`robloxApi.js` and `proxy/cloudflare-worker.js` are set to refresh Roblox catalog/search/detail data every 24 hours:

```js
const ROBLOX_DATA_REFRESH_MS = 1000 * 60 * 60 * 24;
```

```js
const ROBLOX_DATA_CACHE_SECONDS = 60 * 60 * 24;
```

Ratings are not cached by the Worker and are returned live from D1.

## Local development

Use two terminals.

### Terminal 1: Worker

```bash
cd bloxdb
npm run worker:dev
```

Worker runs at:

```txt
http://127.0.0.1:8787
```

### Terminal 2: site

```bash
cd bloxdb
npm run dev
```

Site runs at:

```txt
http://localhost:5173/bloxdb/
```

Clean route test:

```txt
http://localhost:5173/bloxdb/game/2753915549
```

## Rating logic

BloxDB ratings are completely separate from Roblox stats.

- Roblox upvotes, downvotes, visits and active player count are official Roblox data.
- BloxDB rating is the site's own community score.
- No fake BloxDB scores are generated.
- No fake BloxDB reviews are generated.
- Top Rated uses real BloxDB community ratings from the Worker/D1 API.
- LocalStorage is only used as cache/user identity. It is not the source of truth for shared ratings.
- If the Worker or D1 database is unavailable, new ratings are rejected instead of being saved privately only on your computer.

## Deploy notes for `damiranva2.github.io/bloxdb`

1. Put all files from this archive in the repository root.
2. Keep `index.html`, `404.html`, `style.css`, `script.js`, etc. at the root of the GitHub Pages branch.
3. Deploy the Worker.
4. Configure D1.
5. Put your Worker URL in `index.html`.
6. Open `https://damiranva2.github.io/bloxdb/`.
7. Test direct refresh: `https://damiranva2.github.io/bloxdb/game/11928087342`.

## Notes

BloxDB is unofficial and is not affiliated with Roblox Corporation. Roblox data belongs to Roblox and its creators. The Worker proxy is intentionally restricted to Roblox API hosts only.
