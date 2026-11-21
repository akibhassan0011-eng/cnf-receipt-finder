'use strict';
/**
 * C&F Receipt Finder - proxy server (zero dependencies, Node 18+)
 *
 * - Portal-e auto login kore session cookie dhore rakhe
 * - GET /api/health            -> login test
 * - GET /api/check?id=N&name=&ain=&barcode=&mode=all|any
 *                              -> receipt N fetch kore match kore (JSON)
 * - GET /api/receipt?id=N      -> receipt HTML (safe, images inline, auto-print/refresh bad)
 *
 * Auth: x-api-key header ba ?key= query (iframe-er jonno)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- tiny .env loader ----------
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* .env na thakle environment variable use hobe */ }

const PORT = parseInt(process.env.PORT || '3000', 10);
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN || 'http://122.152.50.54:81').replace(/\/+$/, '');
const ADMIN_PATH = '/cnf_final/final/cms/admin/';
const ADMIN_URL = PORTAL_ORIGIN + ADMIN_PATH;
const USER = process.env.PORTAL_USER;
const PASS = process.env.PORTAL_PASS;
const API_KEY = process.env.API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PORTAL_TIMEOUT = parseInt(process.env.PORTAL_TIMEOUT_MS || '25000', 10);

if (!USER || !PASS || !API_KEY) {
  console.error('ERROR: .env-e PORTAL_USER, PORTAL_PASS, API_KEY set korun (.env.example dekhun).');
  process.exit(1);
}
if (API_KEY.length < 16) console.warn('WARNING: API_KEY kom kore 16 character-er lomba rakhun.');
if (ALLOWED_ORIGIN === '*') console.warn('WARNING: ALLOWED_ORIGIN set nai; shudhu API key-er upor nirbhor korche.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// ---------- cookie jar + portal fetch ----------
const jar = new Map();

function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || value === 'deleted') jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');

async function portalFetch(url, opts = {}, hops = 0) {
  const res = await fetch(url, {
    ...opts,
    redirect: 'manual',
    headers: { ...(opts.headers || {}), Cookie: cookieHeader(), 'User-Agent': 'Mozilla/5.0 (CnfReceiptFinder)' },
    signal: AbortSignal.timeout(PORTAL_TIMEOUT),
  });
  storeCookies(res);
  if ([301, 302, 303, 307, 308].includes(res.status) && hops < 5) {
    const loc = res.headers.get('location');
    if (loc) {
      await res.arrayBuffer().catch(() => {});
      return portalFetch(new URL(loc, url).href, { method: 'GET' }, hops + 1);
    }
  }
  return res;
}

const isLoginPage = (html) => /name\s*=\s*["']data\[password\]["']/i.test(html);

let loginPromise = null;
function login() {
  if (!loginPromise) {
    loginPromise = (async () => {
      jar.clear();
      const loginUrl = ADMIN_URL + '?app=admin&action=_login';
      await (await portalFetch(loginUrl)).arrayBuffer().catch(() => {}); // initial session cookie
      const body = new URLSearchParams({ 'data[username]': USER, 'data[password]': PASS, remember: '1' });
      const res = await portalFetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const html = await res.text();
      if (isLoginPage(html)) throw new Error('Portal login fail: username/password .env-e thik ache kina dekhun');
      console.log(new Date().toISOString(), 'Portal login OK');
    })().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

// logged-in HTML fetch; login page ele ekbar relogin kore retry
async function getHtmlOnce(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jar.size) await login();
    const res = await portalFetch(url);
    const html = await res.text();
    if (isLoginPage(html)) { jar.clear(); continue; }
    return { status: res.status, html };
  }
  await login();
  const res = await portalFetch(url);
  const html = await res.text();
  if (isLoginPage(html)) throw new Error('Login-er por-o login page ashche');
  return { status: res.status, html };
}

// Portal slow/timeout hole 3 bar porjonto abar chesta kore (login vul hole retry kore na)
async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (/login/i.test(e.message)) throw e;
      if (i < tries - 1) await sleep(800 * (i + 1));
    }
  }
  throw err;
}
const getHtml = (url) => withRetry(() => getHtmlOnce(url));

