'use strict';

/**
 * Remembers what the headless browser saw for each extraction (cookies and
 * the exact request headers per media URL) so downloads can replay them.
 * Many ad-heavy hosts reject requests without the right Referer / Origin /
 * cookies (hotlink protection), which was the #1 cause of failed downloads.
 */
const crypto = require('crypto');
const { DEFAULT_UA, hostOf } = require('./util');

const TTL = 3 * 60 * 60 * 1000;
const sessions = new Map();

function createSession({ pageUrl, userAgent, cookies = [], requestHeaders = new Map() }) {
  const id = crypto.randomBytes(9).toString('base64url');
  sessions.set(id, { id, pageUrl, userAgent, cookies, requestHeaders, createdAt: Date.now() });
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > TTL) { sessions.delete(id); return null; }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > TTL) sessions.delete(id);
}, 10 * 60 * 1000).unref();

function cookieMatches(c, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  const dom = String(c.domain || '').toLowerCase().replace(/^\./, '');
  if (!dom) return false;
  const domOk = host === dom || host.endsWith('.' + dom);
  const pathOk = u.pathname.startsWith(c.path || '/');
  const secureOk = !c.secure || u.protocol === 'https:';
  const notExpired = !c.expires || c.expires < 0 || c.expires * 1000 > Date.now();
  return domOk && pathOk && secureOk && notExpired;
}

function cookieHeaderFor(cookies, url) {
  return (cookies || []).filter(c => cookieMatches(c, url)).map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Build request headers for fetching `url` outside the browser.
 * Priority: exact headers captured for this URL > headers captured for the
 * same host > referer passed by the client > page URL.
 */
function headersFor(url, { sid, referer } = {}) {
  const s = getSession(sid);
  const h = {};
  if (s) {
    let captured = s.requestHeaders.get(url);
    if (!captured) {
      const host = hostOf(url);
      for (const [u, hh] of s.requestHeaders) if (hostOf(u) === host) { captured = hh; break; }
    }
    if (captured) Object.assign(h, captured);
    const ck = cookieHeaderFor(s.cookies, url);
    if (ck) h.cookie = ck;
    h['user-agent'] = s.userAgent || DEFAULT_UA;
  }
  if (referer && !h.referer) h.referer = referer;
  if (!h.referer && s?.pageUrl) h.referer = s.pageUrl;
  if (!h['user-agent']) h['user-agent'] = DEFAULT_UA;
  if (h.referer && !h.origin) {
    try {
      const ro = new URL(h.referer).origin;
      if (ro !== new URL(url).origin) h.origin = ro;
    } catch { /* ignore */ }
  }
  return h;
}

/** Netscape cookies.txt for yt-dlp. */
function netscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    const domain = c.domain.startsWith('.') ? c.domain : (c.hostOnly === false ? '.' + c.domain : c.domain);
    lines.push([
      domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      c.expires && c.expires > 0 ? Math.floor(c.expires) : 0, c.name, c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

module.exports = { createSession, getSession, headersFor, cookieHeaderFor, netscapeCookies };
