# Stage 11 — Stage Completion Report

| | |
|---|---|
| Stage | 11 — Billing, Payment & Financial Controls |
| Status | **MENUNGGU PERSETUJUAN PO** |
| Disusun oleh | Sumarto (dibantu Claude) |
| Rincian | [STAGE_PLAN.md](STAGE_PLAN.md) · keputusan DEC-042 (OD-039–OD-041, OD-105–OD-113) |
| Repo kerja | `AtoAIs/atoai-rme-v2`, PR #30, #36, #37 dan PR batch 4. Kuota GitHub Actions AtoAIs habis sampai 1 Des 2026, jadi setiap batch diverifikasi penuh di lokal lalu digabung tanpa CI (DEC-036) |
| Lingkungan uji | `https://demo.medika.atoai.id` (data sintetis). Demo VPS **belum** diperbarui ke Stage 10–11 |

## 1. Ringkasan

Kasir klinik kini berjalan dari tagihan sampai tutup buku harian:

1. **Tagihan.** Draf dibuat otomatis dari kunjungan dengan isi berikut:
   - konsultasi (layanan bawaan poli), biaya administrasi cabang, tindakan, dan lab;
   - obat yang sudah diserahkan, dengan harga yang dikunci di farmasi.

   Aturan harga dan penjamin:
   - Tarif dipilih berprioritas: penjamin + cabang → … → umum.
   - Penjamin dibagi sesuai kontrak (co-pay, plafon); kasir boleh mengubah pembagian per baris dengan alasan.
   - Diskon wajib beralasan. Diskon di atas batas klinik menunggu persetujuan manajer.

   Tagihan terbit bernomor `INV…`, lalu isinya terkunci dan rinciannya tersedia sebagai PDF A4.

   Selain tagihan kunjungan, ada tagihan obat susulan (alur kasir-dulu) dan tagihan obat bebas.
2. **Shift & pembayaran.**
   - Pembayaran hanya dapat dicatat pada shift kasir yang terbuka.
   - Metode: tunai (dengan kembalian), debit, kartu, transfer, dan QRIS. Boleh sebagian atau gabungan beberapa metode.
   - Permintaan yang sama tidak tercatat dua kali (`Idempotency-Key`). Kwitansi `KW…` berupa PDF 80 mm.
   - Setelah lunas, kunjungan selesai, atau diteruskan ke farmasi pada alur kasir-dulu. Penjualan obat bebas menjadi lunas.
3. **QRIS.**
   - Memakai adapter payment gateway dengan **simulator** (penyedia nyata dipilih sebelum pilot).
   - Pembayaran hanya tercatat dari callback yang tanda tangannya terverifikasi.
   - Rekonsiliasi harian dilakukan dengan berkas settlement.
4. **Koreksi.** Void tagihan belum dibayar dan refund pembayaran. Keduanya selalu disetujui orang lain. Tagihan dan pembayaran asal tidak pernah diubah.
5. **Pengawasan.**
   - Porsi penjamin menjadi piutang, dengan pelunasan sebagian atau penuh.
   - Manajer memverifikasi shift dan menutup shift yang lupa ditutup.
   - Laporan transaksi tidak wajar dengan ambang yang diatur di Profil klinik.

| Metrik | Nilai |
|---|---|
| Uji integrasi API | 261/261 (baru: B01–B08, L01–L06, R01–R06, H01–H05) |
| Uji keamanan & migrasi SQL | lulus (`test:db`, baru T18a); paritas skema lulus |
| E2E browser | 44/44 (baru: W31–W34) |
| Uji mutasi baru | M90–M133, semua terdeteksi di lokal |
| Migrasi | 0027–0030 |
| Kontrak API | 260 operasi |
| Modul baru | `libs/billing` (tagihan, pembayaran, QRIS, koreksi, pengawasan) |
| Dependency baru | tidak ada (QR di layar memakai pustaka `qrcode` yang sudah dipakai untuk MFA) |

## 2. Requirement MVP

