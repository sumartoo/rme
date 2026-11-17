# Stage 14 — Uji Performa Laporan (OD-130)

| | |
|---|---|
| Tanggal | 18 Nov 2026 |
| Target | Setiap laporan ≤ **3 detik** pada volume **3 tahun × 300 kunjungan/hari** per tenant (OD-130 / DEC-047) |
| Skrip | `libs/db/perf/report-perf.ts` — `PERF_ADMIN_URL=postgres://… npx tsx libs/db/perf/report-perf.ts` (membuat ulang database `crme_perf`; data sintetis) |
| Mesin | Container uji lokal: 2 vCPU, 7 GB RAM, PostgreSQL 16.15 (konfigurasi bawaan), tanpa read replica |
| Cara ukur | Fungsi hitung yang sama dengan endpoint (`@clinicrme/db/reports`), dalam transaksi sebagai `clinicrme_app` dengan konteks tenant (**RLS aktif**) dan `statement_timeout` 30 detik. 3 percobaan per laporan; yang dinilai percobaan terlama. Tidak termasuk overhead HTTP/JSON (puluhan milidetik) |

## 1. Volume

| Data | Jumlah |
|---|---|
| Kunjungan (2 cabang, zona waktu berbeda; 3% batal) | 328.502 |
| Pasien | 54.750 |
| RM disahkan / diagnosis | 280.926 / 405.811 |
| Tagihan / baris tagihan / pembayaran | 312.175 / 624.350 / 312.175 |
| Piutang penjamin / pelunasan | 62.157 / 58.827 |
| Obat / batch / mutasi stok | 300 / 3.000 (×2 lokasi) / 606.000 |

## 2. Hasil (setelah perbaikan di §3)

| Laporan | Percobaan 1 / 2 / 3 (ms) | Terlama | ≤ 3 detik |
|---|---|---|---|
| Kunjungan — 1 bulan, harian | 203 / 184 / 135 | 203 | ✅ |
| Kunjungan — 366 hari, bulanan per dokter | 2552 / 2696 / 2568 | 2696 | ✅ |
| Kunjungan — 366 hari, per cabang (cakupan 1 cabang) | 802 / 874 / 707 | 874 | ✅ |
| 10 besar diagnosis — 1 bulan | 181 / 159 / 159 | 181 | ✅ |
| 10 besar diagnosis — 366 hari, semua diagnosis | 2562 / 2784 / 2632 | 2784 | ✅ |
| Pendapatan tagihan — 366 hari per kategori | 783 / 831 / 772 | 831 | ✅ |
| Pendapatan tagihan — 366 hari per hari | 902 / 904 / 785 | 904 | ✅ |
| Penerimaan kas — 366 hari per metode | 1343 / 1024 / 1138 | 1343 | ✅ |
| Closing kasir — 366 hari | 104 / 67 / 83 | 104 | ✅ |
| Umur piutang — hari ini | 1150 / 886 / 1096 | 1150 | ✅ |
| Stok — 366 hari | 660 / 505 / 508 | 660 | ✅ |
| Mutasi stok — 1 bulan (maks. 5.000 baris) | 40 / 43 / 47 | 47 | ✅ |
| Obat golongan terbatas — bulan ini | 17 / 13 / 12 | 17 | ✅ |
| Mendekati kedaluwarsa | 19 / 14 / 14 | 19 | ✅ |
| Dashboard manajer hari ini | 213 / 164 / 175 | 213 | ✅ |

**Kesimpulan: target tercapai** untuk semua laporan. Rentang 1 bulan (pemakaian harian) di bawah 0,25 detik.

## 3. Masalah yang ditemukan & diperbaiki

| Temuan | Sebelum | Perbaikan | Sesudah |
|---|---|---|---|
| Laporan kunjungan: penanda "pasien baru" memakai `exists` berkorelasi ke CTE (kuadratik) | 12,4 detik pada **6.000** kunjungan | `left join` ke daftar kunjungan pertama per pasien (hash join) | 0,04 detik pada 6.000; 0,2 detik (1 bulan) pada 328 ribu |
| Filter waktu kunjungan `coalesce(arrived_at, created_at)` tidak dapat dipakai sebagai kondisi indeks di bawah RLS → seluruh kunjungan tenant dipindai | 0,5 detik (1 bulan), 0,25 detik dashboard | Ditulis per kolom (`arrived_at` atau `created_at` bila belum datang) + indeks `ix_encounter_arrived`, `ix_encounter_created_noarrival` (migrasi 0039) | 0,14–0,2 detik |
| Dashboard: CTE tren dieksekusi ulang per hari (PostgreSQL meng-inline CTE yang dipakai sekali di subquery berkorelasi) | 4,7 detik | `MATERIALIZED` | 0,2 detik |

## 4. Risiko & langkah bila lambat di produksi

- Laporan **366 hari** kunjungan per dokter dan 10 besar diagnosis semua diagnosis berada di **2,7–2,8 detik** — dalam target tetapi dengan
  margin tipis di mesin 2 vCPU. Penggunaan normal (bulan berjalan) jauh di bawahnya.
- Bila di mesin produksi melewati 3 detik: (1) agregasi harian per cabang (tabel ringkasan diperbarui worker) untuk kunjungan & diagnosis;
  (2) read replica (OD-047) di Stage 15. Ukur ulang dengan skrip yang sama di VPS/Cloud SQL target saat Stage 15.
- Batas 30 detik (`statement_timeout`) tetap berlaku sebagai pengaman; ekspor besar berjalan di worker.
