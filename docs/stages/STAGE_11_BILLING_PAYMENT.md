# Stage 11 — Billing, Payment & Financial Controls

| | |
|---|---|
| Phase | D — Operasional Klinik |
| Status | Belum dimulai |
| Prasyarat | Stage 10 disetujui |
| Modul | `billing`, `integration` (payment gateway) |

## 1. Tujuan

Mengelola tarif, tagihan, dan pembayaran dengan kontrol anti-fraud dan rekonsiliasi yang ketat.

## 2. Ruang Lingkup

- Tarif fleksibel per fasilitas, layanan, kategori pasien.
- Snapshot tarif pada transaksi.
- Invoice & rincian biaya.
- Pembayaran tunai, debit, kartu kredit, QRIS.
- Pembayaran sebagian & gabungan (split tender).
- Deposit & piutang (perusahaan/asuransi).
- Tarif kontrak perusahaan & asuransi.
- Integrasi QRIS via payment gateway.
- Callback terverifikasi & idempotency.
- Rekonsiliasi pembayaran.
- Closing kasir & rekonsiliasi shift.
- Pembatalan via workflow admin.
- Refund & reversal dengan otorisasi.
- Audit trail & deteksi transaksi tidak wajar.

## 3. Rancangan

### 3.1 Tabel Inti

| Tabel | Keterangan |
|---|---|
| `invoice` | encounter_id/otc_sale_id, patient_id, payer_split, status, issued_at, number |
| `invoice_line` | source_type (CONSULT/PROCEDURE/DRUG/LAB/OTHER), source_id, qty, unit_price_snapshot, discount, payer_portion, patient_portion |
| `payment` | invoice_id, method, amount, reference, status, cashier_shift_id, idempotency_key |
| `payment_gateway_txn` | payment_id, provider, provider_ref, qr_payload, status, callback_raw, verified |
| `refund` | payment_id, amount, reason, requested_by, approved_by, status |
| `invoice_void` | invoice_id, reason, requested_by, approved_by |
| `cashier_shift` | user_id, branch_id, opened_at, opening_cash, closed_at, counted_cash, expected_cash, variance |
| `receivable` | payer_id, invoice_id, amount, due_date, status |
| `deposit` | patient_id, amount, balance |

### 3.2 Aturan

1. Harga di `invoice_line` adalah **snapshot**; perubahan tarif tidak memengaruhi invoice yang sudah dibuat.
2. Invoice `ISSUED` tidak diedit; koreksi via void (approval) + invoice baru.
3. Pembayaran tidak dihapus; pengembalian via `refund` terpisah.
4. Refund > batas tertentu memerlukan approval manajer (maker–checker).
5. Callback QRIS: verifikasi signature → cek idempotency → cek nominal & status → update. Callback tidak valid dicatat & diabaikan.
6. Job rekonsiliasi harian membandingkan `payment_gateway_txn` dengan settlement report provider.

### 3.3 Deteksi Tidak Wajar (aturan awal)

- Refund/void di luar jam operasional.
- Diskon di atas ambang.
- Banyak void oleh kasir yang sama dalam satu shift.
- Selisih kas shift melebihi toleransi.
- Pembayaran tunai pada invoice yang sudah lunas via QRIS.

Hasil berupa flag & laporan untuk manajer, bukan blokir otomatis (kecuali ditetapkan lain).

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| BIL-FR-001 | Invoice otomatis dari layanan, tindakan, obat |
| BIL-FR-002 | Split payment antara penjamin & pasien |
| BIL-FR-003 | Pembayaran multi-metode dalam satu invoice |
| BIL-FR-004 | QRIS dinamis dengan callback terverifikasi |
| BIL-FR-005 | Closing shift dengan perhitungan selisih |
| BIL-FR-006 | Void & refund dengan approval |
| BIL-FR-007 | Rekonsiliasi harian payment gateway |
| BIL-FR-008 | Laporan transaksi tidak wajar |

## 5. Deliverable

Modul `billing`, adapter payment gateway (sandbox), layar kasir & approval, test transaksi, completion report.

## 6. Gate Checklist

- [ ] Uji idempotency (callback ganda, retry klien).
- [ ] Uji callback dengan signature salah ditolak.
- [ ] Total invoice = Σ pembayaran − Σ refund untuk seluruh dataset uji.
- [ ] Closing shift & rekonsiliasi teruji.
- [ ] Aturan fraud menghasilkan flag yang benar.
- [ ] Project Owner menyetujui Stage 11.

## 7. Open Decision

- **OD-039** — Payment gateway QRIS yang dipakai (biaya & kontrak perlu persetujuan).
- **OD-040** — Kebutuhan e-Faktur / pajak pada invoice.
- **OD-041** — Ambang approval refund & diskon (konfigurasi per tenant).