| ID | Status | Bukti |
|---|---|---|
| BIL-FR-001 tagihan dari kunjungan | ✅ konsultasi, administrasi, tindakan, lab, obat diserahkan; obat susulan & obat bebas (OD-105, 107, 113) | B01, B02, B07, B08, W31 |
| BIL-FR-002 harga snapshot | ✅ tarif & harga obat tersimpan di baris; tidak berubah bila tarif diubah sesudahnya | B03 |
| BIL-FR-003 diskon & batas | ✅ diskon beralasan; di atas `discountLimitPercent` (bawaan 10%) menunggu persetujuan ≠ peminta (OD-041) | B04, W31 |
| BIL-FR-004 pembagian penjamin | ✅ prioritas tarif (OD-106), co-pay & plafon (OD-108), ubah porsi dengan alasan | B05, L04 |
| BIL-FR-005 pembayaran multi-metode | ✅ tunai/debit/kartu/transfer, sebagian & gabungan | L02, W32 |
| BIL-FR-006 QRIS | ✅ adapter + simulator, callback ber-signature, idempoten, kedaluwarsa (OD-039) | R01, R02, W33 |
| BIL-FR-007 status bayar | ✅ terbayar = Σ pembayaran − Σ refund disetujui; `ISSUED → PARTIALLY_PAID → PAID` | L02, R05, H05 |
| BIL-FR-008 kwitansi | ✅ PDF 80 mm (OD-109), nomor `KW…` (OD-110) | L02, W32 |
| BIL-FR-009 void | ✅ hanya belum dibayar, maker–checker, tagihan pengganti | R04, W33 |
| BIL-FR-010 refund | ✅ per pembayaran, maker–checker, tunai dari kas shift (OD-112) | R05, W33 |
| BIL-FR-011 shift kasir | ✅ buka/tutup, selisih > toleransi wajib keterangan, verifikasi & tutup oleh manajer (OD-111) | L01, L03, H02, W32, W34 |
| BIL-FR-012 rekonsiliasi QRIS | ✅ CSV settlement, 4 jenis selisih | R03, W33 |
| BIL-FR-013 piutang penjamin | ✅ terbentuk saat terbit, pelunasan sebagian/penuh | L04, H01, W34 |
| BIL-FR-016 transaksi tidak wajar | ✅ 6 aturan, ambang di Profil klinik, ekspor CSV (OD-041) | H03, H04, W34 |

**Penyimpangan dan hal yang perlu Bapak ketahui:**
- **QRIS masih simulator.** Pembayaran QRIS sungguhan membutuhkan kontrak dengan penyedia (Midtrans, Xendit, DOKU, dll.) dan kunci API. Yang perlu ditambahkan nanti hanya satu kelas adapter. Aplikasi **menolak** simulator di produksi, sehingga simulator tidak bisa terbawa ke klinik sungguhan.
- **Void hanya untuk tagihan yang belum menerima uang sama sekali**, termasuk pelunasan piutang penjamin. Tagihan yang ditanggung penuh penjamin dan sudah "lunas" saat terbit juga tidak dapat di-void. Untuk kasus itu dipakai koreksi lewat piutang, atau dibuat aturan baru bila Bapak membutuhkannya.
- **Refund tunai** harus disetujui selama shift pengajunya masih terbuka. Bila shift sudah ditutup, refund ditolak lalu diajukan ulang di shift yang terbuka. Ini menjaga kas seharusnya setiap shift tetap konsisten.
- **BPJS** di MVP diperlakukan sebagai penjamin biasa (piutang). Bridging dan klaim BPJS adalah LJT (OD-108).

## 3. Checklist Gate

- [x] Uji idempotensi: callback ganda dan retry klien tidak mencatat pembayaran ganda (L02, R01; M112)
- [x] Callback dengan signature salah ditolak dan dicatat (R01; M111)
- [x] Total terbayar = Σ pembayaran − Σ refund untuk seluruh data uji; porsi penjamin = piutang; saldo piutang = nominal − Σ pelunasan (R06, H05)
- [x] Harga tagihan tidak berubah saat tarif atau harga obat diubah sesudahnya (B03)
- [x] Closing shift & rekonsiliasi teruji (L03, R03, R05, H02; M107–M109, M115, M122, M123, M127, M128)
- [x] Aturan anomali menghasilkan tanda yang benar (H03; M129–M133)
- [x] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi (M90–M133)
- [ ] Uji mutasi lengkap M1–M133 di GitHub Actions — setelah kuota aktif 1 Des (bersama S8-1, S9-2, S10-2)
- [ ] PO menyetujui Stage 11

