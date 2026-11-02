'use strict';

const { DEFAULT_UA } = require('./util');

/**
 * Small wrapper around Node's global fetch with timeout, abort, and
 * consistent error messages. Throws on HTTP >= 400.
 */
async function httpGet(url, { headers = {}, signal, responseType = 'buffer', timeout = 30000 } = {}) {
  const h = { 'user-agent': DEFAULT_UA, accept: '*/*', ...lower(headers) };
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.any(signals) });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const err = new Error(`HTTP ${res.status} ${res.statusText || ''} for ${shortUrl(url)}`.trim());
    err.status = res.status;
    throw err;
  }
  let body;
  if (responseType === 'text') body = await res.text();
  else if (responseType === 'stream') body = res.body;
  else body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, url: res.url, body };
}

function lower(h) {
  const o = {};
  for (const [k, v] of Object.entries(h || {})) if (v != null && v !== '') o[k.toLowerCase()] = String(v);
  return o;
}

function shortUrl(u) {
  return u.length > 120 ? u.slice(0, 117) + '...' : u;
}

module.exports = { httpGet, lower };
