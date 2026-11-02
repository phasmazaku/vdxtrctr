# HOWTO: Menjalankan vdxtrctr

## Syarat

- **Node.js versi 20 atau lebih baru**, unduh dari https://nodejs.org. Cek versinya dengan `node -v`.
- Koneksi internet untuk instalasi pertama (dependency npm dan Chrome untuk puppeteer, sekitar 200–300 MB).

## Cara paling cepat (1 script)

**Windows:** double-click **`start.bat`** di folder project.

Atau dari terminal:

```bat
cd C:\projects\vdxtrctr
start.bat
```

**macOS / Linux / Git Bash:**

```bash
./start.sh
```

Script ini otomatis:

1. Menginstal dependency backend dan frontend (hanya saat pertama kali atau jika `package.json` berubah).
2. Mengunduh Chrome untuk puppeteer jika belum ada.
3. Mem-build UI (hanya jika kode frontend berubah).
4. Menjalankan server di **http://127.0.0.1:3001** dan membuka browser.

Run pertama bisa makan waktu beberapa menit. Run berikutnya hanya beberapa detik.

**Untuk berhenti:** tekan `Ctrl+C` di jendela terminal (atau tutup jendelanya).

## Opsi

| Perintah | Fungsi |
|---|---|
| `start.bat --tools` | Juga mengunduh **yt-dlp** dan **ffmpeg** ke `backend/bin` (cukup sekali). Sangat disarankan: HLS jadi `.mp4`, DASH didukung, dan 1800+ situs bisa diunduh lewat yt-dlp. |
| `start.bat --no-open` | Tidak membuka browser otomatis. |
| `start.bat --dev` | Mode development: backend ditambah React dev server di http://localhost:3000 dengan hot reload. |
| `set PORT=3005 && start.bat` | Memakai port lain jika 3001 sudah terpakai (di macOS/Linux: `PORT=3005 ./start.sh`). |

Opsi bisa digabung, misalnya `start.bat --tools --no-open`.

## Cara memakai web-nya

1. Tempel URL halaman video (halaman tempat player berada), lalu klik **Extract**.
2. Tunggu 5–40 detik. Server membuka halaman di Chrome tersembunyi, memblokir popup, redirect, dan iklan, menekan play, lalu menangkap URL videonya.
3. Pilih kandidat (yang berlabel **BEST MATCH** biasanya yang benar):
   - **MP4/WebM:** klik **Download** (langsung ke browser), **Preview**, atau **Save on server**.
   - **HLS (.m3u8):** pilih **Quality**, lalu klik **Download**. Progres tampil di panel **Downloads**. Setelah selesai, klik **Save file**.
   - **DASH / yt-dlp:** klik **Download** (butuh ffmpeg/yt-dlp, lihat `--tools`).
   - **Commands:** menyalin perintah `ffmpeg` / `yt-dlp` / `curl` yang sudah lengkap dengan header, untuk dijalankan manual.
4. Semua file hasil job juga tersimpan di **`backend/downloads/`**.

### Jika gagal

| Gejala | Solusi |
|---|---|
| "No video found" | Tambah **Timeout** di ⚙️ Options, atau buka bagian *Embedded players / iframes* lalu klik **Extract this** pada iframe player. |
| Halaman Cloudflare / captcha | Di ⚙️ Options, centang **Show browser window**. Jendela Chrome akan muncul; selesaikan challenge-nya secara manual. |
| Situs menolak jalan karena "adblock" | Di ⚙️ Options, matikan **Block ad networks**. Popup dan redirect tetap diblokir. |
| Download 403 / 502 | Link biasanya punya token yang cepat expired. Klik **Extract** lagi lalu langsung download. |
| Ada label "DRM" | Video ber-DRM (Netflix, Disney+, dll.) memang tidak bisa diunduh. |
| `Server did not start` | Port 3001 sedang dipakai program lain. Jalankan dengan `PORT` lain (lihat tabel opsi). |
| "backend offline" di UI | Server belum jalan atau sudah ditutup. Jalankan `start.bat` lagi. |

## Menjalankan manual (tanpa script)

```bash
cd backend  && npm install && npm start      # API di http://127.0.0.1:3001
cd frontend && npm install && npm start      # UI dev di http://localhost:3000
```

## Tes

```bash
cd backend && npm test
```

Penjelasan teknis lengkap (arsitektur, API, konfigurasi `.env`) ada di [README.md](README.md).
