# Stage 9 — Stage Plan

| | |
|---|---|
| Stage | 9 — Clinical Workflow & Rekam Medis |
| Status | **BERJALAN** — batch 1–3 selesai; OD diputuskan (DEC-038) |
| Project Owner | Sumarto |
| Requirement | **MVP saja** (DEC-010): CLN-FR-001, 002, 004–012, 014–023. Di luar stage ini (LJT): CLN-FR-003 peringatan nilai vital, CLN-FR-013 interaksi obat, CLN-FR-024 informed consent tindakan, CLN-FR-025 odontogram, CLN-FR-026 tanda tangan tersertifikasi |
| Mode verifikasi | Lokal sampai GitHub Actions aktif 1 Des (DEC-036) |

## 1. Tujuan

Perawat mencatat tanda vital dan anamnesis awal. Dokter mengisi SOAP dengan template, diagnosis ICD-10, tindakan ICD-9-CM, resep (termasuk racikan), dan order lab. Dokter lalu mengesahkan rekam medis; catatan yang sudah disahkan terkunci dan hanya bisa dikoreksi lewat addendum. Dari kunjungan itu klinik bisa mencetak resume medis, surat keterangan sehat/sakit, dan surat rujukan, lalu meneruskan pasien ke farmasi/kasir.

## 2. Yang Sudah Ada

- **Skema baseline** (Stage 3): `clinical_note` (DRAFT/SIGNED, `content_hash`, `structured` jsonb), `clinical_addendum`, `observation`, `allergy_intolerance`, `condition_dx`, `procedure_act`, `prescription` + `prescription_item` + `prescription_compound_component`, `lab_order` + `lab_order_item` + `lab_result`, `medical_document`, `drug_item` (dengan `ingredients` untuk cek alergi/duplikasi). Semua ber-RLS.
- **Izin** `clinical.record.read/write`, `clinical.vitals.write`, `clinical.note.write/sign/addendum`, `clinical.prescription.write`, `clinical.lab.order`, `clinical.lab.result.write`, `clinical.document.issue`, `document.upload` sudah ada di role template.
- **Dari Stage 7–8:** ICD-10/ICD-9-CM (data contoh, S7-1), favorit diagnosis, layanan & tarif, tenaga kesehatan ber-SIP, satuan, kunjungan dengan status `ARRIVED` dan antrean yang dipanggil, riwayat kunjungan pasien, penyimpanan berkas (GCS emulator), pengaturan `pharmacyBeforeCashier`.
- **Belum ada:** UI/API master obat. `drug_item` baru ada di skema; Stage 7 tidak membuat layarnya (lihat OD-091).

## 3. Batch

| Batch | Isi | Requirement |
|---|---|---|
| **1 — Worklist & pencatatan klinis** | Worklist perawat & dokter per cabang/poli (dari antrean yang dipanggil); status kunjungan `TRIAGED` → `IN_CONSULTATION`. Tanda vital (TD, nadi, napas, suhu, SpO₂, BB, TB, IMT otomatis) dengan batas input wajar. Alergi, riwayat penyakit, obat yang sedang dipakai di tingkat pasien; alergi tampil menonjol di header pasien. SOAP + template per spesialisasi (OD-035). Diagnosis ICD-10 (satu primer, sekunder opsional, baru/lama) dan tindakan ICD-9-CM dengan pelaksana. Layar encounter dokter dengan panel riwayat kunjungan | CLN-FR-001, 002, 004–009, 016 |
| **2 — Pengesahan, addendum & audit baca** | Sahkan rekam medis (OD-034, OD-092): wajib diagnosis primer + SOAP; `content_hash` sha256; trigger DB menolak perubahan catatan SIGNED, juga lewat SQL role aplikasi. Addendum ber-alasan yang juga disahkan. Setiap pembukaan rekam medis tercatat di audit (siapa, pasien, kunjungan). Riwayat rekam medis pasien (catatan + addendum) | CLN-FR-017–019 |
| **3 — Master obat & resep elektronik** | Master obat minimal (OD-091): kode, nama generik/dagang, bentuk, kekuatan, satuan, golongan, zat aktif, dosis maksimal opsional; impor/ekspor seperti master lain. Resep non-racikan & racikan. Peringatan alergi (zat aktif ↔ alergi pasien) dan duplikasi zat aktif dalam satu resep; dokter boleh melanjutkan dengan alasan yang tercatat; validasi format & batas dosis (OD-033). Resep yang disahkan masuk antrean farmasi (layarnya di Stage 10). Selesai konsultasi meneruskan kunjungan ke farmasi atau kasir (OD-094) | CLN-FR-010–012 |
| **4 — Lab, dokumen & gate** | Order lab lewat antarmuka adapter + vendor tiruan (OD-059); input hasil manual atau unggah PDF; hasil tampil di kunjungan & riwayat. Dokumen PDF dengan kop klinik & nomor surat (OD-093): resume medis, surat keterangan sehat & sakit, surat rujukan keluar. Rencana kontrol membuat janji temu. `CLINICAL_SAFETY_REVIEW.md`, uji gate, mutasi baru, completion report | CLN-FR-014, 015, 020–023 |

