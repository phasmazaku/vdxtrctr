'use strict';

/**
 * Minimal, dependency-free HLS support:
 *  - parse master / media playlists
 *  - download every segment (concurrently, in order), with retries
 *  - AES-128 decryption, EXT-X-MAP init segments, EXT-X-BYTERANGE
 *  - strips fake image headers that some hosts prepend to TS segments
 */
const crypto = require('crypto');
const fs = require('fs');
const { httpGet } = require('./http');
const { sleep } = require('./util');

function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function isMaster(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const variants = [];
  const audio = [];
  const subtitles = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j < lines.length) {
        const url = new URL(lines[j], baseUrl).href;
        const bw = parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10) || 0;
        const res = a.RESOLUTION || '';
        const height = parseInt((res.split('x')[1] || '0'), 10) || 0;
        variants.push({
          url, bandwidth: bw, resolution: res, height, codecs: a.CODECS || '',
          audioGroup: a.AUDIO || null,
          label: [height ? `${height}p` : null, bw ? `${Math.round(bw / 1000)} kbps` : null].filter(Boolean).join(' · ') || 'variant',
        });
        i = j;
      }
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(l.slice(13));
      if (!a.URI) continue;
      const entry = {
        type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE,
        isDefault: a.DEFAULT === 'YES', url: new URL(a.URI, baseUrl).href,
      };
      if (a.TYPE === 'AUDIO') audio.push(entry);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(entry);
    }
  }
  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return { variants, audio, subtitles };
}

