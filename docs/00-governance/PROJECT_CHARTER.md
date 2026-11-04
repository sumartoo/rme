# Project Charter — ClinicRME SaaS

| | |
|---|---|
| Dokumen | Project Charter |
| Versi | 1.0 — Disetujui |
| Tanggal | 3 November 2026 |
| Stage | 0 — Project Charter & Feasibility |
| Disusun oleh | Sumarto (dibantu Claude) |
| Dasar | ROADMAP_PENGEMBANGAN_CLINICRME_SaaS v1.0, APP_DESIGN.md v0.2 |

---

## 1. Latar Belakang

Permenkes 24/2022 mewajibkan setiap fasilitas pelayanan kesehatan menyelenggarakan Rekam Medis Elektronik (RME) dan mengintegrasikannya dengan SATUSEHAT. Sejak 2026 Kemenkes mulai menjatuhkan sanksi administratif kepada fasilitas yang belum terintegrasi (sejauh ini terutama rumah sakit). Klinik pratama, klinik utama, dan praktik dokter mandiri memiliki kewajiban RME yang sama, tetapi umumnya tidak memerlukan — dan tidak sanggup membiayai — SIMRS rumah sakit.

ClinicRME mengisi celah tersebut: RME SaaS yang ringan, aman, terintegrasi SATUSEHAT, dan dapat disewa per klinik.

## 2. Visi

> Setiap klinik dan praktik dokter di Indonesia dapat menjalankan rekam medis elektronik yang aman, patuh, dan terintegrasi SATUSEHAT tanpa harus membangun atau mengelola sistem sendiri.

## 3. Tujuan Bisnis

| ID | Tujuan |
|---|---|
| BO-01 | Menyediakan RME rawat jalan yang memenuhi kewajiban Permenkes 24/2022 bagi klinik & praktik mandiri. |
| BO-02 | Menyediakan integrasi SATUSEHAT siap pakai sehingga klinik tidak perlu membangun bridging sendiri. |
| BO-03 | Mengurangi pekerjaan administrasi klinik: pendaftaran, antrean, resep, farmasi, kasir dalam satu alur. |
| BO-04 | Membangun pendapatan berulang melalui model langganan SaaS. |
| BO-05 | Menjaga kepercayaan pelanggan melalui keamanan & pelindungan data pribadi yang dapat dibuktikan. |

## 4. Indikator Keberhasilan (usulan — angka final ditetapkan Project Owner)

| ID | Indikator | Target usulan | Kapan diukur |
|---|---|---|---|
| KPI-01 | Klinik pilot memakai sistem untuk seluruh kunjungan rawat jalan | ≥ 1 klinik, 100% kunjungan | Akhir Stage 16 |
| KPI-02 | Kunjungan terkirim sukses ke SATUSEHAT | ≥ 99% dalam 24 jam | Pilot |
| KPI-03 | Insiden kebocoran data lintas tenant | 0 | Berkelanjutan |
| KPI-04 | Waktu dari pendaftaran sampai pasien selesai bayar tidak bertambah dibanding proses lama | ≤ baseline klinik pilot | Pilot |
| KPI-05 | Tenant berbayar | Ditetapkan PO (OD-020) | 6–12 bulan pasca rilis |
| KPI-06 | Kepuasan pengguna klinik pilot | Ditetapkan PO | UAT |

## 5. Ruang Lingkup Ringkas

Lengkapnya ada di [SCOPE.md](SCOPE.md).

**Termasuk:** RME rawat jalan, registrasi & antrean, farmasi klinik, billing & pembayaran, integrasi SATUSEHAT, integrasi aplikasi lab eksisting, aplikasi Android pasien, pelaporan, administrasi SaaS multi-tenant.

**Tidak termasuk:** SIMRS (rawat inap, IGD rumah sakit), aplikasi laboratorium mandiri, akuntansi umum.

**Diputuskan:** bridging BPJS masuk sebagai Lanjutan (DEC-006); telemedicine tidak masuk versi pertama (DEC-007).

## 6. Stakeholder

