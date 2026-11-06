# Stage 9 — Paket Review Keselamatan Klinis

| | |
|---|---|
| Tujuan | Bahan review tenaga medis untuk gate Stage 9 (DEC-005, OD-095 / DEC-038, RSK-006) |
| Status | **MENUNGGU REVIEWER** — dokter / perekam medis ditunjuk PO |
| Lingkungan | `https://demo.medika.atoai.id` (data SINTETIS) |
| Catatan | Semua isian, batas, dan teks di bawah adalah **usulan awal** tim pengembang dan belum divalidasi tenaga medis. Sistem bukan alat diagnosis. |

## 1. Cara meninjau

1. Login ke demo sebagai `dokter@demo.test`, `perawat@demo.test`, dan `farmasi@demo.test` (password dari PO).
2. Jalankan alur di §2 dengan pasien contoh.
3. Isi kolom **Keputusan reviewer** di setiap tabel: ✅ setuju · ✏️ ubah (tulis usulan) · ❌ tolak.
4. Kembalikan dokumen ini ke PO. Perubahan dicatat sebagai keputusan (DEC) dan dikerjakan sebelum pilot.

## 2. Alur yang ditinjau

| # | Langkah | Layar | Keputusan reviewer |
|---|---|---|---|
| A1 | Perawat membuka Worklist klinis, mengisi tanda vital (IMT otomatis), alergi, keluhan awal (S) | Worklist → Isi vital | |
| A2 | Dokter Mulai periksa, mengisi SOAP dengan template poli, diagnosis ICD-10 (satu primer), tindakan | Layar encounter | |
| A3 | Dokter meresepkan obat/racikan; peringatan alergi/duplikasi/dosis; alasan bila melanjutkan | Tab Resep | |
| A4 | Dokter order lab; hasil diinput manual / unggah PDF / dari konektor tiruan | Tab Lab | |
| A5 | Dokter mengesahkan (konfirmasi kata sandi/TOTP); catatan terkunci; koreksi lewat addendum | Panel Sahkan | |
| A6 | Selesai konsultasi → resep terbit → farmasi/kasir | Panel Sahkan | |
| A7 | Resume medis, surat sakit/sehat, surat rujukan (PDF); jadwal kontrol | Tab Dokumen & kontrol | |

## 3. Template klinis (OD-035) — `libs/clinical/src/lib/templates.ts`

Semua template memakai SOAP teks bebas ditambah isian terstruktur berikut.

| Template | Isian terstruktur | Keputusan reviewer |
|---|---|---|
| Semua | Keadaan umum (Baik / Tampak sakit ringan / sedang / berat); Kesadaran (Compos mentis / Apatis / Somnolen / Sopor / Koma) | |
| Gigi | Elemen gigi (notasi FDI), pemeriksaan intraoral, pemeriksaan ekstraoral | |
| Anak | Lingkar kepala (20–70 cm), status imunisasi (Lengkap sesuai usia / Belum lengkap / Tidak diketahui), catatan imunisasi, tumbuh kembang | |
| Kebidanan | HPHT, Gravida/Para/Abortus (0–20), usia kehamilan (0–45 minggu), TFU (0–50 cm), DJJ (50–250 x/menit) | |

## 4. Batas input tanda vital — `libs/clinical/src/lib/clinical.schemas.ts`

Batas ini **hanya menolak salah ketik** yang mustahil secara fisiologis. Batas ini bukan peringatan nilai abnormal; peringatan nilai abnormal (CLN-FR-003) masuk tahap lanjutan.

| Tanda vital | Satuan | Batas input | Keputusan reviewer |
|---|---|---|---|
| TD sistolik | mmHg | 40–300 (harus > diastolik) | |
| TD diastolik | mmHg | 20–200 | |
| Nadi | x/menit | 20–300 | |
| Napas | x/menit | 4–80 | |
| Suhu | °C | 30–45 | |
| SpO₂ | % | 50–100 | |
| Berat badan | kg | 0,3–400 | |
| Tinggi badan | cm | 20–250 | |
| Skala nyeri | 0–10 | 0–10 | |
| IMT | kg/m² | dihitung BB / (TB/100)², 1 desimal | |