// ---------- receipt parsing / matching ----------
const receiptUrl = (id) => ADMIN_URL + '?app=cnf-exportdepot&action=_print&ids=' + id;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
}
function visibleText(html) {
  return decodeEntities(
    html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function isValidReceipt(html) { return /id\s*=\s*["']wrapper["']/i.test(html); }

function barcodeOf(html) {
  const m = html.match(/barcode[^"']*?[?&]text=([^&"'\s]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

function summarize(text, html) {
  const nameM = text.match(/Agent Name\s*:\s*(.*?)\s+AIN\s*:/i);
  const ainM = text.match(/\bAIN\s*:\s*(\d+)/i);
  const noM = text.match(/no:\s*(\S+)/i);
  return {
    receiptNo: noM ? noM[1] : '',
    name: nameM ? nameM[1].trim() : '',
    ain: ainM ? ainM[1] : '',
    barcode: barcodeOf(html),
  };
}

// AIN ar Barcode-e comma (,) ba ; diye ekadhik value deya jay: jekono ekta milleo hobe.
// Name-e comma thakte pare, tai Name split kora hoy na.
const splitList = (s) => String(s || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

function matches(text, html, q, mode) {
  const hay = norm(text) + '|' + norm(barcodeOf(html));
  const has = (v) => hay.includes(norm(v));
  const results = [];
  if (q.name) results.push(has(q.name));
  if (q.ain.length) results.push(q.ain.some(has));
  const hitBarcodes = q.barcode.filter(has);
  if (q.barcode.length) results.push(hitBarcodes.length > 0);
  const ok = mode === 'any' ? results.some(Boolean) : results.every(Boolean);
  return { ok, hitBarcodes: ok ? hitBarcodes : [] };
}

// ---------- receipt HTML cleanup (iframe-e dekhanor jonno) ----------
const assetCache = new Map();
async function toDataUri(rel) {
  let abs;
  try { abs = new URL(rel, ADMIN_URL).href; } catch (e) { return null; }
  if (!abs.startsWith(PORTAL_ORIGIN + '/')) return null; // shudhu portal theke (SSRF guard)
  if (assetCache.has(abs)) return assetCache.get(abs);
  const res = await portalFetch(abs);
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)$/.test(ct)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 2 * 1024 * 1024) return null;
  const uri = 'data:' + ct + ';base64,' + buf.toString('base64');
  if (assetCache.size < 300) assetCache.set(abs, uri);
  return uri;
}

async function prepareReceipt(html) {
  html = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '') // 1s por por redirect bondho
    .replace(/<script\b[\s\S]*?<\/script>/gi, ''); // auto print() bondho
  const refs = new Set();
  html.replace(/\ssrc\s*=\s*(["'])([^"']+)\1/gi, (m, q, u) => { refs.add(u); return m; });
  html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => { refs.add(u); return m; });
  const map = new Map();
  await Promise.all([...refs].filter((u) => !/^data:/i.test(u)).map(async (u) => {
    try { const d = await toDataUri(decodeEntities(u)); if (d) map.set(u, d); } catch (e) { /* ignore */ }
  }));
  html = html.replace(/(\ssrc\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, u) => (map.has(u) ? pre + q + map.get(u) + q : m));
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => (map.has(u) ? 'url(' + q + map.get(u) + q + ')' : m));
  return html;
}

// ---------- http server ----------
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function authorized(req, u) {
  const key = req.headers['x-api-key'] || u.searchParams.get('key') || '';
  return crypto.timingSafeEqual(sha(key), sha(API_KEY));
}
function parseId(u) {
  const id = parseInt(u.searchParams.get('id') || '', 10);
  return Number.isInteger(id) && id > 0 && id < 1e12 ? id : null;
}

function parseIds(u) {
  const raw = u.searchParams.get('ids') || u.searchParams.get('id') || '';
  const ids = raw.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0 && n < 1e12);
  return [...new Set(ids)].slice(0, 50);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('C&F Receipt Finder proxy is running.');
    return;
  }
  if (!u.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  if (!authorized(req, u)) { await sleep(500); return sendJson(res, 401, { error: 'API key thik nai' }); }

  try {
    if (u.pathname === '/api/health') {
      if (!jar.size) await login();
      return sendJson(res, 200, { ok: true, loggedIn: jar.size > 0 });
    }

    if (u.pathname === '/api/check') {
      const id = parseId(u);
      if (!id) return sendJson(res, 400, { error: 'id dorkar' });
      const q = {
        name: (u.searchParams.get('name') || '').trim(),
        ain: splitList(u.searchParams.get('ain')),
        barcode: splitList(u.searchParams.get('barcode')),
      };
      if (!q.name && !q.ain.length && !q.barcode.length) return sendJson(res, 400, { error: 'name/ain/barcode-er ekta dorkar' });
      const mode = u.searchParams.get('mode') === 'any' ? 'any' : 'all';
      const { status, html } = await getHtml(receiptUrl(id));
      if (status >= 400 || !isValidReceipt(html)) return sendJson(res, 200, { id, status: 'empty', match: false });
      const text = visibleText(html);
      const m = matches(text, html, q, mode);
      return sendJson(res, 200, { id, status: 'ok', match: m.ok, hits: m.hitBarcodes, info: summarize(text, html) });
    }

    if (u.pathname === '/api/receipt') {
      // ?id=N ba ?ids=N1,N2,N3 (max 50): ekadhik hole shob receipt ek page-e, protita alada print page-e
      const ids = parseIds(u);
      if (!ids.length) return sendJson(res, 400, { error: 'id dorkar' });
      const parts = new Array(ids.length).fill(null);
      for (let i = 0; i < ids.length; i += 5) {
        await Promise.all(ids.slice(i, i + 5).map(async (id, k) => {
          const { status, html } = await getHtml(receiptUrl(id));
          if (status < 400 && isValidReceipt(html)) parts[i + k] = await prepareReceipt(html);
        }));
      }
      const valid = parts.filter(Boolean);
      if (!valid.length) return sendJson(res, 404, { error: 'receipt paoa jay nai' });
      let out = valid[0];
      if (valid.length > 1) {
        const head = valid[0].match(/^[\s\S]*?<body[^>]*>/i);
        const bodies = valid.map((p) => { const m = p.match(/<body[^>]*>([\s\S]*?)<\/body>/i); return m ? m[1] : p; });
        out = (head ? head[0] : '<html><body>') + bodies.join('\n') + '</body></html>';
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      });
      res.end(out);
      return;
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(new Date().toISOString(), 'ERROR', e.message);
    return sendJson(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => console.log('Proxy listening on port ' + PORT + ' -> ' + ADMIN_URL));