| Stakeholder | Kepentingan | Peran di proyek |
|---|---|---|
| Project Owner | Arah produk, persetujuan gate | **Sumarto** (DEC-004) |
| Tim pengembang | Membangun & memelihara | Sumarto (Senior Full Stack Engineer); anggota lain TBD |
| Clinical advisor | Keselamatan & kebenaran alur klinis | **Sumarto (sementara)**; review oleh dokter/perekam medis wajib sebelum gate Stage 9 (DEC-005) |
| Pemilik / manajer klinik | Biaya, kepatuhan, efisiensi | Pelanggan, pengambil keputusan beli |
| Dokter & tenaga kesehatan | Kecepatan dokumentasi | Pengguna utama |
| Staf pendaftaran, farmasi, kasir | Alur kerja harian | Pengguna |
| Pasien & wali | Akses & privasi data | Subjek data, pengguna aplikasi Android |
| Kemenkes / SATUSEHAT | Kepatuhan & interoperabilitas | Regulator & platform integrasi |
| Otoritas PDP / Komdigi | Pelindungan data pribadi | Regulator |
| Vendor aplikasi lab | Integrasi | Mitra integrasi |
| Payment gateway | Transaksi QRIS | Penyedia layanan |
| Google Cloud | Infrastruktur | Penyedia layanan |

## 7. Persona Pengguna (ringkas)

| Persona | Kebutuhan utama |
|---|---|
| **dr. Rina — dokter umum klinik pratama**, 40 pasien/hari | SOAP cepat, template, riwayat pasien sekilas, resep tanpa ketik ulang |
| **Budi — petugas pendaftaran** | Cari pasien cepat, cegah duplikat, antrean jelas |
| **Sari — asisten apoteker** | Worklist resep, pilih batch otomatis, stok akurat |
| **Dewi — kasir** | Tagihan otomatis, QRIS, closing shift tanpa selisih |
| **dr. Andi — dokter praktik mandiri** | Semua fungsi dalam satu layar, harga terjangkau, setup cepat |
| **Pak Hadi — pemilik klinik utama 3 cabang** | Laporan per cabang, kontrol refund/diskon, kepatuhan SATUSEHAT |
| **Ibu Lina — pasien / wali anak** | Lihat jadwal kontrol, resep, hasil lab anak |

## 8. Asumsi

1. Klinik target sudah atau akan terdaftar sebagai fasilitas di SATUSEHAT dan dapat memperoleh kredensial integrasi.
2. Klinik memiliki koneksi internet yang memadai selama jam praktik.
3. Tersedia minimal satu klinik pilot yang bersedia terlibat sejak Stage 1.
4. Aplikasi lab eksisting di klinik pilot menyediakan antarmuka integrasi (API/HL7/FHIR).
5. Seluruh data di dev/test/staging bersifat sintetis.

## 9. Batasan

1. Stack: NestJS + Next.js + PostgreSQL di Google Cloud (ADR-0001).
2. Tidak menambahkan layanan berbayar atau dependensi berbayar tanpa persetujuan Project Owner.
3. Tidak mengklaim kepatuhan HIPAA, FHIR, atau SATUSEHAT tanpa bukti validasi.
4. Data klinis dan transaksi yang telah disahkan tidak dihapus atau diubah tanpa mekanisme koreksi yang sah.

## 10. Milestone Tingkat Tinggi

| Milestone | Gate | Target tanggal |
|---|---|---|
| M0 — Charter & scope disetujui | Stage 0 | TBD |
| M1 — Requirement & MVP disetujui | Stage 1 | TBD |
| M2 — Arsitektur disetujui | Stage 2 | TBD |
| M3 — Fondasi keamanan & DevOps siap | Stage 3–4 | TBD |
| M4 — Platform SaaS (tenant, user, master) | Stage 5–7 | TBD |
| M5 — Alur klinik end-to-end | Stage 8–11 | TBD |
| M6 — SATUSEHAT, Android, laporan | Stage 12–14 | TBD |
| M7 — Pilot & rilis produksi | Stage 15–17 | TBD |

Tanggal ditetapkan setelah kapasitas tim dan klinik pilot diketahui (OD-056).

## 11. Anggaran

Belum ditetapkan. Komponen biaya yang perlu dianggarkan: infrastruktur GCP per lingkungan, domain & sertifikat, payment gateway, layanan notifikasi (SMS/WhatsApp/email), penetration test independen, publikasi Play Store, serta waktu clinical advisor. (OD-057)

## 12. Risiko Utama

Lihat [RISK_REGISTER.md](RISK_REGISTER.md). Lima teratas: kebocoran data lintas tenant, perubahan spesifikasi SATUSEHAT, scope creep ke SIMRS, ketersediaan clinical advisor, dan kapasitas tim kecil terhadap 18 stage.

## 13. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Tanda tangan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☑ Disetujui dengan catatan (lihat DEC-005) | 3 Nov 2026 | Persetujuan via chat |
| Penyusun | Sumarto | | 3 Nov 2026 | |
