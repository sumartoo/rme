# Stage 10 — Stage Completion Report

| | |
|---|---|
| Stage | 10 — Pharmacy & Inventory |
| Status | **DISETUJUI BERSYARAT** — DEC-041 (9 Nov 2026): S10-1 tinjauan apoteker sebelum/saat UAT; S10-2 uji mutasi lengkap di Actions setelah 1 Des |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) · keputusan DEC-039 (OD-037, OD-038, OD-096–OD-104) |
| Repo kerja | `AtoAIs/atoai-rme-v2`, PR #25–#28. Kuota GitHub Actions AtoAIs habis sampai 1 Des 2026, jadi setiap batch diverifikasi penuh di lokal lalu digabung tanpa CI (DEC-036) |
| Lingkungan uji | `https://demo.medika.atoai.id` (data sintetis). Demo VPS **belum** diperbarui ke Stage 10 |

## 1. Ringkasan

Farmasi klinik kini berjalan dari barang masuk sampai obat keluar:

1. **Persediaan.** Barang diterima dari supplier per faktur, dengan batch, tanggal kedaluwarsa, dan konversi ke satuan dasar. Stok dicatat sebagai ledger mutasi per batch dan lokasi (lokasi "Apotek" dibuat otomatis per cabang). Sistem memberi peringatan stok minimum dan kedaluwarsa.
2. **Harga.** Harga jual diatur per cabang dan penjamin dengan periode berlaku. Harga tidak boleh melebihi HET, dan periode tidak boleh tumpang tindih.
3. **Resep.** Resep dari dokter masuk ke worklist farmasi dan ditelaah dengan checklist. Obat diserahkan dengan batch FEFO/FIFO otomatis, sebagian bila stok kurang (sisa dapat diambil 7 hari). Racikan mengurangi stok setiap komponen. Harga dikunci di baris penyerahan sebagai calon tagihan, lalu etiket 80×50 mm dicetak.
4. **Substitusi.** Apoteker mengajukan obat pengganti dan dokter menyetujuinya di aplikasi.
5. **Kontrol.** Penyesuaian stok dan stock opname memakai maker–checker. Obat narkotika, psikotropika, dan prekursor memerlukan izin khusus dan punya laporan pemakaian bulanan.
6. **Penjualan bebas.** Obat Bebas/Bebas terbatas dapat dijual tanpa kunjungan dengan status menunggu bayar.
7. **Laporan** stok dan mutasi dapat diunduh sebagai CSV.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 236/236 (baru: P01–P05, D01–D08, S01–S06, G01–G04) |
| Uji keamanan & migrasi SQL | lulus (`test:db`), paritas skema lulus |
| E2E browser | 40/40 (baru: W26–W30) |
| Uji mutasi baru | M60–M89, semua terdeteksi di lokal |
| Migrasi | 0023–0026 |
| Kontrak API | 242 operasi |
| Modul baru | `libs/pharmacy`; renderer PDF dipindah ke `@clinicrme/shared/pdf` |
| Dependency baru | tidak ada |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| PHM-FR-001 master obat (golongan, KFA, stok minimum) | ✅ kode KFA opsional (pemetaan penuh Stage 12) | P05, W26 |
| PHM-FR-002 harga per penjamin/cabang | ✅ periode, HET, HNA. Harga beli tidak tampil di layar kasir/penjualan | P02, W26 |
| PHM-FR-003 penerimaan barang | ✅ faktur unik per supplier, batch, ED, konversi satuan, harga beli per satuan dasar | P03, P04, W26 |
| PHM-FR-004 ledger stok per batch & lokasi | ✅ saldo = Σ mutasi (rekonsiliasi otomatis) | P03, D08, G02 |
| PHM-FR-005 FEFO/FIFO | ✅ FEFO bawaan, FIFO di Profil klinik; batch manual wajib beralasan | D01, D03, D06, D07 |
| PHM-FR-006 worklist resep | ✅ per cabang, muat ulang tiap 5 detik | D01, W27 |
| PHM-FR-007 telaah checklist | ✅ OD-098; ada masalah → tidak dapat diserahkan `[REVIEW-MEDIS]` | D02, W27 |
| PHM-FR-008 penyerahan mengurangi stok + calon tagihan | ✅ harga terkunci, status *belum ditagih* (OD-096). Baris invoice dibuat di Stage 11 | D03, G03 |
| PHM-FR-009 resep parsial | ✅ sisa per baris, batas ambil 7 hari, tutup otomatis | D04 |
| PHM-FR-010 substitusi | ✅ OD-099, obat asli dan penyetuju tercatat | S01, S02, G03 |
| PHM-FR-011 etiket | ✅ PDF 80×50 mm (OD-102) | D03, D05, W27 |
| PHM-FR-012 penjualan bebas | ✅ hanya Bebas/Bebas terbatas (API + trigger DB), menunggu bayar (OD-101) | G01, W30 |
| PHM-FR-013 stok negatif & ED | ✅ CHECK saldo ≥ 0, trigger ED, kunci stok | D06, D08, G04 |
| PHM-FR-014 peringatan | ✅ minimum & ≤ `expiryWarningDays` (bawaan 90) | P05, W26 |
| PHM-FR-016 penyesuaian | ✅ maker–checker, dicek ulang saat disetujui | S03, W28 |
| PHM-FR-017 stock opname | ✅ hitung → kirim → setujui (≠ yang memulai) → mutasi OPNAME | S04, S05, W28 |
| PHM-FR-019 obat terbatas | ✅ izin `pharmacy.restricted.dispense` untuk terima/serahkan/sesuaikan/hitung opname; laporan bulanan | P04, D06, S03, S04, S06 |
| RPT-FR-005 laporan stok & mutasi | ✅ JSON/CSV, nilai harga beli | G02, W30 |

