# Stage 0 — Project Charter & Feasibility

| | |
|---|---|
| Phase | A — Inisiasi & Desain |
| Status | **Selesai — disetujui 3 Nov 2026** (lihat `reports/stage-0/`) |
| Prasyarat | — |
| Stage berikutnya | Stage 1 — Requirements |

## 1. Tujuan

Menetapkan arah, ruang lingkup, batas sistem, dan kelayakan proyek ClinicRME SaaS sebelum requirement detail disusun.

## 2. Ruang Lingkup

**Termasuk:**
- Project Charter: visi, tujuan bisnis, indikator keberhasilan.
- Identifikasi stakeholder & persona pengguna.
- Segmentasi pelanggan: klinik utama, klinik pratama, praktik dokter mandiri — perbedaan kebutuhan masing-masing.
- Penetapan batas sistem (bukan SIMRS, bukan LIS).
- Inventaris aplikasi lab eksisting yang akan diintegrasikan.
- Identifikasi regulasi & standar yang relevan.
- Risk register awal.
- Stage gate policy & Change Request policy.
- Audit repository (kondisi saat ini: hanya berisi PDF roadmap).

**Tidak termasuk:** requirement detail, desain teknis, penulisan kode.

## 3. Rancangan Pekerjaan

### 3.1 Segmentasi Pelanggan (draft untuk divalidasi)

| Aspek | Praktik Mandiri | Klinik Pratama | Klinik Utama |
|---|---|---|---|
| Pengguna khas | 1–3 | 5–20 | 20–100+ |
| Cabang | 1 | 1–beberapa | Beberapa |
| Dokter | Umum/spesialis tunggal | Dokter umum | Spesialis |
| Farmasi | Opsional | Umum | Umum |
| Lab | Jarang | Kadang | Sering |
| Penjamin | Umum | Umum + BPJS (FKTP) + perusahaan | Umum + asuransi + perusahaan |
| Paket usulan | Basic | Standard | Professional |

### 3.2 Regulasi & Standar untuk Diidentifikasi

Daftar ini adalah titik awal; versi dan isi pasal harus diverifikasi dari sumber resmi sebelum dicantumkan di `SCOPE.md`.

- Undang-Undang Kesehatan yang berlaku.
- Permenkes tentang Rekam Medis (termasuk RME, retensi, kerahasiaan).
- Ketentuan SATUSEHAT dari Kemenkes (kewajiban integrasi fasyankes).
- UU Pelindungan Data Pribadi dan aturan turunannya.
- Ketentuan klinik & praktik mandiri dokter.
- Ketentuan pelayanan kefarmasian di klinik.
- Ketentuan QRIS / Bank Indonesia (melalui payment gateway).
- HIPAA Security & Privacy Rule — sebagai **acuan kontrol**, bukan klaim kepatuhan.
- HL7 FHIR R4.

### 3.3 Risk Register Awal (contoh entri)

| ID | Risiko | Dampak | Kemungkinan | Mitigasi awal |
|---|---|---|---|---|
| RSK-001 | Kebocoran data lintas tenant | Sangat tinggi | Sedang | RLS + test isolasi otomatis (Stage 3) |
| RSK-002 | Perubahan spesifikasi SATUSEHAT | Tinggi | Tinggi | Adapter terisolasi, monitoring changelog |
| RSK-003 | Scope creep ke arah SIMRS | Tinggi | Tinggi | Batas sistem di SCOPE.md + CR policy |
| RSK-004 | Variasi API aplikasi lab eksisting | Sedang | Tinggi | Adapter per vendor, inventaris di Stage 0 |
| RSK-005 | Biaya GCP tidak terkendali | Sedang | Sedang | Budget alert, max instance (Stage 15) |
| RSK-006 | Ketersediaan tenaga medis untuk validasi klinis | Tinggi | Sedang | Tetapkan clinical advisor sejak Stage 0 |
| RSK-007 | Klaim kepatuhan tanpa bukti | Tinggi | Rendah | Prinsip #9, review dokumen |

## 4. Deliverable

| File | Lokasi |
|---|---|
| PROJECT_CHARTER.md | docs/00-governance/ |
| SCOPE.md | docs/00-governance/ |
| ROADMAP.md | docs/00-governance/ |
| STAGE_GATE_POLICY.md | docs/00-governance/ |
| RISK_REGISTER.md | docs/00-governance/ |
| DECISION_LOG.md | docs/00-governance/ |
| CHANGE_REQUEST_POLICY.md | docs/00-governance/ (tambahan, atau bagian dari STAGE_GATE_POLICY) |
| STAGE_COMPLETION_REPORT.md | docs/reports/stage-0/ |

## 5. Gate Checklist

- [ ] Visi, tujuan, dan indikator keberhasilan disetujui.
- [ ] Batas sistem tertulis jelas (termasuk/tidak termasuk).
- [ ] Segmentasi pelanggan & paket dikonfirmasi.
- [ ] Daftar regulasi diverifikasi dari sumber resmi.
- [ ] Aplikasi lab eksisting teridentifikasi (vendor, antarmuka).
- [ ] Risk register awal disetujui.
- [ ] Stage gate & CR policy disetujui.
- [ ] Open decision OD-001, OD-002, OD-018 diputuskan.
- [ ] Project Owner menandatangani persetujuan Stage 0.

## 6. Open Decision

- **OD-001** — Bridging BPJS (P-Care/V-Claim) masuk scope?
- **OD-002** — Telemedicine masuk scope?
- **OD-018** — Urutan Stage 3 vs Stage 4 (lihat STAGE_03).
- **OD-019** — Siapa clinical advisor yang memvalidasi workflow & terminologi?
- **OD-020** — Model bisnis: harga per cabang, per user, atau per kunjungan?
