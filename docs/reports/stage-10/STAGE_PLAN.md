# Stage 10 — Stage Plan

| | |
|---|---|
| Stage | 10 — Pharmacy & Inventory |
| Status | **DRAF — MENUNGGU KEPUTUSAN OD**. Pengembangan dimulai setelah Stage 9 disetujui |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): PHM-FR-001–014, 016, 017, 019. Di luar stage ini (LJT): PHM-FR-015 retur, PHM-FR-018 transfer antar lokasi/cabang, PHM-FR-020 valuasi HPP |
| Mode verifikasi | Lokal + GitHub Actions `sumartoo/rme` (CI & deploy otomatis) |

## 1. Tujuan

Farmasi menerima resep yang diterbitkan dokter, menelaahnya, lalu menyerahkan obat dari stok per batch secara FEFO (sebagian bila stok kurang). Substitusi dilakukan dengan persetujuan dokter, dan etiket dicetak. Stok dicatat sebagai ledger yang dapat direkonsiliasi, melalui penerimaan barang, penyesuaian, dan stock opname yang semuanya memerlukan persetujuan. Obat bebas dapat dijual tanpa kunjungan.

## 2. Yang Sudah Ada

- **Skema baseline (Stage 3):**
  - `stock_location`, `stock_batch` (`unit_cost`), `stock_balance` (CHECK ≥ 0), `stock_movement` (ledger append-only).
  - Trigger `apply_stock_movement`: menolak batch kedaluwarsa untuk DISPENSE/OTC dan memperbarui saldo.
  - `goods_receipt(_line)`, `dispense(_line)`, `otc_sale(_line)`, `stock_adjustment` (penyetuju ≠ pemohon), `stock_opname(_line)`, `drug_price` (exclusion per periode/penjamin/cabang).
- **Izin:** `pharmacy.drug.*`, `pharmacy.stock.read/receive/adjust/approve/opname`, `pharmacy.dispense`, `pharmacy.otc.sell` sudah ada di role FARMASI/KASIR/OWNER.
- **Dari Stage 7–9:**
  - Supplier, satuan, dan konversi satuan.
  - Master obat minimal (OD-091) dengan zat aktif dan batas dosis.
  - Resep ISSUED berisi baris obat dan racikan, peringatan beralasan.
  - Kunjungan yang diteruskan ke `PHARMACY`/`BILLING` (OD-094).

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Harga, lokasi & penerimaan barang** | Melengkapi master obat: kolom rujukan KFA (OD-031), stok minimum, harga per penjamin/cabang dengan periode (HNA, HET, harga jual). Lokasi stok per cabang (OD-097). Penerimaan barang dari supplier: faktur, batch, kedaluwarsa, harga beli per satuan dasar memakai konversi satuan; ledger RECEIPT. Layar stok per obat/batch/lokasi. Peringatan stok minimum & mendekati kedaluwarsa | PHM-FR-001–004, 014 |
| **2 — Worklist farmasi, telaah & penyerahan** | Worklist resep ISSUED per cabang. Telaah resep dengan checklist (OD-098). Pemilihan batch FEFO otomatis (OD-037), stok kurang → penyerahan sebagian dengan sisa tercatat. Racikan mengurangi stok komponen. Harga terkunci saat diserahkan (OD-096). Etiket obat PDF (OD-102). Riwayat obat pasien. Status kunjungan sesudah farmasi mengikuti pengaturan farmasi ↔ kasir (OD-103) | PHM-FR-005–009, 011, 013 |
| **3 — Substitusi, penyesuaian, opname & obat terbatas** | Substitusi diajukan apoteker → disetujui dokter kunjungan atau dokter bertugas di cabang yang sama (DEC-013/OD-064; OD-099). Penyesuaian stok beralasan dengan persetujuan orang lain. Stock opname: hitung → kirim → setujui selisih → ledger OPNAME. Narkotika/psikotropika: izin khusus & laporan pemakaian (OD-100) | PHM-FR-010, 016, 017, 019 |
| **4 — Penjualan obat bebas & gate** | Penjualan obat bebas tanpa kunjungan, hanya golongan Bebas/Bebas terbatas (OD-101). Laporan stok & mutasi. Uji rekonsiliasi saldo = ledger, konkurensi penyerahan pada batch yang sama, resep ↔ penyerahan ↔ calon tagihan. Completion report | PHM-FR-012, gate |

Perkiraan: ±1 hari kerja per batch.

