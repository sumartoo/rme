# Stage 11 — Stage Plan

| | |
|---|---|
| Stage | 11 — Billing, Payment & Financial Controls |
| Status | **BERJALAN** — OD diputuskan (DEC-042), dimulai 9 Nov 2026 |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): BIL-FR-001–013, 016. Di luar stage ini (LJT): BIL-FR-014 tagihan kolektif perusahaan, BIL-FR-015 deposit, BIL-FR-017 pajak/e-Faktur |
| Mode verifikasi | Lokal penuh, digabung ke `AtoAIs/atoai-rme-v2` tanpa CI sampai Actions aktif lagi 1 Des 2026 (DEC-036) |

## 1. Tujuan

Kasir menagih kunjungan dan penjualan obat bebas. Tagihan terbentuk otomatis dari konsultasi, tindakan, obat yang diserahkan, dan lab, dengan harga yang dibekukan. Tagihan dibagi antara penjamin dan pasien. Pembayaran dapat memakai beberapa metode sekaligus atau dicicil, dan dicatat dalam shift kasir yang ditutup dengan hitung kas. Void dan refund memerlukan persetujuan orang lain. QRIS berjalan lewat adapter payment gateway dengan callback terverifikasi dan rekonsiliasi harian. Porsi penjamin menjadi piutang, dan transaksi tidak wajar dilaporkan ke manajer.

## 2. Yang Sudah Ada

- **Skema baseline (Stage 3):**
  - `invoice` (CHECK: `net = gross − diskon`, `porsi penjamin + porsi pasien = net`) dan `invoice_line` (CHECK total baris & porsi).
  - `payment`: referensi wajib untuk non-tunai, `idempotency_key` unik.
  - `payment_gateway_txn` (unik per provider + ref), `refund` dan `invoice_void` (penyetuju ≠ pengaju, trigger keputusan final), `cashier_shift` (selisih kas dihitung otomatis), `receivable`.
- **Izin:** `billing.invoice.*`, `billing.payment.create`, `billing.shift.manage`, `billing.refund.*`, `billing.receivable.*`, `billing.reconcile`, `report.finance.*` sudah ada di role KASIR/MANAJER/AUDITOR. Pengaturan klinik `discountLimitPercent` sudah ada sejak Stage 6.
- **Dari Stage 7–10:**
  - Layanan & tarif per cabang/jenis penjamin/penjamin dengan periode berlaku.
  - Kontrak penjamin (`copayPercent`, `plafon`, `paymentTermDays`).
  - Kunjungan dengan penjamin terverifikasi; tindakan (`procedure_act`) dan order lab dari layanan.
  - Baris penyerahan obat dengan harga terkunci berstatus `UNBILLED` (OD-096).
  - Penjualan obat bebas `AWAITING_PAYMENT` (OD-101).
  - Kunjungan berstatus `BILLING` setelah farmasi (alur bawaan) atau setelah konsultasi (alur kasir-dulu).

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Tagihan** | Layanan konsultasi bawaan per poli (OD-105). Worklist kasir: kunjungan `BILLING` dan penjualan bebas menunggu bayar. Draf tagihan otomatis dari konsultasi, tindakan, obat diserahkan, dan lab, dengan **harga snapshot** (urutan tarif OD-106). Pembagian penjamin/pasien sesuai kontrak (OD-108). Baris tambahan dan diskon per baris dengan batas & persetujuan (OD-041). Terbitkan tagihan (nomor OD-110); setelah terbit tidak dapat diubah. Rincian tagihan PDF | BIL-FR-001–004 |
| **2 — Shift & pembayaran** | Buka/tutup shift kasir (OD-111). Pembayaran tunai (kembalian), debit, kartu, dan transfer (wajib referensi). Multi-metode & sebagian → `PARTIALLY_PAID` → `PAID`. Kwitansi PDF 80 mm (OD-109). Lunas → kunjungan selesai (atau ke farmasi pada alur kasir-dulu, OD-107); penjualan bebas → `PAID`. Porsi penjamin → piutang | BIL-FR-005, 007, 008, 011, 013 (pembentukan) |
| **3 — QRIS, void & refund** | Adapter payment gateway + **simulator** (OD-039): QR dinamis, callback ber-signature, idempotensi, kedaluwarsa. Rekonsiliasi harian dengan berkas settlement. Void tagihan belum dibayar dengan persetujuan → tagihan pengganti. Refund dengan alasan & persetujuan (OD-112) | BIL-FR-006, 009, 010, 012 |
| **4 — Piutang, anomali & gate** | Daftar & pelunasan piutang penjamin. Laporan transaksi tidak wajar (OD-041). Verifikasi shift oleh manajer. Uji gate: Σ pembayaran − Σ refund = terbayar untuk seluruh data uji, callback ganda/signature salah, closing shift. Completion report | BIL-FR-013, 016, gate |

