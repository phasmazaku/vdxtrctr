'use strict';

/**
 * Code that runs INSIDE the page (every frame). Kept as plain functions so
 * puppeteer can serialise them. Do not reference anything outside the
 * function bodies.
 */

/** Injected before any page script runs (evaluateOnNewDocument). */
function preload() {
  try {
    if (window.__vxInstalled) return;
    Object.defineProperty(window, '__vxInstalled', { value: true });
    const rec = [];
    Object.defineProperty(window, '__vxMedia', { value: rec });
    window.__vxPopups = 0;
    window.__vxMSE = false;
    const push = (u) => { try { if (u && rec.length < 500) rec.push(String(u)); } catch (e) { /* ignore */ } };

    // 1) Neutralise popups / popunders. Return a harmless fake window so ad
    //    scripts that check the return value don't throw.
    const fakeWin = () => ({
      closed: false, close() { this.closed = true; }, focus() {}, blur() {}, postMessage() {},
      opener: null, document: { write() {}, writeln() {}, open() {}, close() {}, body: null },
      location: { href: 'about:blank', replace() {}, assign() {} },
    });
    const fakeOpen = function () { window.__vxPopups++; return fakeWin(); };
    try {
      Object.defineProperty(window, 'open', { get: () => fakeOpen, set: () => {}, configurable: false });
    } catch (e) { window.open = fakeOpen; }

    // 2) Basic automation hiding.
    try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); } catch (e) { /* ignore */ }

    // 3) Block clicks on links that would open a new tab / leave the site
    //    (classic "click anywhere -> ad tab" trick).
    window.addEventListener('click', (e) => {
      try {
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = a.href || '';
        if (!/^https?:/i.test(href)) return;
        const u = new URL(href);
        const sameOrigin = u.origin === location.origin;
        if (!sameOrigin || (a.target && a.target !== '_self')) { e.preventDefault(); window.__vxPopups++; }
      } catch (err) { /* ignore */ }
    }, true);

    // 4) Record every media src assignment (catches URLs that never hit the
    //    network as a plain request, e.g. set then replaced by MSE blob).
    const hookSrc = (proto) => {
      const d = proto && Object.getOwnPropertyDescriptor(proto, 'src');
      if (!d || !d.set) return;
      Object.defineProperty(proto, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set(v) { push(v); return d.set.call(this, v); },
      });
    };
    hookSrc(window.HTMLMediaElement && HTMLMediaElement.prototype);
    hookSrc(window.HTMLSourceElement && HTMLSourceElement.prototype);
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      try {
        if (typeof n === 'string' && /^(data-)?src$/i.test(n) &&
            (this instanceof HTMLMediaElement || this instanceof HTMLSourceElement)) push(v);
      } catch (e) { /* ignore */ }
      return sa.apply(this, arguments);
    };

    // 5) Detect MediaSource (blob:) playback.
    const oc = URL.createObjectURL;
    URL.createObjectURL = function (o) {
      try { if (window.MediaSource && o instanceof MediaSource) window.__vxMSE = true; } catch (e) { /* ignore */ }
      return oc.apply(this, arguments);
    };

    // 6) Swallow dialogs from inside the page too (also handled via CDP).
    window.alert = function () {};
    window.confirm = function () { return true; };
    window.prompt = function () { return null; };
  } catch (e) { /* never break the page */ }
}

