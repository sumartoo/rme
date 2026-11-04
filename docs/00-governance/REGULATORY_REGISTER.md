# Regulatory Register — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 |
| Tanggal | 3 November 2026 |
| Stage | 0 |

> **Status verifikasi.** Daftar ini disusun dari penelusuran sumber publik per 3 November 2026. Kolom "Status" menunjukkan sejauh mana sudah dicek. Sebelum suatu ketentuan dijadikan requirement di Stage 1, teks resminya harus dibaca dari JDIH/peraturan.bpk.go.id dan pasal yang dirujuk dicatat. Dokumen ini bukan nasihat hukum; untuk keputusan kepatuhan, konsultasikan dengan konsultan hukum kesehatan / pelindungan data.

---

## 1. Regulasi Indonesia

| ID | Regulasi | Relevansi untuk ClinicRME | Status |
|---|---|---|---|
| REG-01 | **UU No. 17 Tahun 2023 tentang Kesehatan** | Payung hukum kesehatan; menggantikan antara lain UU Kesehatan 2009 dan UU Praktik Kedokteran 2004 | Berlaku — dikonfirmasi dari sumber sekunder; baca teks resmi |
| REG-02 | **PP No. 28 Tahun 2024** (Peraturan Pelaksanaan UU 17/2023) | Ketentuan fasilitas pelayanan kesehatan, **rekam medis**, rahasia kesehatan pasien, kefarmasian, SDM kesehatan (SIP); menggantikan PP 47/2016 tentang Fasyankes | Berlaku (peraturan.bpk.go.id); pasal rekam medis & rahasia pasien perlu dibaca |
| REG-03 | **Permenkes No. 24 Tahun 2022 tentang Rekam Medis** | Kewajiban RME bagi setiap fasyankes; integrasi SATUSEHAT; retensi RME **paling singkat 25 tahun sejak kunjungan terakhir**; mencabut Permenkes 269/2008 | Berlaku menurut sumber sekunder; **nomor pasal retensi berbeda antar sumber (Pasal 28 vs 39)** — verifikasi teks resmi |
| REG-04 | **UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi** | Data kesehatan = data pribadi spesifik; dasar pemrosesan, hak subjek data, kewajiban pengendali/prosesor, notifikasi kegagalan, PPDP/DPO | Berlaku |
| REG-05 | **PP No. 33 Tahun 2026** (Peraturan Pelaksanaan UU PDP) | Rincian teknis: notifikasi kegagalan, DPIA, PPDP, transfer lintas negara, sanksi administratif. Ditetapkan 16 Juli 2026, **berlaku 16 Januari 2027** | Terbit — dikonfirmasi beberapa sumber; baca teks resmi |
| REG-06 | Lembaga Pelindungan Data Pribadi | Penerima notifikasi kegagalan & pengawas; per September 2026 belum sepenuhnya terbentuk, fungsi dijalankan Komdigi | Pantau |
| REG-07 | Ketentuan & panduan teknis **SATUSEHAT** (Kemenkes) | Daftar resource wajib, profil FHIR, alur registrasi fasyankes & penyelenggara sistem elektronik | Rujuk portal developer SATUSEHAT saat Stage 12 |
| REG-08 | Surat Edaran Bersama 30 Juli 2026 — RME terintegrasi SATUSEHAT dalam pengelolaan klaim JKN | Klaim JKN berbasis RME terintegrasi SATUSEHAT (transisi mulai Agustus 2026, tahap penuh disebut Juni 2027) — terutama FKRTL/RS | Relevan untuk OD-001; verifikasi apakah berlaku untuk FKTP |
| REG-09 | Permenkes tentang Klinik & standar perizinan | Klasifikasi klinik pratama/utama. Sumber sekunder menyebut Permenkes 9/2014 banyak bertentangan dengan PP 28/2024 dan standar usaha diganti PMK 11/2025 | **Belum diverifikasi** |
| REG-10 | Ketentuan pelayanan kefarmasian di klinik | Telaah resep, penyimpanan, pelaporan narkotika/psikotropika | **Belum diverifikasi** — identifikasi peraturan yang berlaku |
| REG-11 | Ketentuan telemedisin | Hanya bila OD-002 = ya | Ditunda |
| REG-12 | PP 71/2019 (PSTE) & aturan pendaftaran Penyelenggara Sistem Elektronik | Kewajiban PSE lingkup privat, lokasi pengelolaan data | **Belum diverifikasi** — terkait OD-049 |
| REG-13 | Ketentuan tanda tangan elektronik (UU ITE & turunannya) | Pengesahan rekam medis & dokumen (OD-034) | **Belum diverifikasi** |
| REG-14 | Ketentuan QRIS (Bank Indonesia) | Dipenuhi melalui payment gateway berizin | Melalui vendor |

## 2. Standar & Kerangka Acuan

| ID | Standar | Penggunaan | Catatan |
|---|---|---|---|
| STD-01 | HL7 FHIR R4 | Format pertukaran data dengan SATUSEHAT | Klaim hanya setelah validasi |
| STD-02 | ICD-10 & ICD-9-CM | Diagnosis & tindakan | Sumber & lisensi: OD-030 |
| STD-03 | Kamus Farmasi & Alat Kesehatan (KFA) | Referensi obat SATUSEHAT | OD-031 |
| STD-04 | HIPAA Security & Privacy Rule | **Acuan kontrol**, bukan kewajiban hukum di Indonesia | Gap assessment di Stage 3; tidak mengklaim "HIPAA compliant" |
| STD-05 | OWASP ASVS / MASVS | Acuan keamanan web & mobile | Stage 3, 13 |

## 3. Implikasi Awal untuk Desain

| Ketentuan | Implikasi |
|---|---|
| Retensi RME ≥ 25 tahun sejak kunjungan terakhir (REG-03) | Data klinis tidak dihapus saat tenant berhenti; perlu mekanisme arsip & serah terima; biaya penyimpanan jangka panjang masuk model harga |
| RME wajib terintegrasi SATUSEHAT (REG-03, REG-07) | Integrasi SATUSEHAT adalah fitur inti, bukan add-on |
| Data kesehatan = data pribadi spesifik (REG-04) | Enkripsi, kontrol akses ketat, audit baca, consent, DPIA |
| Notifikasi kegagalan pelindungan data (REG-04, REG-05) | Incident response plan dengan tenggat; peran pengendali (klinik) vs prosesor (ClinicRME) diatur di kontrak |
| PP 33/2026 berlaku 16 Jan 2027 | Kebijakan privasi, DPIA, dan penunjukan PPDP sebaiknya siap sebelum produksi |
| Peran ClinicRME sebagai **prosesor** data untuk klinik (pengendali) | Perlu Data Processing Agreement dalam kontrak berlangganan (OD-060) |

## 4. Sumber yang Digunakan dalam Penelusuran

- peraturan.bpk.go.id — UU 27/2022, PP 28/2024
- JDIH Kemenkeu, JDIH Komdigi — UU 27/2022
- Hukumonline, Kompas, Verihubs, KRES — PP 33/2026
- MedMinutes, artikel jurnal — Permenkes 24/2022 (retensi, tenggat RME)
- Kemkes.go.id — SATUSEHAT