Perkiraan: ±1 hari kerja per batch.

## 4. Open Decision Stage 11

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-039** ✅ DEC-042 | Payment gateway QRIS | Bangun **adapter umum + simulator bawaan** (QR, callback ber-signature HMAC, settlement CSV) sehingga seluruh alur dapat diuji tanpa biaya. Penyedia nyata (mis. Midtrans, Xendit, DOKU) **dipilih Bapak sebelum pilot**, karena perlu kontrak merchant & biaya MDR. Adapternya cukup ditambah satu kelas tanpa mengubah alur. Tidak ada dependency berbayar di Stage 11 |
| **OD-040** ✅ DEC-042 | Pajak / e-Faktur | **Tidak ada baris pajak di MVP** (BIL-FR-017 LJT). Tagihan menampilkan "harga sudah final" sesuai OD-082. Status pajak jasa klinik perlu dikonfirmasi ke konsultan pajak klinik pilot; ini bukan nasihat pajak |
| **OD-041** ✅ DEC-042 | Ambang persetujuan & aturan anomali | Diskon per baris > `discountLimitPercent` (bawaan **10%**) perlu persetujuan pemegang `billing.invoice.void.approve` (manajer), tercatat siapa yang menyetujui. **Void & refund selalu** perlu persetujuan orang lain berapa pun nilainya (AC-BIL-FR-009/010). Toleransi selisih kas bawaan **Rp 10.000**; di atas itu wajib keterangan. Anomali: void/refund di luar jam operasional (bawaan **07.00–21.00**), diskon di atas ambang, **> 3** void per kasir per shift, selisih kas di atas toleransi, pembayaran tunai pada tagihan yang sudah lunas via QRIS. Semua nilai dapat diatur di Profil klinik. Hasilnya berupa tanda di laporan, bukan blokir otomatis |
| **OD-105** ✅ DEC-042 | Biaya konsultasi diambil dari mana | Setiap poli punya **layanan konsultasi bawaan** (diatur di master poli). Saat tagihan dibuat, satu baris konsultasi ditambahkan memakai tarif layanan itu. Kasir dapat mengganti layanannya di draf (mis. konsultasi spesialis). Biaya administrasi opsional per cabang, bawaannya tidak ada |
| **OD-106** ✅ DEC-042 | Urutan pemilihan tarif | Tarif berlaku pada tanggal kunjungan dengan prioritas: **penjamin spesifik + cabang → penjamin spesifik → jenis penjamin + cabang → jenis penjamin → cabang → umum**. Layanan tanpa tarif berlaku tidak dapat ditagih; kasir mendapat pesan yang jelas. Obat memakai harga yang sudah dikunci di penyerahan (OD-096) |
| **OD-107** ✅ DEC-042 | Alur kasir-dulu (`pharmacyBeforeCashier = false`) | Kunjungan dari konsultasi masuk kasir, dan tagihan pertama berisi jasa (konsultasi, tindakan, lab). Setelah lunas, kunjungan diteruskan ke farmasi. Obat yang diserahkan kemudian ditagih di **tagihan obat susulan** untuk kunjungan yang sama, dibayar sebelum obat diambil. Alur bawaan (farmasi dulu) cukup satu tagihan |
| **OD-108** ✅ DEC-042 | Pembagian penjamin & pasien | **Umum:** pasien 100%. **Asuransi/Perusahaan:** penjamin menanggung sesuai kontrak (`copayPercent` = porsi pasien, `plafon` per kunjungan; kelebihan plafon → pasien); tanpa kontrak → penjamin 100%. Porsi penjamin menjadi **piutang** dengan jatuh tempo `paymentTermDays` (bawaan 30). **BPJS:** di MVP diperlakukan seperti penjamin dengan porsi 100% dan dicatat sebagai piutang; bridging & klaim BPJS LJT. Kasir dapat mengubah pembagian per baris di draf dengan alasan (tercatat) |
| **OD-109** ✅ DEC-042 | Kwitansi | **PDF lebar 80 mm** (dapat dicetak ke printer thermal dari peramban): nama & kop klinik, nomor kwitansi & tagihan, rincian ringkas, metode bayar, kembalian, kasir, waktu. Rincian tagihan lengkap **PDF A4**. Tanpa driver printer khusus |
| **OD-110** ✅ DEC-042 | Format nomor | Tagihan `INV{YYYY}{MM}{SEQ:6}`, kwitansi `KW{YYYY}{MM}{SEQ:6}`, refund `RF{YYYY}{MM}{SEQ:5}`, per tenant |
| **OD-111** ✅ DEC-042 | Shift kasir | Satu shift terbuka per kasir per cabang, dibuka dengan kas awal. **Pembayaran tidak dapat dicatat tanpa shift terbuka** (AC-BIL-FR-011-1). Kas yang diharapkan = kas awal + pembayaran tunai − refund tunai di shift itu. Saat tutup, kasir menghitung kas fisik; selisih di atas toleransi wajib keterangan. Manajer dapat memverifikasi shift yang ditutup. Shift lupa ditutup tetap terbuka sampai ditutup kasir atau manajer (tercatat) |
| **OD-112** ✅ DEC-042 | Refund | Refund mengacu ke satu pembayaran, maksimal sebesar pembayaran itu dikurangi refund sebelumnya. Metode refund mengikuti metode bayar: tunai dari kas shift; non-tunai/QRIS dicatat sebagai transfer manual dengan referensi. Refund **tidak mengubah** pembayaran asal; status tagihan dihitung ulang. Refund obat tidak mengembalikan stok (retur obat LJT, PHM-FR-015) |
| **OD-113** ✅ DEC-042 | Penjualan obat bebas di kasir | Tagihan dibuat dari penjualan bebas `AWAITING_PAYMENT` (tanpa pasien wajib), dibayar seperti tagihan kunjungan. Lunas → penjualan `PAID`. Void tagihan penjualan bebas mengembalikan status penjualan ke menunggu bayar; pembatalan penjualan tetap di farmasi |