## 4. Open Decision Stage 10

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-037** | FEFO atau FIFO | **FEFO bawaan** (batch dengan kedaluwarsa terdekat keluar dulu; bila sama, yang diterima lebih dulu). FIFO dapat dipilih per klinik di Profil klinik. Apoteker boleh memilih batch lain secara manual dengan alasan tercatat |
| **OD-038** | Metode valuasi stok untuk HPP | **Ditunda** (PHM-FR-020 LJT). Harga beli per batch (`unit_cost`) sudah tersimpan, sehingga laporan HPP rata-rata tertimbang atau FIFO dapat dihitung kemudian tanpa migrasi data |
| **OD-096** (baru) | Bagaimana obat masuk tagihan sebelum modul kasir (Stage 11) ada | Setiap baris penyerahan menyimpan **harga jual saat diserahkan** (sesuai penjamin kunjungan & cabang) dan status *belum ditagih*. Stage 11 membuat baris tagihan dari data ini (resep parsial ditagih sesuai jumlah yang diserahkan, DEC-013). Obat tanpa harga berlaku tidak dapat diserahkan |
| **OD-097** (baru) | Lokasi stok | **Satu lokasi "Apotek" per cabang dibuat otomatis**. Admin dapat menambah lokasi lain (mis. gudang). Mutasi antar lokasi = LJT (PHM-FR-018) |
| **OD-098** (baru) | Checklist telaah resep `[REVIEW-MEDIS]` | Tiga kelompok, setiap butir dicentang atau diberi catatan masalah. **Administratif:** identitas pasien, nama & SIP dokter, tanggal resep. **Farmasetik:** bentuk & kekuatan sediaan, jumlah, aturan pakai, kesesuaian komponen racikan. **Klinis:** dosis, alergi, duplikasi (memakai peringatan dokter OD-033), kondisi khusus. Isi daftar wajib ditinjau apoteker sebelum pilot |
| **OD-099** (baru) | Alur substitusi | Apoteker memilih obat pengganti beserta alasan (mis. stok habis) → notifikasi di worklist dokter → dokter kunjungan atau dokter bertugas di cabang yang sama **menyetujui/menolak di aplikasi** → baris resep asli tetap tersimpan, substitusi tercatat sebagai baris pengganti. Selama menunggu, baris itu tertahan dan baris lain dapat diserahkan |
| **OD-100** (baru) | Narkotika & psikotropika | Izin baru **`pharmacy.restricted.dispense`**, yang di template hanya diberikan ke role FARMASI dan dapat dicabut per user lewat role kustom. Diperlukan untuk menerima barang, menyerahkan, menyesuaikan stok, dan opname obat golongan tersebut. Disediakan laporan pemakaian bulanan per obat (saldo awal, masuk, keluar, saldo akhir) yang dapat diekspor. Format pelaporan resmi **belum diverifikasi** (REG-10) |
| **OD-101** (baru) | Penjualan obat bebas tanpa kunjungan | Hanya golongan **Bebas & Bebas terbatas**, tanpa data pasien wajib. Di Stage 10 penjualan mencatat barang, harga (penjamin Umum), dan mengurangi stok dengan status **menunggu bayar**. Pembayaran diterima di kasir pada Stage 11. Bila Bapak ingin farmasi menerima uang sendiri sebelum Stage 11, beri tahu karena alurnya berubah |
| **OD-102** (baru) | Etiket obat | PDF ukuran label **80 × 50 mm** (satu label per baris obat), dicetak dari peramban ke printer label/biasa: nama klinik, nama & No. RM pasien, tanggal, nama obat, aturan pakai, jumlah. Tanpa driver printer khusus |
| **OD-103** (baru) | Urutan farmasi ↔ kasir: perbaikan bawaan | DEC-013 menetapkan **bawaan farmasi → kasir**, tetapi saklar di Profil klinik (Stage 6) dan "Selesai konsultasi" (Stage 9) menganggap pengaturan yang belum diisi sebagai *kasir dulu*. Usulan: **bawaan diperbaiki menjadi farmasi dulu** sesuai DEC-013. Klinik yang memang ingin kasir dulu cukup mematikan saklar |
| **OD-104** (baru) | Batas waktu pengambilan sisa resep parsial | Sisa obat dapat diambil **hingga 7 hari** setelah penyerahan pertama (dapat diatur per klinik). Setelah lewat, sisa ditutup otomatis dengan alasan "tidak diambil" dan tidak ditagih |

## 5. Gate Stage 10

- [ ] Saldo stok = jumlah ledger untuk setiap batch dan lokasi (uji rekonsiliasi)
- [ ] Uji konkurensi penyerahan pada batch yang sama (tidak ada stok negatif atau penyerahan ganda)
- [ ] Resep ↔ penyerahan ↔ calon baris tagihan terekonsiliasi (termasuk parsial & substitusi)
- [ ] Kontrol golongan obat terbatas teruji
- [ ] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi untuk kontrol baru terdeteksi
- [ ] PO menyetujui Stage 10

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 7 Nov 2026 | Draf rencana & OD Stage 10 disusun sambil menunggu review medis Stage 9. Uji mutasi lengkap M1–M59 dijalankan di Actions (`workflow_dispatch`) | run 42329227880 |
