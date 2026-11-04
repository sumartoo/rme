# Privacy & Pelindungan Data Pribadi — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — DRAFT (Stage 3) |
| Tanggal | 4 November 2026 |
| Dasar | UU 27/2022 (UU PDP), PP 33/2026, Permenkes 24/2022, PP 28/2024 |
| Requirement | NFR-PRV-001..003, REG-FR-008, AUD-FR-005, PLT-FR-008 |

> **Bukan nasihat hukum.** Dokumen ini adalah rancangan teknis-operasional berdasarkan penelusuran sumber publik per November 2026. Teks perjanjian (DPA), pemberitahuan privasi, dan penetapan peran wajib direview konsultan hukum sebelum produksi (OD-060).

## 1. Ketentuan Kunci yang Berdampak ke Produk

| Ketentuan | Isi ringkas | Implikasi bagi ClinicRME |
|---|---|---|
| Data spesifik (UU PDP Pasal 4) | Data dan informasi kesehatan termasuk data pribadi yang bersifat spesifik | Seluruh rekam medis butuh perlindungan lebih tinggi; DPIA |
| Hak subjek data — akses, koreksi, penghentian/pembatasan (UU PDP Pasal 30–32 dst.) | Pengendali menindaklanjuti dalam 3×24 jam | Fitur bagi klinik untuk mengekspor data pasien, mencatat koreksi (addendum), dan membatasi pemrosesan |
| Penilaian dampak (UU PDP Pasal 34; PP 33/2026 Pasal 120–122) | Wajib untuk pemrosesan berisiko tinggi, termasuk data spesifik dan skala besar | DPIA platform oleh ClinicRME + template DPIA untuk klinik |
| Kegagalan pelindungan (UU PDP Pasal 46; PP 33/2026 Pasal 114) | Pemberitahuan tertulis ke subjek data dan Lembaga paling lambat 3×24 jam; prosesor melapor ke pengendali pada kesempatan pertama; tenggat berjalan sejak kegagalan dipastikan | [INCIDENT_RESPONSE_PLAN.md](INCIDENT_RESPONSE_PLAN.md) |
| Pejabat PDP / PPDP (UU PDP Pasal 53; PP 33/2026 Pasal 142–147) | Kriteria penunjukan bersifat alternatif setelah putusan MK; mencakup pemrosesan data spesifik skala besar | ClinicRME menunjuk PPDP; klinik dinilai per kasus |
| Perjanjian pengendali–prosesor (PP 33/2026 Pasal 13–16) | Perjanjian paling sedikit memuat cakupan & cara pemrosesan, jenis & tujuan, kategori subjek, jangka waktu, hak & kewajiban, mekanisme pengawasan & audit; tanggung jawab tetap pada pengendali | DPA wajib di kontrak langganan (§4) |
| Transfer ke luar negeri (PP 33/2026 Pasal 160–174) | Persyaratan transfer lintas negara | Data disimpan di region Jakarta; sub-prosesor luar negeri didaftar & dinilai (§5) |
| Sanksi | Denda administratif hingga 2% pendapatan tahunan (UU PDP Pasal 57; PP 33/2026 Pasal 185) | Prioritas kepatuhan tinggi |
| Berlaku | UU PDP berlaku penuh sejak Oktober 2024; PP 33/2026 berlaku 16 Januari 2027 | Seluruh kontrol PDP siap sebelum pilot produksi |
| Rahasia kedokteran & rekam medis (PP 28/2024; Permenkes 24/2022) | Kerahasiaan rekam medis, kewajiban penyimpanan | Akses berbasis peran, audit baca, retensi ≥ 25 tahun |

## 2. Peran Para Pihak

| Pemrosesan | Pengendali | Prosesor | Catatan |
|---|---|---|---|
| Rekam medis & data pasien di tenant | **Klinik (tenant)** | **ClinicRME** | ClinicRME memproses hanya atas instruksi klinik |
| Data staf klinik (akun, login, audit) | Klinik | ClinicRME | |
| Data langganan & tagihan SaaS (kontak admin klinik) | **ClinicRME** | — | |
| Akun aplikasi pasien (Lanjutan) | Ditetapkan Stage 13 — kemungkinan pengendali bersama | | OD-067 |
| Pengiriman ke SATUSEHAT | Klinik (kewajiban fasyankes) | ClinicRME sebagai sistem elektronik | Dasar: kewajiban hukum fasyankes |

## 3. Dasar Pemrosesan (usulan, untuk direview hukum)

| Data | Tujuan | Dasar |
|---|---|---|
| Rekam medis | Pelayanan kesehatan, kewajiban penyelenggaraan RME | Kewajiban hukum klinik; kepentingan vital dalam kondisi darurat |
| Identitas & kontak pasien | Registrasi, identifikasi, pengingat | Pelaksanaan perjanjian pelayanan; kewajiban hukum |
| Pengiriman SATUSEHAT | Kewajiban integrasi | Kewajiban hukum |
| Data penjamin | Penagihan | Pelaksanaan perjanjian |
| Pengingat WhatsApp/SMS (Lanjutan) | Pengingat jadwal | Persetujuan pasien |
| Analitik agregat lintas tenant oleh ClinicRME | Peningkatan produk | **Tidak dilakukan** kecuali anonim dan disetujui dalam kontrak |

Consent umum dicatat berversi di `patient_consent` (REG-FR-008); teks consent dikelola klinik melalui `consent_document`.

## 4. Kerangka Perjanjian Pemrosesan Data (DPA) — Outline

Mengikuti isi minimum PP 33/2026 Pasal 13–16:

