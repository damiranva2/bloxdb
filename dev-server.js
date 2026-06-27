// Static development server for BloxDB.
// Roblox API requests are not proxied here. Configure a Cloudflare Worker URL in
// index.html, or run the Worker locally with Wrangler at http://127.0.0.1:8787.

import http from 'node:http';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const BASE_PATH = '/bloxdb';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function stripBasePath(urlPathname) {
  if (urlPathname === BASE_PATH) return '/';
  if (urlPathname.startsWith(`${BASE_PATH}/`)) return urlPathname.slice(BASE_PATH.length) || '/';
  return urlPathname;
}

function safeStaticPath(urlPathname) {
  const decoded = decodeURIComponent(stripBasePath(urlPathname).split('?')[0]);
  const clean = decoded === '/' ? '/index.html' : decoded;
  const normalized = path.normalize(clean).replace(/^([/\\])+/, '');
  const fullPath = path.join(ROOT, normalized);
  return fullPath.startsWith(ROOT) ? fullPath : null;
}


const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'BloxDB static dev server' }), { 'Content-Type': MIME['.json'] });
  }

  const filePath = safeStaticPath(requestUrl.pathname);
  if (!filePath || !existsSync(filePath)) {
    const index = await readFile(path.join(ROOT, 'index.html'));
    return send(res, 200, index, { 'Content-Type': MIME['.html'] });
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`BloxDB static dev server running at http://localhost:${PORT}${BASE_PATH}/`);
  console.log('Roblox API calls go through the Cloudflare Worker configured in index.html.');
});