Perkiraan: ±1 hari kerja per batch, di luar waktu tunggu keputusan dan review medis.

## 4. Open Decision Stage 9

| OD | Pertanyaan | Usulan |
|---|---|---|
| **OD-033** ✅ DEC-038 | Cakupan clinical decision support di MVP | **Terbatas:** (1) peringatan alergi bila zat aktif obat cocok dengan alergi pasien; (2) peringatan duplikasi zat aktif dalam satu resep; (3) validasi format dosis dan batas dosis maksimal **bila** diisi di master obat. Peringatan dapat dilanjutkan dokter dengan alasan wajib yang teraudit. **Tidak** termasuk: interaksi obat, dosis berdasarkan berat badan/umur (CLN-FR-013 LJT). Layar menyatakan bahwa sistem bukan pengganti penilaian klinis |
| **OD-034** ✅ DEC-038 | Mekanisme tanda tangan/pengesahan | **Tanda tangan elektronik tidak tersertifikasi** di MVP: pengesahan oleh user dokter yang login dengan MFA aktif, dikonfirmasi ulang dengan kata sandi atau kode TOTP saat menekan "Sahkan"; dicatat nama dokter, SIP, waktu server, dan `content_hash`. PDF memuat nama dokter, SIP, waktu pengesahan, dan kode verifikasi (bukan gambar tanda tangan). PSrE tersertifikasi tetap LJT (CLN-FR-026). Kekuatan hukumnya **belum diverifikasi** (REG-13) — bukan nasihat hukum |
| **OD-035** ✅ DEC-038 | Template spesialisasi MVP `[REVIEW-MEDIS]` | Empat template: **Umum, Gigi, Anak, Kebidanan**. Semuanya memakai SOAP teks bebas ditambah beberapa isian terstruktur per template (mis. Gigi: elemen gigi & keluhan; Anak: BB/TB untuk umur, imunisasi; Kebidanan: HPHT, usia kehamilan, G-P-A). Template dipilih otomatis dari poli dan dapat diganti dokter. Isi final wajib ditinjau tenaga medis |
| **OD-059** ✅ DEC-038 | Vendor aplikasi lab | Vendor klinik pilot belum diketahui. **Usulan:** antarmuka adapter umum + **vendor tiruan** untuk uji, ditambah input hasil manual dan unggah PDF hasil lab sebagai jalur utama di MVP. Adapter vendor nyata dibuat saat vendor klinik pilot diketahui (sebelum Stage 16). Gate "order & hasil lab teruji dengan sandbox/mock vendor" dipenuhi dengan vendor tiruan |
| **OD-091** ✅ DEC-038 | Master obat: kapan dibuat | **Dimajukan ke Stage 9 dalam bentuk minimal** (tanpa stok, harga, batch, dan KFA), karena resep membutuhkannya. Stage 10 menambah stok, harga jual, batch/kedaluwarsa, konversi satuan khusus obat, dan sinkronisasi KFA |
| **OD-092** ✅ DEC-038 | Siapa mengisi & mengesahkan | Perawat: tanda vital, alergi, anamnesis awal (S). Dokter: SOAP lengkap, diagnosis, tindakan, resep, order lab, dokumen. **Yang mengesahkan:** dokter yang ditugaskan di kunjungan; bila berhalangan, dokter lain yang bertugas di cabang yang sama (sejalan dengan OD-064), tercatat sebagai pengganti. Draft dapat disimpan kapan saja; kunjungan tidak bisa diselesaikan sebelum disahkan |
| **OD-093** ✅ DEC-038 | Pembuatan PDF & nomor surat | PDF dibuat di server dengan library gratis **`pdfmake`** (MIT), disimpan di penyimpanan berkas, bisa diunduh ulang. Nomor surat per tenant per jenis: `{KODE}/{YYYY}/{MM}/{SEQ:4}`, mis. `SKS/2026/11/0001` (sakit), `SKH/...` (sehat), `RJK/...` (rujukan), `RES/...` (resume); pola dapat diubah tenant admin seperti MRN |
| **OD-094** ✅ DEC-038 | Alur setelah dokter selesai | "Selesai konsultasi" (wajib sudah disahkan) → `CONSULT_DONE`, lalu otomatis ke `PHARMACY` bila ada resep, atau ke `BILLING` bila tidak; urutan farmasi/kasir mengikuti pengaturan `pharmacyBeforeCashier` (DEC-013). Layar farmasi dan kasir dibuat di Stage 10 dan 11; di Stage 9 statusnya sudah benar dan terlihat di papan kunjungan. Tindakan ICD-9-CM yang punya layanan bertarif dicatat sebagai item tagihan tertunda untuk Stage 11 |
| **OD-095** ✅ DEC-038 | Review tenaga medis untuk gate (DEC-005, RSK-006) | Review medis **wajib** sebelum gate Stage 9. Usulan: di batch 4 saya siapkan paket review (`CLINICAL_SAFETY_REVIEW.md` + tangkapan layar alur + daftar isian template + teks dokumen). Bapak mencari dokter/perekam medis untuk meninjaunya. Pengembangan tidak menunggu reviewer; yang menunggu hanya persetujuan gate |