/** Try to start playback without trusted input. Runs in every frame. */
function softPlay(round) {
  const out = { clicked: 0, played: 0, removed: 0, videos: 0 };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const sels = [
    '.jw-display-icon-container', '.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid',
    '.fp-play', '.fp-ui', '.mejs__overlay-button', '.mejs-overlay-button', '.ytp-large-play-button',
    '.dplayer-mobile-play', '.dplayer-play-icon', '.art-control-play', '.art-state', '.vds-play-button',
    '.media-play-button', '.clappr-button', '.play-wrapper', '.play-button', '.playbutton', '.btn-play',
    '.big-play-button', '#play', '#playbutton', '.play-icon', '[class*="play-btn"]', '[class*="playBtn"]',
    '[class*="PlayButton"]', 'button[aria-label="Play"]', '[aria-label="Play video"]', '[title="Play"]',
    'button[aria-label*="play" i]', '[data-plyr="play"]', '.vjs-play-control', '.jw-icon-playback',
  ];
  try {
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (!visible(el)) continue;
        try { el.click(); out.clicked++; } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }

  for (const v of document.querySelectorAll('video, audio')) {
    out.videos++;
    try {
      v.muted = true;
      v.setAttribute('playsinline', '');
      if (v.preload === 'none') v.preload = 'auto';
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); out.played++; }
    } catch (e) { /* ignore */ }
  }

  // Common player APIs.
  try { if (window.jwplayer) { const p = window.jwplayer(); p && p.setMute && p.setMute(true); p && p.play && p.play(); } } catch (e) { /* ignore */ }
  try {
    if (window.videojs && window.videojs.getPlayers) {
      Object.values(window.videojs.getPlayers()).forEach(p => { try { p.muted(true); p.play(); } catch (e) { /* ignore */ } });
    }
  } catch (e) { /* ignore */ }

  // Remove full-screen click-jacking overlays that sit on top of the video and
  // are NOT part of the player.
  if (round > 0) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) continue;
      for (let i = 0; i < 6; i++) {
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top || top === v || v.contains(top) || top.contains(v)) break;
        const playerRoot = v.closest('[class*="player" i], [id*="player" i], .jwplayer, .video-js, .plyr');
        if (playerRoot && playerRoot.contains(top)) break;
        if (top === document.body || top === document.documentElement) break;
        top.remove();
        out.removed++;
      }
    }
  }
  return out;
}

