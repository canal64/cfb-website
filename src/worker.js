/**
 * $CFB community website — Cloudflare Worker
 * Serves the static site (./public) and two small JSON endpoints used by the page:
 *   GET /api/market  -> $CFB and $QUBIC prices (cached 60 s)
 *   GET /api/status  -> current Qubic tick / epoch (cached 20 s)
 * Every upstream call has a timeout and a fallback, so the page never breaks:
 * a field the source can't provide comes back as null and the page shows "—".
 */

const CFB_ISSUER = 'CFBMEMZOIDEXQAUXYYSZIURADQLAPWPMNJXQSNVQZAHYVOPYUKKJBJUCTVJL';
const HEADERS = { 'User-Agent': 'cfb-website', Accept: 'application/json' }; // generic id, nothing personal

async function getJSON(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, cf: { cacheTtl: 30 } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const num = v => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? n : null; };

/* $CFB on CoinPaprika (aggregated price, 24h/7d/30d change, ATH) */
async function cfbPaprika() {
  const j = await getJSON('https://api.coinpaprika.com/v1/tickers/cfb-cfb-token');
  const q = j?.quotes?.USD;
  if (!q?.price) return null;
  return { price: q.price, change24h: num(q.percent_change_24h), change7d: num(q.percent_change_7d), change30d: num(q.percent_change_30d),
    volume24h: num(q.volume_24h), ath: num(q.ath_price), athDate: q.ath_date || null, fromAth: num(q.percent_from_price_ath), source: 'CoinPaprika' };
}

/* $CFB/USDT on SafeTrade (Peatio-style public API; two known path variants) — fallback */
async function cfbTicker() {
  const p = await cfbPaprika();
  if (p) return p;
  for (const u of [
    'https://safe.trade/api/v2/peatio/public/markets/cfbusdt/tickers',
    'https://safe.trade/api/v2/trade/public/markets/cfbusdt/tickers',
  ]) {
    const j = await getJSON(u);
    const t = j?.ticker || j;
    const last = num(t?.last);
    if (last) return { price: last, change24h: num(t?.price_change_percent), volume24h: num(t?.volume ?? t?.amount), source: 'SafeTrade' };
  }
  return null;
}

/* $QUBIC/USD: CoinGecko first, SafeTrade QUBIC/USDT as fallback (CoinGecko rate-limits shared IPs) */
async function qubicPrice() {
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=qubic-network&vs_currencies=usd&include_24hr_change=true');
  const q = j?.['qubic-network'];
  if (q?.usd) return { price: q.usd, change24h: num(q.usd_24h_change), source: 'CoinGecko' };
  for (const u of [
    'https://safe.trade/api/v2/peatio/public/markets/qubicusdt/tickers',
    'https://safe.trade/api/v2/trade/public/markets/qubicusdt/tickers',
  ]) {
    const t = (await getJSON(u))?.ticker;
    const last = num(t?.last);
    if (last) return { price: last, change24h: num(t?.price_change_percent), source: 'SafeTrade' };
  }
  return null;
}

async function market() {
  const [cfb, qubic] = await Promise.all([cfbTicker(), qubicPrice()]);
  return { ok: !!(cfb || qubic), complete: !!(cfb && qubic), cfb, qubic, issuer: CFB_ISSUER, updated: new Date().toISOString() };
}

/* Qubic network status from the public RPC */
async function status() {
  const ti = await getJSON('https://rpc.qubic.org/v1/tick-info');
  if (ti?.tickInfo) {
    const { tick, epoch, initialTick } = ti.tickInfo;
    return { ok: true, tick, epoch, initialTick, source: 'rpc.qubic.org', updated: new Date().toISOString() };
  }
  const lt = await getJSON('https://rpc.qubic.org/v1/latest-tick');
  if (lt?.latestTick) return { ok: true, tick: lt.latestTick, epoch: null, source: 'rpc.qubic.org', updated: new Date().toISOString() };
  return { ok: false };
}

/* Exchange logos: fetched from each exchange's own site (fixed allowlist), cached at the edge for a week.
   Falls back to Google's favicon service if the site doesn't answer. */
const LOGOS = {
  qx:        ['https://app.qubicportal.org/assets/logos/favicon.svg', 'app.qubicportal.org'],
  qswap:     ['https://swap.qubicportal.org/logo.svg', 'swap.qubicportal.org'],
  safetrade: ['https://safetrade.com/favicon.ico', 'safetrade.com'],
};
async function logo(request, ctx, name) {
  const entry = LOGOS[name];
  if (!entry) return new Response('Not found', { status: 404 });
  const cache = caches.default, key = new Request(new URL(request.url).toString());
  const hit = await cache.match(key); if (hit) return hit;
  let up = null;
  for (const u of [entry[0], `https://www.google.com/s2/favicons?domain=${entry[1]}&sz=128`]) {
    try { const r = await fetch(u, { headers: { 'User-Agent': 'cfb-website' } }); if (r.ok) { up = r; break; } } catch {}
  }
  if (!up) return new Response('Logo unavailable', { status: 502 });
  const res = new Response(up.body, { headers: { 'Content-Type': up.headers.get('Content-Type') || 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* small edge cache so a busy page doesn't hammer the APIs */
async function cached(request, ctx, ttl, producer) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const body = await producer();
  const res = new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': (body.ok && body.complete !== false) ? `public, max-age=${ttl}` : 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
  // cache only complete answers, so a temporary upstream miss isn't frozen for a minute
  if (body.ok && body.complete !== false) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/market') return cached(request, ctx, 60, market);
    if (pathname === '/api/status') return cached(request, ctx, 20, status);
    const lm = pathname.match(/^\/logos\/([a-z]+)$/); if (lm) return logo(request, ctx, lm[1]);
    return env.ASSETS.fetch(request); // everything else = static site
  },
};