## 5. Gate Stage 9

- [ ] Workflow klinis divalidasi tenaga medis (DEC-005, OD-095)
- [x] Catatan SIGNED tidak dapat diubah lewat API maupun SQL role aplikasi — C10, C12, uji SQL T08
- [x] Addendum & hash integritas teruji — C16, C17 (perubahan di luar aplikasi terdeteksi)
- [x] Audit akses baca rekam medis berfungsi — C08, C19
- [ ] Order & hasil lab teruji dengan vendor tiruan
- [ ] Matriks permission X01 mencakup semua endpoint baru
- [ ] Uji mutasi untuk kontrol baru terdeteksi (lokal; di Actions setelah 1 Des)
- [ ] PO menyetujui Stage 9

## 6. Progres

| Tanggal | Isi | Bukti |
|---|---|---|
| 6 Nov 2026 | Stage 8 disetujui (DEC-037); rencana Stage 9 disusun, menunggu keputusan OD | — |
| 6 Nov 2026 | PO menyetujui semua usulan OD (DEC-038) | — |
| 6 Nov 2026 | **Batch 1 — worklist & pencatatan klinis:** modul baru `libs/clinical`. Worklist hari ini per cabang/poli (tampilan perawat & dokter, `mine=true` untuk pasien dokter yang login), tombol Mulai periksa (status Diperiksa, tiket antrean selesai, layar TV diperbarui). Tanda vital per set dengan batas salah ketik `[REVIEW-MEDIS]` dan IMT otomatis (juga dari TB set sebelumnya); set pertama → status Triase. Anamnesis awal oleh perawat (OD-092) dan SOAP dokter dengan If-Match; template Umum/Gigi/Anak/Kebidanan dengan isian terstruktur tervalidasi (OD-035), bawaan dari master poli. Diagnosis ICD-10 (maks. satu primer, versi berlaku), tindakan = layanan + ICD-9-CM opsional dengan pelaksana. Alergi & riwayat penyakit/obat rutin di tingkat pasien, tidak dihapus (nonaktif/salah input wajib alasan); alergi aktif tampil di header & worklist. Layar encounter dengan kunjungan sebelumnya (diagnosis primer & asesmen); setiap pembukaan tercatat `CLINICAL_RECORD_READ` dengan patient_id. Audit perubahan catatan/diagnosis tidak menyalin isi klinis. Semua penulisan ditolak setelah catatan disahkan atau kunjungan selesai/batal (API 409 + trigger DB). Migrasi 0019 (DELETE alergi/riwayat/observasi/catatan dicabut; menu Worklist klinis). UI: Worklist klinis, layar encounter (Ringkasan, Tanda vital, SOAP, Diagnosis & tindakan, Alergi & riwayat), template di master poli | C01–C10, W22, mutasi M39–M43 |
| 6 Nov 2026 | Akses ke `AtoAIs/atoai-rme-v2` dari sesi kerja terputus; atas permintaan PO, repo kerja sementara `sumartoo/rme` (Actions akun pribadi). CI pertama di sana menemukan 2 uji SQL lama (T05, T08b) yang belum menyesuaikan DELETE yang dicabut di 0017/0019 → diperbaiki (PR sumartoo/rme#1); CI hijau dan deploy VPS berhasil (migrasi 0016–0019). Verifikasi lokal kini juga mencakup `test:db`, `check:schema`, worker self-test | — |
| 6 Nov 2026 | **Batch 2 — pengesahan, addendum & riwayat:** Sahkan rekam medis (OD-034): hanya saat pasien Diperiksa; wajib SOAP lengkap + diagnosis primer (422 dengan daftar yang kurang); penandatangan = akun tertaut dokter/dokter gigi/spesialis aktif dengan SIP berlaku; dokter pengganti harus berjadwal di cabang yang sama dan mengisi alasan (OD-092); konfirmasi ulang kata sandi ATAU TOTP (anti-replay), gagal tercatat & dibatasi 5×/15 menit. Disimpan: penandatangan, SIP, cara konfirmasi, waktu server, hash SHA-256 isi kanonik (SOAP, isian template, vital, diagnosis, tindakan, identitas kunjungan & penandatangan). Addendum ber-alasan dengan konfirmasi ulang & hash berantai ke hash catatan; database menolak addendum untuk catatan yang belum disahkan dan menolak perubahan addendum. Verifikasi integritas menghitung ulang hash (perubahan di luar aplikasi terdeteksi). Riwayat rekam medis pasien berhalaman, akses tercatat. Penautan akun yang sudah ada ke tenaga kesehatan di halaman Pengguna. Migrasi 0020. UI: panel Sahkan/terkunci + Periksa integritas + addendum di layar encounter, halaman Riwayat rekam medis | C11–C19, W23, mutasi M44–M49 |
| 6 Nov 2026 | **Batch 3 — master obat & resep:** master obat minimal (OD-091; menu Master data → Obat, izin `pharmacy.drug.*`, impor/ekspor CSV/XLSX dengan zat aktif dipisah `|`): kode, generik/dagang, bentuk, kekuatan, satuan dasar, golongan, zat aktif (huruf kecil), batas dosis per pemberian/per hari opsional `[REVIEW-MEDIS]`, tidak dihapus. Resep elektronik non-racikan & racikan (komponen obat + satuan racikan), nomor `RX{YYYY}{MM}{SEQ:6}`, dosis terstruktur (jumlah × kali/hari → frekuensi), rute, lama hari, jumlah, aturan pakai; draft disimpan selama pasien diperiksa oleh dokter ber-SIP. Peringatan OD-033 (alergi termasuk komponen racikan, duplikasi zat aktif, batas dosis per pemberian & per hari) dihitung setiap simpan dan dihitung ulang saat terbit; dokter melanjutkan dengan alasan per peringatan yang tersimpan di resep. Selesai konsultasi (OD-094): wajib catatan disahkan & semua peringatan beralasan → resep ISSUED (terkunci trigger, termasuk komponen racikan) → Farmasi bila `pharmacyBeforeCashier`, selain itu Kasir; draft kosong dibatalkan. Audit tanpa nama obat. Migrasi 0021 (DELETE obat & resep dicabut). Akun demo `farmasi@demo.test`. UI: Master obat, tab Resep, tombol Selesai konsultasi | C20–C25, W24, mutasi M50–M54 |