/** Collect every media hint visible from inside the frame. */
function harvest() {
  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv)(\?|#|$|&)/i;
  const r = {
    media: [], posters: [], meta: {}, iframes: [], title: document.title || '',
    mse: !!window.__vxMSE, popups: window.__vxPopups || 0, hooks: (window.__vxMedia || []).slice(0, 300),
    videoInfo: [],
  };
  const push = (url, how, label) => { if (url && typeof url === 'string') r.media.push({ url, how, label: label || null }); };

  document.querySelectorAll('video, audio').forEach(v => {
    const info = {
      src: v.currentSrc || v.src || '', duration: isFinite(v.duration) ? v.duration : null,
      width: v.videoWidth || 0, height: v.videoHeight || 0, paused: v.paused, tag: v.tagName.toLowerCase(),
    };
    r.videoInfo.push(info);
    push(v.currentSrc, 'dom-video');
    push(v.getAttribute('src'), 'dom-video');
    push(v.getAttribute('data-src'), 'dom-video');
    v.querySelectorAll('source').forEach(s => {
      push(s.getAttribute('src'), 'dom-source', s.getAttribute('label') || s.getAttribute('size') || s.getAttribute('res'));
      push(s.getAttribute('data-src'), 'dom-source');
    });
    if (v.poster) r.posters.push(v.poster);
    if ((info.src || '').startsWith('blob:')) r.mse = true;
  });

  document.querySelectorAll('iframe').forEach(f => {
    const src = f.src || f.getAttribute('data-src') || f.getAttribute('data-lazy-src');
    if (src && /^https?:/i.test(src)) {
      const b = f.getBoundingClientRect();
      r.iframes.push({ src, width: Math.round(b.width), height: Math.round(b.height) });
    }
  });

  const metaVal = (sel) => { const m = document.querySelector(sel); return m ? (m.getAttribute('content') || m.getAttribute('href')) : null; };
  r.meta.ogTitle = metaVal('meta[property="og:title"]') || metaVal('meta[name="twitter:title"]');
  r.meta.ogImage = metaVal('meta[property="og:image"]') || metaVal('meta[name="twitter:image"]');
  ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]', 'meta[itemprop="contentUrl"]', 'link[itemprop="contentUrl"]']
    .forEach(s => push(metaVal(s), 'meta'));
  const embed = metaVal('meta[itemprop="embedUrl"]') || metaVal('meta[property="og:video:iframe"]') || metaVal('meta[name="twitter:player"]');
  if (embed) r.meta.embedUrl = embed;

  // JSON-LD VideoObject
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 6) return;
        if (Array.isArray(o)) { o.forEach(x => walk(x, d + 1)); return; }
        if (o.contentUrl) push(String(o.contentUrl), 'jsonld');
        if (o.embedUrl && !r.meta.embedUrl) r.meta.embedUrl = String(o.embedUrl);
        if (o.thumbnailUrl && !r.meta.ogImage) r.meta.ogImage = String(Array.isArray(o.thumbnailUrl) ? o.thumbnailUrl[0] : o.thumbnailUrl);
        if (o['@type'] === 'VideoObject' && o.name && !r.meta.ogTitle) r.meta.ogTitle = String(o.name);
        Object.values(o).forEach(x => walk(x, d + 1));
      };
      walk(JSON.parse(s.textContent), 0);
    } catch (e) { /* ignore */ }
  });

  // JW Player (all instances)
  try {
    if (typeof window.jwplayer === 'function') {
      const ids = new Set([undefined]);
      document.querySelectorAll('.jwplayer, [id*="player"]').forEach(e => e.id && ids.add(e.id));
      ids.forEach(id => {
        try {
          const p = id === undefined ? window.jwplayer() : window.jwplayer(id);
          const pl = (p && p.getPlaylist && p.getPlaylist()) || [];
          pl.forEach(item => {
            if (item.file) push(item.file, 'jwplayer');
            (item.sources || []).forEach(s => push(s.file, 'jwplayer', s.label));
            if (item.image) r.posters.push(item.image);
            if (item.title && !r.meta.ogTitle) r.meta.ogTitle = item.title;
          });
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* ignore */ }

  // Video.js
  try {
    if (window.videojs && window.videojs.getPlayers) {
      Object.values(window.videojs.getPlayers()).forEach(p => {
        try {
          push(p.currentSrc(), 'videojs');
          (p.currentSources ? p.currentSources() : []).forEach(s => push(s.src, 'videojs', s.label));
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* ignore */ }

  // Plyr
  document.querySelectorAll('.plyr, [data-plyr-provider]').forEach(el => {
    try {
      const p = el.plyr || (el.querySelector('video') || {}).plyr;
      if (p && p.source) push(String(p.source), 'plyr');
    } catch (e) { /* ignore */ }
  });

  // Generic scan of globals: hls.js / dash.js instances, Clappr, config objects.
  try {
    const keys = Object.keys(window).slice(0, 4000);
    const seen = new WeakSet();
    const inspect = (v, how, depth) => {
      if (!v || depth > 2) return;
      if (typeof v === 'string') { if (v.length < 2000 && MEDIA_RE.test(v)) push(v, how); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (v instanceof Node || v === window) return;
      try {
        if (typeof v.loadSource === 'function' && typeof v.url === 'string') push(v.url, 'hlsjs');
        if (typeof v.getSource === 'function') { const s = v.getSource(); if (typeof s === 'string') push(s, 'dashjs'); }
        if (typeof v.getProtocol === 'function' && v.options && v.options.source) push(v.options.source, 'clappr');
      } catch (e) { /* ignore */ }
      const props = ['file', 'src', 'source', 'url', 'hls', 'dash', 'mp4', 'video_url', 'videoUrl', 'stream', 'playlist', 'sources', 'files'];
      for (const k of props) {
        let x;
        try { x = v[k]; } catch (e) { continue; }
        if (Array.isArray(x)) x.slice(0, 20).forEach(y => inspect(y, how, depth + 1));
        else inspect(x, how, depth + 1);
      }
    };
    for (const k of keys) {
      if (k.startsWith('__vx') || k.startsWith('webkit') || k.startsWith('on')) continue;
      let v;
      try { v = window[k]; } catch (e) { continue; }
      if (typeof v === 'function') continue;
      inspect(v, 'global', 0);
    }
  } catch (e) { /* ignore */ }

  return r;
}

/** Pick the best element to physically click (largest player-ish element). */
function clickTarget() {
  const cands = [];
  const add = (el, weight) => {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 70) return;
    if (r.bottom < 0 || r.top > innerHeight * 3) return;
    cands.push({ el, area: r.width * r.height * weight });
  };
  document.querySelectorAll('video').forEach(e => add(e, 3));
  document.querySelectorAll('.jwplayer, .video-js, .plyr, [class*="player" i], [id*="player" i]').forEach(e => add(e, 2));
  document.querySelectorAll('iframe').forEach(e => add(e, 1.5));
  document.querySelectorAll('canvas, [class*="poster" i], [class*="video" i]').forEach(e => add(e, 1));
  cands.sort((a, b) => b.area - a.area);
  const best = cands[0] && cands[0].el;
  if (!best) return null;
  best.scrollIntoView({ block: 'center', inline: 'center' });
  const r = best.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: best.tagName.toLowerCase() };
}

module.exports = { preload, softPlay, harvest, clickTarget };