1. **Para pihak & peran** — klinik sebagai pengendali, ClinicRME sebagai prosesor.
2. **Cakupan & cara pemrosesan** — fungsi RME, farmasi, billing, integrasi SATUSEHAT, lab, pembayaran.
3. **Jenis data & tujuan** — sesuai §3; larangan pemrosesan untuk tujuan lain.
4. **Kategori subjek data** — pasien, wali, staf klinik.
5. **Jangka waktu** — selama langganan + masa serah terima; kewajiban retensi rekam medis (§6 dan [DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md)).
6. **Kewajiban prosesor** — memproses atas instruksi tertulis; kerahasiaan personel; langkah keamanan sesuai [SECURITY_CONTROLS.md](SECURITY_CONTROLS.md); membantu pemenuhan hak subjek data; melapor kegagalan pelindungan pada kesempatan pertama (target ≤ 24 jam sejak terkonfirmasi); membantu DPIA; mengembalikan/menyerahkan data saat berakhir.
7. **Sub-prosesor** — daftar (§5), pemberitahuan perubahan, kewajiban setara.
8. **Pengawasan & audit** — laporan keamanan berkala, hak audit klinik dengan pemberitahuan wajar, laporan uji penetrasi ringkas.
9. **Lokasi data** — Indonesia (region Jakarta); transfer lintas negara hanya sesuai PP 33/2026.
10. **Akhir layanan** — ekspor lengkap (PLT-FR-008), serah terima, penanganan data yang masih dalam masa retensi wajib.
11. **Tanggung jawab & ganti rugi** — direview hukum.

## 5. Sub-Prosesor (awal)

| Sub-prosesor | Layanan | Data | Lokasi |
|---|---|---|---|
| Google Cloud | Hosting, DB, storage, logging | Seluruh data | asia-southeast2 (Jakarta) — dikonfirmasi per layanan di Stage 15 |
| Google (Sign-In) | Autentikasi staf | Email, nama, `sub` | Global — hanya data akun |
| Payment gateway (OD-039) | QRIS | Nominal, referensi transaksi (tanpa data medis) | Indonesia |
| Penyedia email/WA/SMS (OD-012) | Notifikasi | Email/telepon, isi tanpa data medis | Ditetapkan saat pemilihan |
| Kemenkes SATUSEHAT | Integrasi wajib | Data klinis sesuai ketentuan | Indonesia — bukan sub-prosesor, melainkan penerima berdasarkan kewajiban hukum |

## 6. Hak Subjek Data — Dukungan Produk

| Hak | Cara klinik memenuhinya di ClinicRME | Status |
|---|---|---|
| Informasi pemrosesan | Template pemberitahuan privasi klinik (Stage 16) | 📅 |
| Akses & salinan | Ekspor rekam pasien (PDF/FHIR Bundle) oleh petugas berwenang | 📅 Stage 9 |
| Koreksi | Data identitas: update teraudit; data klinis: addendum (ADR-0006) | ✅ desain |
| Penghentian / pembatasan pemrosesan | Flag pembatasan pada pasien (menghentikan notifikasi & sinkronisasi non-wajib) | 📅 Stage 8 (OD-068) |
| Penghapusan | Tunduk pada kewajiban retensi rekam medis (≥ 25 tahun); data non-wajib (kontak opsional, preferensi notifikasi) dapat dihapus | 📅 |
| Daftar akses ke RM | Laporan audit akses per pasien (AUD-FR-005) | 📅 Lanjutan |
| Penarikan persetujuan | Untuk pemrosesan berbasis persetujuan (pengingat, portal) | 📅 |

## 7. DPIA

ClinicRME menyusun **DPIA platform** sebelum pilot produksi (target: sebelum 16 Januari 2027) dan menyediakan **template DPIA** untuk klinik. Isi minimum: deskripsi pemrosesan, kebutuhan & proporsionalitas, risiko terhadap subjek data (diambil dari [THREAT_MODEL.md](THREAT_MODEL.md)), langkah mitigasi, risiko sisa. Lokasi: `docs/03-security/DPIA_PLATFORM.md` (Stage 15/16).

## 8. Privacy by Design dalam Produk

| Prinsip | Penerapan |
|---|---|
| Minimisasi | Hanya field yang dibutuhkan requirement; NIK ditampilkan ter-mask |
| Pembatasan tujuan | Tidak ada analitik lintas tenant; notifikasi tanpa isi medis |
| Akurasi | Deteksi duplikat, merge teraudit, addendum |
| Pembatasan penyimpanan | [DATA_RETENTION_POLICY.md](DATA_RETENTION_POLICY.md) |
| Integritas & kerahasiaan | RLS, enkripsi, audit hash chain |
| Akuntabilitas | Audit log, DPIA, DPA, laporan keamanan |

## 9. Open Decision

| ID | Pertanyaan |
|---|---|
| OD-060 | Teks DPA final & review hukum |
| OD-067 | Peran para pihak untuk aplikasi pasien |
| OD-068 | Perilaku sistem saat pasien meminta pembatasan pemrosesan (apa yang tetap wajib, mis. SATUSEHAT) |
| OD-069 | Penunjukan PPDP ClinicRME (internal / eksternal) |

## 10. Sumber

- UU 27/2022 — peraturan.bpk.go.id; ringkasan Pasal 4, 30–34, 46, 53 dari Hukumonline, Pasal.id
- PP 33/2026 — RSM Indonesia Client Alert (18 Sep 2026); Veritask (3 Sep 2026); SIP Law Firm; Justisio
