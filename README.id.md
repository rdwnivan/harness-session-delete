# harness-session-delete

[![CI](https://github.com/rdwnivan/harness-session-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/rdwnivan/harness-session-delete/actions/workflows/ci.yml)

Hapus sesi DeepSeek Harness **secara permanen** dari daftar sesi di sidebar, dengan dialog konfirmasi —
tanpa membuat workspace registry, cache proyeksi, atau proses start aplikasi berada di kondisi yang
merusak *buka workspace* atau *New Session*.

> DSH hanya menyediakan **archive**, bukan delete: *"Removal never deletes data … session deletion or
> folder removal are separate, absent capabilities"* (README `@deepseek-ai/dsh-workspace`). Tidak ada API
> delete di `ctx.sessionPersistence`, `ctx.sessionController`, maupun `ctx.workspaceRegistry`, jadi
> penghapusan harus dirangkai dengan urutan yang benar. Urutan itulah isi plugin ini.

🇬🇧 [English](README.md)

## Kebutuhan

- DeepSeek Harness Desktop (dikembangkan & diverifikasi pada **0.2.0-rc.2**, Windows).
- Untuk menjalankan uji: Node 22+. Tanpa build step dan tanpa dependensi runtime.

## Pemasangan

### Lewat halaman Plugins (disarankan)

1. Buka halaman **Plugins** di sidebar.
2. Pilih install bundle, isi alamat git:

   ```
   github:rdwnivan/harness-session-delete
   ```

   (atau `https://github.com/rdwnivan/harness-session-delete`).
3. Setujui operasinya — operasi paket butuh akses penuh.
4. Baca hasilnya: `application: applied` berarti sudah aktif. Kalau tertulis `restart-required`, tutup
   dan jalankan ulang aplikasi sekali.

Paket ini tidak punya build script, jadi peringatan *blocked build scripts* dari pnpm tidak berlaku.

### Manual

1. Salin folder ini ke `<profil>/node_modules/harness-session-delete`, dengan `<profil>` =
   `<DSH_HOME>/profiles/<nama>` (untuk app Desktop: `%USERPROFILE%\.dsh\profiles\desktop`).
2. Tambahkan ini ke `<profil>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: session-delete
         name: 'harness-session-delete'
   ```

3. Restart aplikasi sekali — modul host tidak di-hot-reload dari `node_modules`.

## Pakai

1. Hover salah satu baris sesi di sidebar, buka menu **"…"** (klik kanan juga bisa).
2. Pilih **Delete session** (warna merah, di bawah *Archive session*), lalu konfirmasi.
3. Barisnya hilang: transkrip, baris cache proyeksi, dan pembukuan workspace ikut bersih.

## Yang ditolak, dan alasannya

| Respons | Arti |
|---|---|
| `409 session/running` | turn sesi itu, subagent, job, atau reminder masih berjalan — hentikan dulu |
| `409 session/has-children` | ada sesi **fork** yang berasal dari sesi ini; body memuat id anak yang harus dihapus dulu |
| `409 session/children-unreadable` | daftar sesi tersimpan tidak bisa dibaca, jadi pemeriksaan lineage tidak bisa dipercaya; tidak ada yang dihapus |
| `409 session/in-use` | transkrip masih dipegang proses yang berjalan (Windows); pindah sesi lalu ulangi |
| `404 session/not-found` | sudah tidak ada; halaman menutupnya tanpa notifikasi dan menyegarkan daftarnya |
| `400 invalid-session-id` | bukan id sesi — tidak ada path filesystem yang diturunkan dari input pemanggil |

## Urutan penghapusan (kenapa aman)

1. **Admisi** — `ctx.workspaceRegistry.archiveSession(id)`, gerbang resmi *"apa yang masih berjalan?"*,
   jadi tidak ada berkas yang dihapus di bawah pekerjaan yang berjalan.
2. **Byte dulu** — hapus `<DSH_HOME>/sessions/<project>/<id>/`. Kalau gagal (transkrip terkunci), tulisan
   archive di-rollback dan **tidak ada** state lain yang berubah.
3. **Pembukuan** — `workspace.detachSession(id)`, lalu bersihkan himpunan archive dan pin. Selalu lewat
   domain store: `workspace.json` **tidak pernah** diedit manual, karena satu byte saja yang tidak valid
   menggagalkan `storageDomain.open` dan GUI tidak bisa membuka workspace sama sekali.
4. **Cache dan notifikasi** — buang baris cache proyeksi dan beri tahu setiap halaman yang terbuka
   (`api-session/removed`).

## Berkas

| Berkas | Peran |
|---|---|
| `index.js` | Half host: dua route fetch terautentikasi (hapus + receipt browser), urutan penghapusan, pengaman fork, log audit |
| `client.js` | Half browser: baris menu sidebar dan konfirmasinya, lalu refresh daftar di klien supaya barisnya hilang |
| `cordis.patch.yml` | Patch bundle — satu baris host; half browser ditemukan dari `dsh.client` |
| `test/*.mjs` | Suite offline, verifier live, dan self-test verifier |

## Verifikasi

```bash
npm run check                          # sintaks semua berkas
npm test                               # penolakan/rollback/jalur sukses host + kontrak half browser
node test/verify-live.selftest.mjs     # verifier-nya sendiri, di home DSH sintetis
node test/verify-live.mjs --store      # kesehatan store instalasimu
node test/verify-live.mjs <session-id> # kondisi pasca-hapus satu sesi
```

Tidak ada yang di `test/` memerlukan Harness: suite host menjalankan handler route yang sebenarnya
terhadap `DSH_HOME` sementara, dan suite browser mematerialisasi `client.js` persis seperti module loader
web (`window.__ModuleLoader__.load` → `factory(require)`), lalu mengaktifkannya di konteks klien tiruan.

Plugin juga meninggalkan jejak audit di `<DSH_HOME>/session-delete/`:

- `status.json` — receipt aktivasi (waktu, versi, route).
- `deletions.jsonl` — satu baris per permintaan, termasuk yang ditolak.
- `client.jsonl` — receipt dari half browser (`apply`, `menu-row-render`).
- `client-graph.json` — apakah paket ini sudah masuk boot graph halaman.

## Batasan yang diketahui

- Perubahan sisi host butuh restart app: HMR profil memantau konfigurasi dan mengabaikan `**/node_modules`.
- Konfirmasi memakai `window.confirm` bawaan browser. Fokus dan Escape ditangani browser; dialog bertema
  host (lewat slot `shell.overlay`) belum diimplementasikan.
- Anak subagent tidak memblokir penghapusan — mereka tersembunyi dari sidebar, jadi memblokirnya akan
  membuat sesi induk tidak pernah bisa dihapus. Mereka dilaporkan di respons dan dibiarkan di disk.
- Menghapus tidak bisa dibatalkan: tidak ada trash, tidak ada undo.

## Copot

Hapus blok `insert` dari `<profil>/cordis.patch.yml` (atau matikan bundle-nya di halaman Plugins) lalu
hapus folder paketnya. Sesi yang sudah dihapus tetap terhapus.

## Terkait

- [`dsh-plugin-session-delete`](https://github.com/Amano-Natsuki/dsh-session-delete) — plugin independen
  dengan tujuan sama. Ia **menghentikan** pekerjaan yang berjalan alih-alih menolak, memblokir sesi yang
  punya anak fork, dan tidak menyertakan jejak audit maupun alat verifikasi offline.

## Lisensi

MIT
