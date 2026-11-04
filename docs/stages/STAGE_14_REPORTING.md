# Stage 14 — Custom Reporting, Analytics & Dashboard

| | |
|---|---|
| Phase | E — Integrasi & Kanal |
| Status | Belum dimulai |
| Prasyarat | Stage 13 disetujui |
| Modul | `reporting` |

## 1. Tujuan

Menyediakan pelaporan dinamis yang dapat dibuat dan dikonfigurasi pengguna berwenang tanpa coding, dengan kontrol keamanan dan performa.

## 2. Ruang Lingkup

- Report Builder: sumber data, kolom, label, urutan, format, filter, grouping, sorting, agregasi, subtotal, total, calculated field terbatas.
- Simpan, edit, duplikasi, hapus template sesuai permission; bagikan ke user/role dalam tenant.
- Parameter waktu, lokasi, dan variabel (lihat roadmap).
- Filter multi-select, pencarian nilai, kondisi AND/OR terbatas, parameter opsional.
- Visualisasi: tabel, bar, line, area, pie/donut, tren, KPI card, pivot, cross-tab, perbandingan, drill-down.
- Dashboard gabungan.
- Export Excel, CSV, PDF, print.
- Jadwal laporan & distribusi ke penerima berwenang.
- Watermark & metadata tenant.
- Batas rentang, baris, durasi, concurrency.
- Eksekusi asinkron untuk laporan berat.
- Audit pembuatan, eksekusi, dan export.

## 3. Rancangan

### 3.1 Katalog Data Semantik

User **tidak** menulis SQL. Builder bekerja di atas katalog:

| Konsep | Contoh |
|---|---|
| Dataset | `visits`, `diagnoses`, `prescriptions`, `dispenses`, `stock`, `invoices`, `payments`, `refunds`, `receivables`, `queue`, `audit` |
| Dimension | tanggal, cabang, unit, dokter, kategori pasien, penjamin, diagnosis, obat, status, metode bayar |
| Measure | jumlah kunjungan, pasien unik, pendapatan, qty obat, rata-rata waktu tunggu |
| Permission | setiap dataset & kolom sensitif memiliki permission (`report.dataset.clinical`) |

Definisi report disimpan sebagai JSON → divalidasi terhadap katalog → dikompilasi menjadi SQL terparameter oleh backend → dijalankan di read replica / reporting schema dengan RLS tenant aktif.

```json
{
  "dataset": "visits",
  "dimensions": ["branch", "practitioner", "month(visit_date)"],
  "measures": ["count(visit_id)", "count_distinct(patient_id)"],
  "filters": [{"field":"visit_date","op":"between","param":"period"},
              {"field":"payer_category","op":"in","values":["ASURANSI","PERUSAHAAN"]}],
  "sort": [{"field":"month(visit_date)","dir":"asc"}],
  "visual": {"type":"bar","x":"month(visit_date)","y":"count(visit_id)","series":"branch"}
}
```

### 3.2 Batas & Antrean

| Batas | Default usulan |
|---|---|
| Rentang tanggal interaktif | ≤ 366 hari |
| Baris tampil | ≤ 10.000 (lebih → export asinkron) |
| Durasi query | `statement_timeout` 30 detik interaktif |
| Concurrency | per tenant & per user |
| Export | asinkron ke GCS, signed URL, kedaluwarsa |

### 3.3 Laporan Standar Bawaan

Kunjungan harian/bulanan, 10 besar diagnosis, kinerja dokter, waktu tunggu, pendapatan per layanan/penjamin, piutang, stok & kedaluwarsa, penggunaan obat golongan khusus, closing kasir, aktivitas audit.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| RPT-FR-001 | Report builder berbasis katalog |
| RPT-FR-002 | Template disimpan & dibagikan |
| RPT-FR-003 | Visualisasi & dashboard |
| RPT-FR-004 | Export Excel/CSV/PDF dengan watermark |
| RPT-FR-005 | Jadwal & distribusi laporan |
| RPT-FR-006 | Batas eksekusi & proses asinkron |
| RPT-FR-007 | Audit eksekusi & export |

## 5. Deliverable

Modul `reporting`, katalog data, builder UI, dashboard, laporan bawaan, `REPORT_CATALOG.md`, test, completion report.

## 6. Gate Checklist

- [ ] Hasil laporan divalidasi terhadap query sumber manual (dataset uji).
- [ ] Uji keamanan: tidak ada SQL injection, kolom/dataset tanpa permission tidak dapat dipilih, RLS berlaku.
- [ ] Uji performa dengan volume data target.
- [ ] UAT oleh pengguna manajer klinik.
- [ ] Project Owner menyetujui Stage 14.

## 7. Open Decision

- **OD-012** — Kanal distribusi laporan terjadwal (email).
- **OD-046** — Library chart di Next.js (mis. Recharts / ECharts).
- **OD-047** — Read replica vs reporting schema (ADR-0012).