## 5. Gate Stage 11

- [ ] Uji idempotensi: callback ganda dan retry klien tidak mencatat pembayaran ganda
- [ ] Callback dengan signature salah ditolak dan dicatat
- [ ] Total terbayar = Σ pembayaran − Σ refund untuk seluruh data uji; porsi penjamin = piutang
- [x] Harga tagihan tidak berubah saat tarif/harga obat diubah sesudahnya (snapshot) — B03
- [ ] Closing shift & rekonsiliasi teruji
- [ ] Aturan anomali menghasilkan tanda yang benar
- [ ] Matriks permission X01 mencakup semua endpoint baru; uji mutasi kontrol baru terdeteksi
- [ ] PO menyetujui Stage 11

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 9 Nov 2026 | Stage 10 disetujui bersyarat (DEC-041). Rencana & OD Stage 11 disusun | — |
| 9 Nov 2026 | PO menyetujui semua usulan OD Stage 11 (DEC-042); batch 1 dimulai | — |
| 9 Nov 2026 | **Batch 1 selesai** — tagihan: migrasi 0027 (`invoice.kind`, baris tagihan berdiskon/berpembagian, tautan obat ↔ baris tagihan), layanan konsultasi bawaan poli & biaya administrasi cabang, draf otomatis (konsultasi, administrasi, tindakan, lab, obat diserahkan dengan harga terkunci), tarif berprioritas (OD-106), co-pay & plafon penjamin (OD-108), diskon beralasan dengan persetujuan manajer di atas batas (OD-041), tagihan obat susulan (OD-107) & obat bebas (OD-113), terbit bernomor `INV…` lalu terkunci, rincian PDF A4 (OD-109); halaman Kasir › Tagihan & editor tagihan | Integrasi B01–B08, E2E W31, mutasi M90–M99 |
