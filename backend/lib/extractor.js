'use strict';

const puppeteer = require('puppeteer');
const {
  DEFAULT_UA, classify, isAdUrl, isHttpUrl, resolveUrl, sanitizeRequestHeaders, sleep, hostOf,
  DIRECT_TYPES, STREAM_TYPES,
} = require('./util');
const { scanText } = require('./scan');
const { isMaster, parseMaster } = require('./hls');
const { createSession, headersFor } = require('./sessions');
const { httpGet } = require('./http');
const inpage = require('./inpage');

// ---------------------------------------------------------------------------
// Shared browser (one per headless mode). Each extraction gets its own
// incognito context, which is always closed afterwards.
// ---------------------------------------------------------------------------
const browsers = {};

async function getBrowser(headless) {
  const key = headless ? 'headless' : 'headful';
  const existing = browsers[key];
  if (existing) {
    const b = await existing.catch(() => null);
    if (b && b.connected) return b;
    delete browsers[key];
  }
  browsers[key] = puppeteer.launch({
    headless: headless ? true : false,
    defaultViewport: { width: 1366, height: 768 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      // Keep cross-origin iframes in-process so request interception, the
      // preload script and frame.evaluate() reach embedded players.
      '--disable-features=IsolateOrigins,site-per-process,Translate',
      '--disable-site-isolation-trials',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const b = await browsers[key];
  b.on('disconnected', () => { delete browsers[key]; });
  return b;
}

async function closeBrowsers() {
  for (const k of Object.keys(browsers)) {
    const b = await browsers[k].catch(() => null);
    delete browsers[k];
    if (b) await b.close().catch(() => {});
  }
}

// Simple semaphore so we never run too many Chromes at once.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_EXTRACTIONS || 2);
let running = 0;
const queue = [];
async function acquire() {
  if (running < MAX_CONCURRENT) { running++; return; }
  await new Promise(r => queue.push(r));
  running++;
}
function release() {
  running--;
  const n = queue.shift();
  if (n) n();
}

// ---------------------------------------------------------------------------
// Candidate bookkeeping & scoring
// ---------------------------------------------------------------------------
const SOURCE_BONUS = {
  network: 22, 'dom-video': 25, 'dom-source': 20, jwplayer: 22, videojs: 22, plyr: 18, hlsjs: 22,
  dashjs: 20, clappr: 18, hook: 16, meta: 12, jsonld: 12, global: 10, packed: 10, base64: 8, text: 2,
};
const TYPE_BASE = { hls: 60, dash: 55, mp4: 52, webm: 46, mkv: 44, mov: 42, flv: 38, video: 40, audio: 10 };

function makeStore(pageUrl) {
  const map = new Map();
  return {
    map,
    add(url, type, how, extra = {}) {
      if (!isHttpUrl(url)) return null;
      if (!type || type === 'segment') return null;
      let c = map.get(url);
      if (!c) {
        c = {
          url, type, sources: new Set(), labels: new Set(), frameUrl: extra.frameUrl || pageUrl,
          contentType: null, size: null, headers: null, isAd: isAdUrl(url), firstSeen: Date.now(),
          playlist: null,
        };
        map.set(url, c);
      }
      c.sources.add(how);
      if (extra.label) c.labels.add(String(extra.label));
      if (extra.contentType) c.contentType = extra.contentType;
      if (extra.size && (!c.size || extra.size > c.size)) c.size = extra.size;
      if (extra.headers && !c.headers) c.headers = extra.headers;
      if (extra.frameUrl && c.frameUrl === pageUrl) c.frameUrl = extra.frameUrl;
      // Upgrade generic types once we learn more.
      if (c.type === 'video' && type !== 'video') c.type = type;
      return c;
    },
  };
}

function scoreCandidate(c, videoInfo) {
  let s = TYPE_BASE[c.type] ?? 20;
  let best = 0;
  for (const src of c.sources) best = Math.max(best, SOURCE_BONUS[src] ?? 5);
  s += best + Math.min(15, (c.sources.size - 1) * 5);
  if (c.playlist?.isMaster) s += 15;
  if (c.size) {
    if (c.size > 50e6) s += 18;
    else if (c.size > 10e6) s += 10;
    else if (c.size < 1.5e6) s -= 20;
  }
  if (c.isAd) s -= 100;
  if (/(^|[/_.-])(preview|thumb|trailer|sample|teaser|intro|promo|ads?)([/_.-]|$)/i.test(c.url)) s -= 15;
  const vi = videoInfo.find(v => v.src === c.url);
  if (vi) {
    if (vi.duration && vi.duration < 45) s -= 30; // likely a pre-roll ad
    if (vi.duration && vi.duration > 300) s += 10;
    if (vi.height) s += Math.min(10, vi.height / 108);
  }
  if (c.playlist?.drm) s -= 40;
  return Math.round(s);
}

function isStrong(c) {
  return !c.isAd && (STREAM_TYPES.has(c.type) || (DIRECT_TYPES.has(c.type) && c.type !== 'audio')) &&
    [...c.sources].some(s => STRONG_SOURCES.has(s));
}

const STRONG_SOURCES = new Set([
  'network', 'dom-video', 'dom-source', 'hlsjs', 'dashjs', 'jwplayer', 'videojs', 'plyr', 'clappr', 'packed', 'meta', 'jsonld',
]);

/** The URL a request "belongs to" (used as Referer when replaying it). */
function contextUrlOf(req, resourceUrl, fallback) {
  try {
    // For a document the response itself is the context of what it contains.
    if (req.resourceType() === 'document') return resourceUrl;
    const f = req.frame();
    const fu = f && f.url();
    if (isHttpUrl(fu)) return fu;
    const ref = req.headers().referer;
    if (isHttpUrl(ref)) return ref;
  } catch { /* detached frame */ }
  return fallback;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------
/**
 * @param {string} url
 * @param {object} opts { timeout, headless, blockAds, referer, log }
 */
async function extractWithBrowser(url, opts = {}) {
  const {
    timeout = 45000, headless = true, blockAds = true, referer, log = () => {},
  } = opts;
  const started = Date.now();
  const deadline = started + timeout;
  const store = makeStore(url);
  const requestHeaders = new Map();
  const stats = { popupsBlocked: 0, adsBlocked: 0, navBlocked: 0, segments: 0, dialogs: 0 };
  const warnings = [];
  const segmentHosts = new Map();

  await acquire();
  let context;
  try {
    const browser = await getBrowser(headless);
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent(DEFAULT_UA);
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(inpage.preload);

    // Kill any popup/popunder tab that still manages to open.
    context.on('targetcreated', async (t) => {
      if (t.type() !== 'page') return;
      try {
        const p = await t.page();
        if (p && p !== page) { stats.popupsBlocked++; log(`🚫 closed popup tab: ${t.url()}`); await p.close(); }
      } catch { /* already gone */ }
    });

    page.on('dialog', d => { stats.dialogs++; d.dismiss().catch(() => {}); });
    page.on('popup', p => { stats.popupsBlocked++; p?.close().catch(() => {}); });

    let mainDocKey = null;
    let initialLoadDone = false;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return;
      const u = req.url();
      const rt = req.resourceType();
      try {
        if (blockAds && isAdUrl(u)) {
          stats.adsBlocked++;
          return req.abort('blockedbyclient');
        }
        if (rt === 'font') return req.abort('blockedbyclient');
        // Prevent ad scripts from hijacking the whole tab ("click -> redirect").
        // Only a reload of the same document (e.g. an anti-bot challenge) is
        // allowed; same-origin ad pages are a common trick too.
        if (initialLoadDone && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          let key = null;
          try { const x = new URL(u); key = x.origin + x.pathname; } catch { /* ignore */ }
          if (key !== mainDocKey) {
            stats.navBlocked++;
            log(`🚫 blocked redirect of main page to ${u}`);
            return req.abort('aborted');
          }
        }
        return req.continue();
      } catch {
        return undefined;
      }
    });

    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (!isHttpUrl(u)) return;
        const status = resp.status();
        if (status >= 300) return;
        const req = resp.request();
        const h = resp.headers();
        const ct = h['content-type'] || '';
        const type = classify(u, ct);
        const frameUrl = contextUrlOf(req, u, url);

        if (type === 'segment') {
          stats.segments++;
          const host = hostOf(u);
          segmentHosts.set(host, (segmentHosts.get(host) || 0) + 1);
          return;
        }

        if (type) {
          let size = null;
          const cr = h['content-range'];
          if (cr && /\/(\d+)$/.test(cr)) size = Number(cr.match(/\/(\d+)$/)[1]);
          else if (h['content-length'] && status === 200) size = Number(h['content-length']);
          const headers = sanitizeRequestHeaders(req.headers());
          if (!headers.referer && frameUrl) headers.referer = frameUrl;
          requestHeaders.set(u, headers);
          const c = store.add(u, type, 'network', { contentType: ct, size, headers, frameUrl });
          if (c && !store.map.get(u).logged) { c.logged = true; log(`📹 ${type.toUpperCase()} ${u}`); }

          if (c && (type === 'hls' || type === 'dash')) {
            const body = await resp.text().catch(() => null);
            if (body) analysePlaylist(c, body, u);
          }
          return;
        }

        // Scan API / document / script bodies for media URLs.
        const rt = req.resourceType();
        if (!['xhr', 'fetch', 'document', 'script', 'other'].includes(rt)) return;
        if (isAdUrl(u)) return;
        if (!/json|javascript|text|html|xml/i.test(ct)) return;
        const len = Number(h['content-length'] || 0);
        if (len > 3 * 1024 * 1024) return;
        const text = await resp.text().catch(() => null);
        if (!text) return;
        for (const f of scanText(text, u)) {
          const how = rt === 'xhr' || rt === 'fetch' ? (f.how === 'text' ? 'text' : f.how) : f.how;
          store.add(f.url, f.type, how, { frameUrl });
        }
      } catch { /* ignore individual response errors */ }
    });

    // ---- Navigate ---------------------------------------------------------
    log('🌐 Navigating...');
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(15000, Math.min(timeout, 45000)),
        referer: referer || undefined,
      });
    } catch (e) {
      // Ad-heavy pages often never reach "load"; keep going with what we have.
      if (/ERR_ABORTED/.test(e.message) && store.map.size) log('ℹ️ navigation aborted (direct media?)');
      else if (/timeout/i.test(e.message)) warnings.push('Page load timed out; continued with partial page.');
      else throw e;
    }
    try { const x = new URL(page.url()); mainDocKey = x.origin + x.pathname; } catch { mainDocKey = null; }
    initialLoadDone = true;

    const strongCount = () => [...store.map.values()].filter(isStrong).length;
    // Wait until the network settles OR we already have a good candidate
    // (ad-heavy pages often never go idle).
    const waitStrong = async (ms) => {
      const end = Math.min(Date.now() + ms, deadline);
      while (Date.now() < end && strongCount() === 0) await sleep(250);
      return strongCount() > 0;
    };
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 1000, timeout: 6000 }).catch(() => {}),
      waitStrong(6000),
    ]);

    const title0 = await page.title().catch(() => '');
    if (/just a moment|attention required|checking your browser|ddos-guard/i.test(title0)) {
      warnings.push('The site shows an anti-bot challenge (Cloudflare/DDoS-Guard). Try "Show browser" mode and solve it manually.');
      await sleep(Math.min(8000, Math.max(0, deadline - Date.now())));
    }

    // ---- DOM / script harvesting (all frames) ------------------------------
    const meta = { title: '', thumbnail: null, mse: false, iframes: [], videoInfo: [], embedUrl: null, popups: 0 };
    const harvestFrames = async () => {
      meta.iframes = [];
      meta.videoInfo = [];
      meta.popups = 0;
      for (const f of page.frames()) {
        if (f.isDetached()) continue;
        const fUrl = f.url();
        if (!isHttpUrl(fUrl)) continue;
        if (blockAds && isAdUrl(fUrl)) continue;
        const r = await f.evaluate(inpage.harvest).catch(() => null);
        if (!r) continue;
        if (f === page.mainFrame()) {
          meta.title = r.meta.ogTitle || r.title || meta.title;
          meta.thumbnail = r.meta.ogImage || meta.thumbnail;
          meta.embedUrl = r.meta.embedUrl || meta.embedUrl;
          meta.iframes.push(...r.iframes);
        }
        if (!meta.thumbnail && r.posters.length) meta.thumbnail = resolveUrl(r.posters[0], fUrl);
        if (!meta.title && r.meta.ogTitle) meta.title = r.meta.ogTitle;
        meta.mse = meta.mse || r.mse;
        meta.popups += r.popups || 0;
        meta.videoInfo.push(...r.videoInfo.map(v => ({ ...v, frameUrl: fUrl })));

        for (const m of r.media) {
          const abs = resolveUrl(m.url, fUrl);
          if (!abs || !isHttpUrl(abs)) continue;
          let type = classify(abs);
          if (!type && ['dom-video', 'dom-source', 'jwplayer', 'videojs'].includes(m.how)) type = 'video';
          store.add(abs, type, m.how, { frameUrl: fUrl, label: m.label });
        }
        for (const h of r.hooks) {
          const abs = resolveUrl(h, fUrl);
          if (abs && isHttpUrl(abs)) store.add(abs, classify(abs) || 'video', 'hook', { frameUrl: fUrl });
        }
        const html = await f.content().catch(() => '');
        for (const x of scanText(html, fUrl)) store.add(x.url, x.type, x.how, { frameUrl: fUrl });
      }
    };

    // ---- Interaction rounds: try to make the player start -----------------
    if (strongCount() > 0) await sleep(1500); // found without clicking; let variants arrive
    for (let round = 0; round < 6 && Date.now() < deadline && strongCount() === 0; round++) {
      log(`▶️ play attempt ${round + 1}`);
      for (const f of page.frames()) {
        if (f.isDetached()) continue;
        if (blockAds && isAdUrl(f.url())) continue;
        await f.evaluate(inpage.softPlay, round).catch(() => null);
      }
      if (round > 0) {
        // Real (trusted) click on the biggest player-like element. Any popup
        // or redirect it triggers is neutralised above.
        const t = await page.mainFrame().evaluate(inpage.clickTarget).catch(() => null);
        if (t) {
          await page.mouse.click(t.x, t.y, { delay: 40 }).catch(() => {});
          log(`🖱️ clicked ${t.tag} (${Math.round(t.w)}x${Math.round(t.h)})`);
        } else {
          await page.mouse.click(683, 384).catch(() => {});
        }
      }
      await waitStrong(round === 0 ? 2500 : 3000);
      // After the first round, also look at the DOM/scripts: many hosts put the
      // URL in a (packed) player config that never needs a click.
      if (round === 1 && strongCount() === 0) await harvestFrames();
      if (strongCount() > 0) {
        await sleep(2000); // let quality variants / more requests arrive
        break;
      }
    }

    log('🔍 Harvesting DOM from all frames...');
    await harvestFrames();
    stats.popupsBlocked += meta.popups;
    const { title, mse, iframes, videoInfo, embedUrl } = meta;
    let { thumbnail } = meta;
    if (thumbnail) thumbnail = resolveUrl(thumbnail, url);

    // ---- Cookies for replaying requests later -----------------------------
    let cookies = [];
    try {
      const cdp = await page.createCDPSession();
      ({ cookies } = await cdp.send('Network.getAllCookies'));
      await cdp.detach().catch(() => {});
    } catch {
      cookies = await page.cookies().catch(() => []);
    }

    const sessionId = createSession({ pageUrl: page.url() || url, userAgent: DEFAULT_UA, cookies, requestHeaders });

    // ---- Fetch playlists we haven't analysed (DOM-only discoveries) -------
    const pending = [...store.map.values()]
      .filter(c => (c.type === 'hls' || c.type === 'dash') && !c.playlist && !c.isAd)
      .slice(0, 5);
    await Promise.all(pending.map(async (c) => {
      try {
        const r = await httpGet(c.url, { headers: headersFor(c.url, { sid: sessionId, referer: c.frameUrl }), responseType: 'text', timeout: 10000 });
        analysePlaylist(c, r.body, r.url || c.url);
      } catch (e) { c.fetchError = e.message; }
    }));

    const candidates = finalize(store, videoInfo);

    if (!candidates.length) {
      if (mse) warnings.push('The player uses MediaSource (blob:) streaming but no manifest was captured. Try a longer timeout or "Show browser" mode.');
      if (stats.segments) warnings.push(`Saw ${stats.segments} media segments but no playlist; the manifest may be generated in JS.`);
    }
    if (candidates.some(c => c.drm)) warnings.push('At least one stream is DRM protected (Widevine/FairPlay/PlayReady). Those cannot be downloaded.');

    log(`✅ ${candidates.length} candidate(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    return {
      title: (title || '').trim() || 'Untitled video',
      thumbnail,
      pageUrl: page.url() || url,
      candidates,
      iframes: dedupeBy(iframes.filter(i => !isAdUrl(i.src)), i => i.src),
      embedUrl,
      usesMSE: mse,
      stats,
      warnings,
      sessionId,
      elapsedMs: Date.now() - started,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

function analysePlaylist(c, body, baseUrl) {
  if (c.type === 'hls') {
    if (!body.includes('#EXTM3U')) return;
    if (isMaster(body)) {
      const m = parseMaster(body, baseUrl);
      c.playlist = {
        isMaster: true,
        variants: m.variants.map(v => ({ url: v.url, label: v.label, height: v.height, bandwidth: v.bandwidth, resolution: v.resolution })),
        hasSeparateAudio: m.audio.length > 0,
        childUrls: [...m.variants.map(v => v.url), ...m.audio.map(a => a.url), ...m.subtitles.map(s => s.url)],
      };
    } else {
      const keyLine = body.match(/#EXT-X-KEY:([^\n]*)/);
      let drm = null;
      if (keyLine) {
        const method = keyLine[1].match(/METHOD=([^,\s]+)/)?.[1] || 'unknown';
        const keyFormat = keyLine[1].match(/KEYFORMAT="?([^",]+)/)?.[1];
        if (!/^(NONE|AES-128)$/i.test(method)) drm = method;
        else if (keyFormat && keyFormat !== 'identity') drm = keyFormat;
      }
      const durs = [...body.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + parseFloat(m[1]), 0);
      c.playlist = {
        isMaster: false, encrypted: !!keyLine && !/METHOD=NONE/.test(keyLine[1]), drm,
        duration: durs || null, live: !/#EXT-X-ENDLIST/.test(body),
      };
    }
  } else if (c.type === 'dash') {
    const drm = /<ContentProtection[^>]+(edef8ba9|9a04f079|94ce86fb|urn:mpeg:dash:mp4protection)/i.test(body);
    const heights = [...body.matchAll(/height="(\d+)"/g)].map(m => Number(m[1]));
    c.playlist = { isMaster: true, drm: drm ? 'Widevine/PlayReady (DASH)' : null, maxHeight: heights.length ? Math.max(...heights) : null };
  }
}

function finalize(store, videoInfo) {
  const all = [...store.map.values()];
  // Hide variant/audio playlists that belong to a master we already have.
  const children = new Set();
  for (const c of all) for (const u of c.playlist?.childUrls || []) children.add(u);

  const out = [];
  for (const c of all) {
    if (children.has(c.url)) continue;
    const score = scoreCandidate(c, videoInfo);
    out.push({
      url: c.url,
      type: c.type,
      score,
      isAd: c.isAd,
      sources: [...c.sources],
      label: [...c.labels][0] || null,
      size: c.size,
      contentType: c.contentType,
      referer: c.headers?.referer || c.frameUrl,
      frameUrl: c.frameUrl,
      variants: c.playlist?.variants || null,
      hasSeparateAudio: c.playlist?.hasSeparateAudio || false,
      encrypted: c.playlist?.encrypted || false,
      drm: c.playlist?.drm || null,
      duration: c.playlist?.duration || null,
      live: c.playlist?.live || false,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter(c => c.score > -40).slice(0, 40);
}

function dedupeBy(arr, key) {
  const s = new Set();
  return arr.filter(x => { const k = key(x); if (s.has(k)) return false; s.add(k); return true; });
}

module.exports = { extractWithBrowser, closeBrowsers, analysePlaylist };