function parseByteRange(v, prevEnd) {
  const [len, off] = v.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { offset, length };
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  let duration = 0;
  let pendingDur = 0;
  let pendingRange = null;
  let lastRangeEnd = 0;
  let endList = false;
  let drm = null;

  for (const l of lines) {
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') key = null;
      else if (method === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity')) {
        key = { method, uri: new URL(a.URI, baseUrl).href, iv: a.IV || null };
      } else {
        drm = `${method}${a.KEYFORMAT ? ' / ' + a.KEYFORMAT : ''}`;
        key = { method, unsupported: true };
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = { url: new URL(a.URI, baseUrl).href, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null, key };
    } else if (l.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(l.slice(17), lastRangeEnd);
    } else if (l.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (!l.startsWith('#')) {
      const s = {
        url: new URL(l, baseUrl).href, seq: seq + segments.length, duration: pendingDur,
        key, map, range: pendingRange,
      };
      if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
      segments.push(s);
      duration += pendingDur;
      pendingDur = 0;
      pendingRange = null;
    }
  }
  return { segments, duration, endList, drm, isFmp4: segments.some(s => s.map) };
}

function ivFromSeq(seq) {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(Math.floor(seq / 2 ** 32) >>> 0, 8);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

function hexIv(iv) {
  const h = iv.replace(/^0x/i, '').padStart(32, '0');
  return Buffer.from(h, 'hex');
}

function decryptAes128(data, keyBuf, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

/** Some hosts disguise TS segments as PNG/JPEG/GIF by prepending a fake header. */
function stripFakeHeader(buf) {
  if (buf.length < 600 || buf[0] === 0x47) return buf;
  const limit = Math.min(buf.length - 377, 16384);
  for (let o = 1; o < limit; o++) {
    if (buf[o] === 0x47 && buf[o + 188] === 0x47 && buf[o + 376] === 0x47) return buf.subarray(o);
  }
  return buf;
}

async function fetchPlaylist(url, headers, signal) {
  const r = await httpGet(url, { headers, signal, responseType: 'text' });
  return { text: r.body, finalUrl: r.url || url };
}

async function fetchBytes(url, headers, range, signal, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const h = { ...headers };
      if (range) h.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const r = await httpGet(url, { headers: h, signal, responseType: 'buffer', timeout: 60000 });
      return r.body;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw new Error('cancelled');
      await sleep(500 * (attempt + 1) ** 2);
    }
  }
  throw lastErr;
}

/**
 * Resolve a (possibly master) playlist URL to { mediaUrl, media, master, variant, audio }.
 * `prefer` may be a variant URL or a target height.
 */
async function resolvePlaylist(url, headers, { prefer, signal } = {}) {
  const first = await fetchPlaylist(url, headers, signal);
  if (!first.text.includes('#EXTM3U')) throw new Error('Not an HLS playlist (missing #EXTM3U)');
  if (!isMaster(first.text)) {
    return { mediaUrl: first.finalUrl, media: parseMedia(first.text, first.finalUrl), master: null };
  }
  const master = parseMaster(first.text, first.finalUrl);
  if (!master.variants.length) throw new Error('Master playlist has no variants');
  let variant = master.variants[0];
  if (prefer) {
    variant = master.variants.find(v => v.url === prefer) ||
      master.variants.find(v => v.height && v.height <= Number(prefer)) || variant;
  }
  const mp = await fetchPlaylist(variant.url, headers, signal);
  const media = parseMedia(mp.text, mp.finalUrl);
  let audio = null;
  if (variant.audioGroup) {
    const group = master.audio.filter(a => a.groupId === variant.audioGroup);
    const pick = group.find(a => a.isDefault) || group[0];
    if (pick) {
      const ap = await fetchPlaylist(pick.url, headers, signal);
      audio = { ...pick, media: parseMedia(ap.text, ap.finalUrl) };
    }
  }
  return { mediaUrl: mp.finalUrl, media, master, variant, audio };
}

/**
 * Download every segment of a parsed media playlist into `outPath`.
 * onProgress({done, total, bytes})
 */
async function downloadMedia(media, outPath, headers, { signal: outerSignal, onProgress, concurrency = 6 } = {}) {
  if (media.drm) throw new Error(`Stream is DRM protected (${media.drm}); cannot be downloaded.`);
  const segs = media.segments;
  if (!segs.length) throw new Error('Playlist has no segments');

  // Internal controller so one failing segment stops the other workers.
  const ac = new AbortController();
  const signal = ac.signal;
  const onOuterAbort = () => ac.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ac.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const keyCache = new Map();
  const getKey = (uri) => {
    if (!keyCache.has(uri)) keyCache.set(uri, fetchBytes(uri, headers, null, signal));
    return keyCache.get(uri);
  };
  const mapCache = new Map();

  const out = fs.createWriteStream(outPath);
  let writeErr = null;
  out.on('error', (e) => { writeErr = e; ac.abort(); });
  const write = (buf) => new Promise((res, rej) => {
    if (writeErr) return rej(writeErr);
    if (out.write(buf)) res(); else out.once('drain', res);
  });

  const ahead = concurrency * 4;
  let done = 0;
  let bytes = 0;
  let lastMap = null;
  const results = new Array(segs.length);
  let next = 0;
  let writeIdx = 0;
  let wake = [];
  const wakeAll = () => { const w = wake; wake = []; w.forEach(r => r()); };
  signal.addEventListener('abort', wakeAll, { once: true });

  const processSeg = async (i) => {
    const s = segs[i];
    let data = await fetchBytes(s.url, headers, s.range, signal);
    if (s.key && s.key.method === 'AES-128') {
      const k = await getKey(s.key.uri);
      const iv = s.key.iv ? hexIv(s.key.iv) : ivFromSeq(s.seq);
      data = decryptAes128(data, k.subarray(0, 16), iv);
    }
    if (!media.isFmp4) data = stripFakeHeader(data);
    return data;
  };

  const writeReady = async () => {
    while (writeIdx < segs.length && results[writeIdx]) {
      const s = segs[writeIdx];
      if (s.map) {
        const mk = s.map.url + JSON.stringify(s.map.range);
        if (mk !== lastMap) {
          if (!mapCache.has(mk)) {
            let init = await fetchBytes(s.map.url, headers, s.map.range, signal);
            if (s.map.key && s.map.key.method === 'AES-128' && s.map.key.iv) {
              const k = await getKey(s.map.key.uri);
              init = decryptAes128(init, k.subarray(0, 16), hexIv(s.map.key.iv));
            }
            mapCache.set(mk, init);
          }
          await write(mapCache.get(mk));
          lastMap = mk;
        }
      }
      const buf = results[writeIdx];
      results[writeIdx] = null;
      await write(buf);
      bytes += buf.length;
      done++;
      writeIdx++;
      wakeAll();
      onProgress && onProgress({ done, total: segs.length, bytes });
    }
  };
  // Serialise writes through a promise chain.
  let chain = Promise.resolve();
  const flush = () => (chain = chain.then(writeReady));

  const worker = async () => {
    while (next < segs.length) {
      if (signal.aborted) throw new Error('cancelled');
      const i = next++;
      while (i - writeIdx > ahead && !signal.aborted) await new Promise(r => wake.push(r));
      if (signal.aborted) throw new Error('cancelled');
      results[i] = await processSeg(i);
      await flush();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, segs.length) }, () =>
      worker().catch((e) => { ac.abort(); throw e; })));
    await flush();
    if (writeErr) throw writeErr;
  } catch (e) {
    if (outerSignal?.aborted) throw new Error('cancelled');
    throw e;
  } finally {
    outerSignal?.removeEventListener('abort', onOuterAbort);
    await new Promise(r => out.end(r));
  }
  if (done !== segs.length) throw new Error(`Only ${done}/${segs.length} segments written`);
  return { bytes, segments: done };
}

module.exports = {
  parseAttrs, isMaster, parseMaster, parseMedia, resolvePlaylist, downloadMedia,
  stripFakeHeader, decryptAes128, ivFromSeq,
};