## 4. Keamanan & integritas

- **Tagihan terbit** tidak dapat diubah isinya; trigger DB hanya mengizinkan status dan jumlah terbayar berubah.
  - Transisi status dijaga: void tidak bisa dibatalkan, dan tagihan yang sudah dibayar tidak dapat di-void.
  - Status lunas hanya boleh kembali ke sebagian bila terbayar turun karena refund yang disetujui.
- **Pembayaran, pelunasan piutang, dan baris settlement** tidak dapat diubah atau dihapus oleh role aplikasi. Pembayaran hanya dapat masuk ke shift yang terbuka (trigger DB).
- **Refund dan void yang sudah diputuskan** dikunci trigger. Pemutus selalu orang yang berbeda dari pengaju; aturan ini dijaga API sekaligus CHECK database. Shift yang sudah diverifikasi juga dikunci, dan pemverifikasinya tidak boleh kasir shift itu.
- **Callback QRIS**:
  - Signature HMAC-SHA256 dihitung atas byte mentah body dan dibandingkan secara *constant-time*.
  - Transaksi dikunci per baris, dan pembayaran memakai kunci unik `qris:<txn>`.
  - Penolakan (signature, nominal) tetap tercatat di audit sebagai aktor SYSTEM, walaupun respons ke penyedia berupa error.
- **Audit** mencatat:
  - terbit tagihan;
  - pembayaran, kwitansi dilihat, buka/tutup/tutup paksa/verifikasi shift;
  - QR dibuat dan callback;
  - pengajuan dan keputusan void/refund;
  - pelunasan piutang dan unggah settlement.
- Data uji seluruhnya sintetis. Kunci simulator diturunkan dari kunci enkripsi lokal; staging wajib kunci tersendiri.

## 5. Yang perlu diputuskan atau ditinjau sebelum pilot

- **Penyedia QRIS** (OD-039 lanjutan): pilih penyedia, kontrak merchant per klinik, uji di sandbox penyedia. Setelah itu adapter ditambahkan dan berkas settlement penyedia dipetakan ke format rekonsiliasi.
- **Ambang anomali bawaan** (jam kasir 07.00–21.00, 3 void per shift, toleransi Rp 10.000, diskon 10%): cocokkan dengan kebijakan klinik pilot. Semua ambang bisa diubah di Profil klinik.
- Pengingat UAT yang sudah ada: S9-1 (review medis Stage 9), S10-1 (review apoteker), dan uji mutasi lengkap setelah 1 Des.

## 6. Catatan untuk Stage berikutnya

- **Stage 12 (SATUSEHAT):** data tagihan tidak dikirim. Encounter yang selesai setelah lunas (status `FINISHED`) adalah pemicu pengiriman kunjungan.
- **Stage 14 (laporan):** pendapatan per layanan/metode/penjamin (RPT-FR-003) dapat diambil dari `invoice_line`, `payment`, dan `refund`. Laporan transaksi tidak wajar sudah tersedia di menu Kasir.
- **LJT (sesuai DEC-010):** tagihan kolektif perusahaan (BIL-FR-014), deposit pasien (BIL-FR-015), e-Faktur (BIL-FR-017), hapus buku piutang (status `WRITTEN_OFF` sudah disiapkan), retur obat dari refund (PHM-FR-015).
- **Batasan yang diketahui:**
  - Rekonsiliasi QRIS per tanggal settlement; batas 20.000 baris per berkas.
  - Laporan anomali dibatasi rentang 92 hari.
  - Daftar shift dan antrean persetujuan menampilkan 200 data terbaru.

## 7. Persetujuan

| Peran | Nama | Keputusan | Tanggal | Catatan |
|---|---|---|---|---|
| Project Owner | Sumarto | ☐ Disetujui ☐ Disetujui bersyarat ☐ Perlu perubahan | | |
