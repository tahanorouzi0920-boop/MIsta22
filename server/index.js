'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { match } = require('./routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function dispatch(req, res, url) {
  const hit = match(req.method, url.pathname);
  if (!hit) throw new L.HttpError(404, 'مسیر یافت نشد');
  const { route, params } = hit;
  const ctx = { req, res, params, query: url.searchParams, ip: req.socket.remoteAddress || 'unknown', user: null, body: {}, form: null };

  if (route.auth) {
    ctx.user = L.currentUser(req);
    if (!ctx.user) throw new L.HttpError(401, 'نشست شما معتبر نیست؛ دوباره وارد شوید');
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const ct = String(req.headers['content-type'] || '');
    if (route.multipart) {
      const buf = await L.readBody(req, L.MAX_UPLOAD + 256 * 1024);
      ctx.form = L.parseMultipart(buf, ct);
    } else if (ct.includes('application/json')) {
      ctx.body = await L.readJSON(req);
    }
  }

  const result = await route.handler(ctx);
  if (result && result.raw) {
    res.writeHead(200, result.headers);
    res.end(result.raw);
    return;
  }
  if (Array.isArray(result)) return L.sendJSON(res, result[0], result[1]);
  return L.sendJSON(res, 200, result ?? { ok: true });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('یافت نشد'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  try {
    await dispatch(req, res, url);
  } catch (e) {
    if (e instanceof L.HttpError) return L.sendJSON(res, e.status, { error: e.message, fields: e.fields || {} });
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return L.sendJSON(res, 409, { error: 'رکورد تکراری است' });
    console.error('[MISTA] خطای داخلی:', e);
    return L.sendJSON(res, 500, { error: 'خطای داخلی سرور' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MISTA در حال اجرا روی http://${HOST}:${PORT}`);
});
