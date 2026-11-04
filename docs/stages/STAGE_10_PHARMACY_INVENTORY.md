# Stage 10 — Pharmacy & Inventory

| | |
|---|---|
| Phase | D — Operasional Klinik |
| Status | Belum dimulai |
| Prasyarat | Stage 9 disetujui |
| Modul | `pharmacy` |

> Roadmap asli mencantumkan "Integrasi aplikasi laboratorium terpisah" di stage ini. Dalam rancangan ini integrasi lab dipindahkan ke Stage 9 (order/hasil) karena terkait encounter, bukan farmasi. Disetujui (DEC-009).

## 1. Tujuan

Mengelola obat, stok per batch, dan dispensing yang dapat direkonsiliasi.

## 2. Ruang Lingkup

- Master obat: nama generik/dagang, komposisi, bentuk, kekuatan, satuan, golongan (bebas, keras, narkotika, psikotropika).
- Harga modal, HNA, HET, harga jual.
- Batch, nomor lot, tanggal kedaluwarsa.
- Penerimaan (dari supplier) & pengeluaran stok.
- FEFO / FIFO sesuai kebijakan.
- Stok minimum & peringatan kedaluwarsa.
- Telaah resep, dispensing, riwayat obat pasien.
- Resep parsial & substitusi dengan persetujuan dokter.
- Retur, penyesuaian, stock opname.
- Pembatasan akses obat golongan tertentu.
- Penjualan obat bebas tanpa kunjungan.

## 3. Rancangan

### 3.1 Model Stok — Ledger

Stok **tidak** disimpan sebagai angka yang di-update langsung; setiap perubahan adalah baris di ledger.

| Tabel | Keterangan |
|---|---|
| `drug_item` | master obat tenant (rujuk KFA bila OD-031 disetujui) |
| `stock_location` | apotek, gudang, per cabang |
| `stock_batch` | drug_id, batch_no, expiry_date, location_id |
| `stock_movement` | batch_id, type (RECEIPT/DISPENSE/RETURN/ADJUST/TRANSFER/OPNAME), qty (+/−), ref_doc, actor, at |
| `stock_balance` | materialized: batch_id, qty_on_hand — diperbarui dalam transaksi yang sama, diverifikasi terhadap ledger |
| `goods_receipt` | supplier, faktur, item, harga |
| `dispense` / `dispense_line` | prescription_item_id, batch_id, qty, telaah_by, handed_over_at |
| `stock_opname` | sesi, hasil hitung, selisih → movement ADJUST dengan approval |

### 3.2 Alur Dispensing

```
Resep ISSUED → Telaah (administrasi, farmasetik, klinis) → VERIFIED
  → Pemilihan batch otomatis (FEFO) → Penyiapan → Serah terima & edukasi
  → DISPENSED / PARTIALLY_DISPENSED
  → event: tambah baris tagihan obat ke invoice
```

Substitusi: apoteker mengajukan → dokter menyetujui (in-app) → tercatat di resep.

### 3.3 Kontrol

- Stok negatif ditolak.
- Obat kedaluwarsa tidak dapat dipilih.
- Narkotika/psikotropika: permission khusus & laporan terpisah.
- Penyesuaian stok memerlukan alasan & persetujuan.

## 4. Requirement Awal

| ID | Ringkasan |
|---|---|
| PHM-FR-001 | Penerimaan barang per batch & expiry |
| PHM-FR-002 | Dispensing otomatis memilih batch FEFO |
| PHM-FR-003 | Resep parsial dengan sisa tercatat |
| PHM-FR-004 | Substitusi dengan persetujuan dokter |
| PHM-FR-005 | Peringatan stok minimum & mendekati kedaluwarsa |
| PHM-FR-006 | Stock opname dengan approval selisih |
| PHM-FR-007 | Penjualan obat bebas tanpa encounter |

## 5. Deliverable

Modul `pharmacy`, layar worklist farmasi, penerimaan, stok, opname, laporan stok, test, completion report.

## 6. Gate Checklist

- [ ] Saldo stok = jumlah ledger untuk setiap batch (test rekonsiliasi).
- [ ] Uji konkurensi dispensing pada batch yang sama.
- [ ] Resep ↔ dispense ↔ tagihan terekonsiliasi.
- [ ] Kontrol golongan obat terbatas teruji.
- [ ] Project Owner menyetujui Stage 10.

## 7. Open Decision

- **OD-036** — Pemindahan integrasi lab ke Stage 9.
- **OD-037** — Default FEFO atau FIFO per tenant.
- **OD-038** — Metode valuasi stok (rata-rata tertimbang / FIFO) untuk laporan HPP.
