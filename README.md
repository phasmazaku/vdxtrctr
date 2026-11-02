# vdxtrctr

Extractor & downloader video untuk situs yang penuh iklan (popup saat klik play, redirect saat ubah volume, overlay transparan, dll).

## Cara kerja

1. **Headless Chrome (puppeteer)** membuka halaman dengan proteksi:
   - `window.open` dinetralkan, tab popup/popunder langsung ditutup.
   - Klik `<a target=_blank>` / link ke domain lain diblokir.
   - Redirect main page (`location.href = iklan`) diblokir; hanya reload URL yang sama yang diizinkan (untuk challenge Cloudflare).
   - `alert/confirm/prompt` di-dismiss, domain iklan umum diblokir (bisa dimatikan).
2. **Menekan play** secara otomatis: `video.play()` (muted), klik tombol play dari JW Player, Video.js, Plyr, dll., lalu klik mouse asli (trusted) pada player. Overlay yang menutupi video ikut dihapus.
3. **Sniffing** di semua frame (termasuk iframe embed):
   - network (m3u8 / mpd / mp4 / webm / content-type `video/*`), termasuk header request asli (Referer/Origin);
   - body XHR/fetch/JSON (termasuk JSON yang di-escape `https:\/\/`);
   - script yang di-*pack* dengan `eval(function(p,a,c,k,e,d)…)` dan URL yang di-encode base64;
   - API player (jwplayer, videojs, plyr, hls.js, dash.js, clappr), `og:video`, JSON-LD, dan hook pada `video.src`.
4. Kandidat diberi skor (ad/preroll/trailer diturunkan; master playlist, ukuran besar, dan video yang sedang diputar dinaikkan). Variant playlist dilipat ke dalam master-nya sebagai pilihan kualitas.
5. **Download** memakai ulang cookie dan Referer dari browser (penyebab utama error 403):
   - **File langsung (MP4/WebM)**: di-stream lewat proxy dengan dukungan Range/resume, atau "Save on server".
   - **HLS**: downloader native: segmen paralel, retry, **AES-128**, `EXT-X-MAP` (fMP4), `BYTERANGE`, dan segmen yang disamarkan sebagai PNG/JPG. Jika ada ffmpeg, hasilnya otomatis di-remux ke `.mp4` dan audio terpisah ikut di-merge.
   - **DASH (.mpd)**: lewat ffmpeg atau yt-dlp.
   - **yt-dlp**: fallback otomatis jika browser tidak menemukan apa pun (mendukung 1800+ situs).
   - Tombol **Commands** menghasilkan perintah `ffmpeg` / `yt-dlp` / `curl` yang sudah lengkap dengan header.
6. Stream ber-DRM (Widevine/FairPlay/PlayReady, `SAMPLE-AES`) terdeteksi dan ditandai; stream seperti ini tidak bisa diunduh.

## Menjalankan

Double-click **`start.bat`** (Windows) atau jalankan `./start.sh` (macOS/Linux). Satu script ini menginstal dependency, mem-build UI, menjalankan server di http://127.0.0.1:3001, lalu membuka browser. Opsi yang tersedia: `--tools` (unduh yt-dlp + ffmpeg), `--dev` (hot reload), dan `--no-open`.

Panduan lengkapnya ada di **[HOWTO.md](HOWTO.md)**.

### Tools opsional (sangat disarankan)

```bash
cd backend && npm run setup-tools   # unduh yt-dlp (+ ffmpeg di Windows) ke backend/bin
```

Tools juga dicari di `PATH`, di env `FFMPEG_PATH` / `YTDLP_PATH`, atau dari paket `ffmpeg-static` (`npm i ffmpeg-static`).

| Tanpa tools | Dengan ffmpeg | Dengan yt-dlp |
|---|---|---|
| MP4 langsung, HLS ke `.ts` | HLS ke `.mp4`, audio terpisah di-merge, DASH | 1800+ situs, fallback otomatis, DASH |

### Konfigurasi (`backend/.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `127.0.0.1` | `/api/download` adalah proxy generik, jadi jangan diekspos ke jaringan publik |
| `DOWNLOAD_DIR` | `backend/downloads` | lokasi hasil job |
| `MAX_CONCURRENT_EXTRACTIONS` | `2` | jumlah maksimum ekstraksi Chrome yang berjalan bersamaan |
| `FFMPEG_PATH`, `YTDLP_PATH` | | path manual ke binary |

## Tips jika gagal

- **Cloudflare / captcha**: centang *Show browser window* di Options, lalu selesaikan challenge-nya secara manual.
- **Player ada di iframe dari domain lain**: buka *Embedded players / iframes* lalu klik **Extract this**. Referer halaman asli akan ikut dikirim.
- **Situs menolak jika iklan diblokir**: matikan *Block ad networks* (popup dan redirect tetap diblokir).
- **Link expired / 403 saat download**: token biasanya terikat waktu atau IP. Lakukan extract ulang lalu segera download.

## API

| Method | Path | Body / Query |
|---|---|---|
| POST | `/api/extract` | `{ url, engine: auto\|browser\|ytdlp, timeout, blockAds, headless, referer }` |
| GET | `/api/download` | `?url&sid&referer&title&inline=1` (proxy, mendukung Range) |
| POST | `/api/jobs` | `{ kind: hls\|ffmpeg\|ytdlp\|direct\|auto, url, sid, referer, variantUrl, format, title }` |
| GET/DELETE | `/api/jobs/:id` | status / cancel |
| GET | `/api/jobs/:id/file` | unduh hasil |
| GET | `/api/commands` | `?url&sid&referer` → perintah ffmpeg / yt-dlp / curl |
| GET | `/api/health` | status server dan tools |

## Tes

```bash
cd backend && npm test    # e2e terhadap fixture lokal yang mensimulasikan situs penuh iklan
```