**Penyimpangan dari teks AC yang perlu Bapak ketahui:**
- **AC-PHM-FR-008-1** menyebut penyerahan "menambahkan baris obat ke invoice dalam satu transaksi". Modul tagihan baru ada di Stage 11, jadi sesuai OD-096 penyerahan menyimpan calon tagihan (harga terkunci, status `UNBILLED`) dalam transaksi yang sama. Stage 11 membuat baris invoice dari data ini.
- **AC-PHM-FR-019-1** menyebut stok obat terbatas "hanya dapat dilihat" pemegang izin khusus. OD-100 memutuskan izin khusus untuk *tindakan* (terima, serahkan, sesuaikan, opname). Saldo tetap terlihat oleh pemegang `pharmacy.stock.read` agar peringatan stok berfungsi. Bila Bapak ingin saldo obat terbatas juga disembunyikan, ini perubahan kecil.

## 3. Checklist Gate

- [x] Saldo stok = jumlah ledger untuk setiap batch dan lokasi (P03, D03, D08, S04, G02; mutasi M62, M72, M87)
- [x] Uji konkurensi penyerahan pada batch yang sama: tidak ada stok negatif atau penyerahan ganda. Mencakup penyerahan vs transaksi yang belum commit, dua penyerahan paralel, dan penjualan bebas vs penyerahan (D08, G04; M72, M87)
- [x] Resep ↔ penyerahan ↔ calon baris tagihan terekonsiliasi, termasuk parsial, sisa ditutup, dan substitusi. Penjualan bebas ↔ ledger, termasuk pembatalan (G03)
- [x] Kontrol golongan obat terbatas teruji (P04, D06, S03, S04, S06; M61, M71, M82, M83)
- [x] Matriks permission (X01) mencakup semua endpoint baru
- [ ] Uji mutasi lengkap M1–M89 di GitHub Actions — **S10-2 (DEC-041)**, bersama S9-2 setelah kuota aktif 1 Des
- [x] PO menyetujui Stage 10 secara bersyarat — DEC-041

## 4. Keamanan & integritas

- Ledger mutasi tidak dapat diubah. Saldo hanya diperbarui trigger `SECURITY DEFINER` dan tidak boleh negatif.
- Penerimaan, penyerahan, baris penjualan bebas, dan riwayat substitusi tidak dapat diubah atau dihapus oleh role aplikasi. Pengecualian:
  - `dispense_line`: hanya kolom status tagih yang dapat diubah, untuk Stage 11;
  - `otc_sale`: hanya kolom status dan pembatalan yang dapat diubah.
- Stock opname yang sudah disetujui atau dibatalkan dikunci trigger.
- Penyerahan, penjualan bebas, penyesuaian, dan opname memakai **kunci stok per obat+lokasi** (advisory lock, diurutkan agar tidak deadlock). Transaksi kedua membaca saldo setelah yang pertama commit.
- Maker–checker untuk penyesuaian dan opname dijaga API sekaligus CHECK database.
- Audit mencatat:
  - akses rincian resep oleh farmasi;
  - telaah, penyerahan, cetak etiket, dan penutupan sisa;
  - pengajuan dan keputusan substitusi;
  - penyesuaian, opname, dan penjualan bebas;
  - tampilan laporan.

  Penutupan sisa resep otomatis dicatat sebagai aktor SYSTEM.
- Data uji seluruhnya sintetis.

## 5. Yang perlu ditinjau sebelum pilot (sudah masuk gate Stage 16)

- **Checklist telaah resep** (OD-098, `[REVIEW-MEDIS]`) oleh apoteker penanggung jawab.
- **Format laporan obat golongan terbatas** (REG-10) dicocokkan dengan format pelaporan resmi (mis. SIPNAP). Saat ini format tersebut belum diverifikasi.
- Bersama review medis Stage 9 (S9-1).

## 6. Catatan untuk Stage berikutnya

- **Stage 11 (kasir):**
  - Buat baris invoice dari `dispense_line` berstatus `UNBILLED` (jumlah × `unit_price`), lalu ubah statusnya menjadi `BILLED`.
  - Penjualan bebas `AWAITING_PAYMENT` dibayar di kasir (`invoice.otc_sale_id`).
  - Pada alur kasir-dulu, kunjungan pindah ke `PHARMACY` setelah pembayaran.
- **Stage 12:** pemetaan KFA penuh untuk SATUSEHAT.
- **LJT (sesuai DEC-010):** retur supplier/pasien (PHM-FR-015), transfer antar lokasi (PHM-FR-018), valuasi HPP (PHM-FR-020; harga beli per batch sudah tersimpan).
- **Batasan yang diketahui:**
  - Komponen racikan ditampilkan tanpa urutan tetap (tidak ada kolom urutan sejak Stage 9).
  - Substitusi racikan belum didukung; perubahannya dilakukan lewat dokter.
  - Laporan mutasi dibatasi 5.000 baris per unduhan dan rentang maksimal 1 tahun.

## 7. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Apoteker penanggung jawab | | ☐ Layak ☐ Perlu perubahan | | checklist telaah & laporan obat terbatas (sebelum/saat UAT) |
| Project Owner | Sumarto | ☑ Disetujui bersyarat | 9 Nov 2026 | DEC-041: S10-1 tinjauan apoteker sebelum/saat UAT, S10-2 uji mutasi lengkap |