## 5. Pengesahan & integritas (OD-034, OD-092)

| Aturan | Keputusan reviewer |
|---|---|
| Wajib terisi sebelum disahkan: S, O, A, P dan satu diagnosis primer | |
| Pengesah: dokter / dokter gigi / spesialis aktif dengan SIP berlaku; konfirmasi ulang kata sandi atau kode autentikator | |
| Dokter pengganti: dokter lain yang berjadwal di cabang yang sama, alasan wajib | |
| Setelah disahkan: SOAP, vital, diagnosis, tindakan terkunci; koreksi lewat addendum beralasan (catatan asli tetap) | |
| Hash SHA-256 isi rekam medis + verifikasi ulang; tanda tangan elektronik **tidak tersertifikasi** (kekuatan hukum belum diverifikasi, REG-13) | |

## 6. Peringatan resep (OD-033) — `libs/clinical/src/lib/prescription.repo.ts`

| Peringatan | Cara kerja | Keputusan reviewer |
|---|---|---|
| Alergi | Zat aktif obat/komponen racikan cocok (sebagian kata) dengan alergi aktif pasien kategori Obat/Lainnya | |
| Duplikasi | Zat aktif yang sama di lebih dari satu baris (atau dua kali dalam satu racikan) | |
| Dosis per pemberian | Jumlah per pemberian > batas di master obat (bila diisi) | |
| Dosis per hari | Jumlah × kali/hari > batas di master obat (bila diisi) | |
| Melanjutkan | Dokter boleh melanjutkan dengan alasan (min. 5 huruf) per peringatan; tersimpan di resep & dihitung ulang saat terbit | |
| Tidak tercakup | Interaksi obat, dosis per berat badan/umur, kontraindikasi kehamilan (CLN-FR-013 lanjutan) | |

## 7. Lab & dokumen (OD-059, OD-093)

| Aturan | Keputusan reviewer |
|---|---|
| Order lab hanya untuk layanan berjenis Lab, saat pasien diperiksa, oleh dokter | |
| Hasil: input manual (hasil, satuan, nilai rujukan, penanda N/L/H/LL/HH/A), unggah PDF, atau dari konektor; hasil tidak dapat diubah, koreksi = hasil baru | |
| Dokumen hanya dari rekam medis yang disahkan; nomor `{KODE}/{YYYY}/{MM}/{SEQ:4}` (RES, SKS, SKH, RJK) | |
| Surat sakit: diagnosis **tidak** dicantumkan kecuali dicentang (atas persetujuan pasien) | |
| Teks surat (lihat PDF contoh di demo) — kalimat baku surat sakit/sehat & susunan resume/rujukan | |
| PDF memuat nama & SIP dokter, waktu terbit, kode verifikasi, dan pernyataan "tanda tangan elektronik tidak tersertifikasi" | |

## 8. Risiko terbuka

| Risiko | Mitigasi saat ini | Tindak lanjut |
|---|---|---|
| RSK-006: validasi klinis oleh non-tenaga medis | Paket review ini; label `[REVIEW-MEDIS]` di kode & dokumen | Review sebelum gate Stage 9 |
| Data ICD masih contoh (S7-1) | Data berlabel CONTOH | Lisensi & data resmi sebelum pilot |
| Peringatan resep terbatas | Pernyataan di layar "sistem bukan pengganti penilaian klinis" | CDS lanjutan setelah pilot |
| Konektor lab nyata belum ada | Konektor tiruan + input manual / PDF | Adapter vendor klinik pilot sebelum Stage 16 |

## 9. Tanda tangan reviewer

| Nama | Profesi / STR | Tanggal | Kesimpulan |
|---|---|---|---|
| | | | ☐ Layak dengan catatan ☐ Perlu perubahan |
