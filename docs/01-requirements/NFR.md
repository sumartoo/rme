# Non-Functional Requirements — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui |
| Tanggal | 3 November 2026 |
| Stage | 1 |

Target angka disetujui PO pada 3 Nov 2026 (DEC-014) dan menjadi baseline; perubahan melalui CR.

## Performa

| ID | Requirement | Target | Prioritas |
|---|---|---|---|
| NFR-PERF-001 | Latensi API operasi transaksional | p95 < 500 ms | MVP |
| NFR-PERF-002 | Pencarian pasien | p95 < 1 detik pada 1 juta pasien per tenant | MVP |
| NFR-PERF-003 | Muat layar encounter lengkap | < 2 detik | MVP |
| NFR-PERF-004 | Kapasitas awal | 100 tenant, 1.000 user aktif bersamaan | MVP |
| NFR-PERF-005 | Laporan interaktif | < 10 detik untuk rentang ≤ 1 bulan; lebih berat → asinkron | MVP |

## Ketersediaan & Pemulihan

| ID | Requirement | Target | Prioritas |
|---|---|---|---|
| NFR-AVL-001 | Ketersediaan bulanan | 99,5% | MVP |
| NFR-AVL-002 | Jendela maintenance terencana | Di luar jam praktik, diumumkan ≥ 48 jam sebelumnya | MVP |
| NFR-DR-001 | RPO | ≤ 15 menit | MVP |
| NFR-DR-002 | RTO | ≤ 4 jam | MVP |
| NFR-DR-003 | Prosedur downtime klinik | Formulir cadangan + input ulang terdokumentasi | MVP |

## Keamanan & Privasi

| ID | Requirement | Prioritas |
|---|---|---|
| NFR-SEC-001 | 0 kebocoran lintas tenant pada suite test isolasi | MVP |
| NFR-SEC-002 | TLS 1.2+ untuk semua koneksi | MVP |
| NFR-SEC-003 | Enkripsi at rest untuk DB & storage; enkripsi kolom untuk NIK | MVP |
| NFR-SEC-004 | MFA wajib untuk akun admin | MVP |
| NFR-SEC-005 | Sesi idle berakhir otomatis (default 30 menit untuk staf, dapat diatur tenant) | MVP |
| NFR-SEC-006 | Tidak ada PHI di log aplikasi | MVP |
| NFR-SEC-007 | Rate limiting login & API | MVP |
| NFR-SEC-008 | Dependency & secret scanning di CI; tidak ada temuan kritis saat rilis | MVP |
| NFR-SEC-009 | Penetration test independen sebelum go-live | MVP |
| NFR-PRV-001 | Pemberitahuan privasi & consent sesuai UU PDP / PP 33/2026 | MVP |
| NFR-PRV-002 | Hak subjek data (akses, koreksi, pembatasan) dapat dilayani melalui klinik | MVP |
| NFR-PRV-003 | Notifikasi kegagalan pelindungan data mengikuti tenggat yang berlaku | MVP |

## Audit & Retensi

| ID | Requirement | Prioritas |
|---|---|---|
| NFR-AUD-001 | 100% aksi tulis & baca rekam medis tercatat | MVP |
| NFR-AUD-002 | Masa simpan audit log (OD-023) | MVP |
| NFR-RET-001 | Rekam medis disimpan ≥ 25 tahun sejak kunjungan terakhir (REG-03) | MVP |

## Usability & Kompatibilitas

| ID | Requirement | Prioritas |
|---|---|---|
| NFR-UX-001 | Bahasa Indonesia | MVP |
| NFR-UX-002 | Dapat dioperasikan dengan keyboard untuk pendaftaran & SOAP (shortcut) | MVP |
| NFR-UX-003 | Responsif minimal untuk tablet (layar ≥ 768 px) | MVP |
| NFR-UX-004 | Kontras & ukuran teks memenuhi WCAG 2.1 AA untuk layar utama | LJT |
| NFR-CMP-001 | Chrome & Edge, 2 versi terakhir | MVP |
| NFR-CMP-002 | Printer thermal 58/80 mm untuk struk & etiket; A4/A5 untuk dokumen | MVP |
| NFR-AND-001 | Android versi minimum (OD-017) | LJT |

## Operasional

| ID | Requirement | Prioritas |
|---|---|---|
| NFR-OPS-001 | Monitoring, alert, dan error tracking aktif di produksi | MVP |
| NFR-OPS-002 | Deploy tanpa downtime (rolling) | MVP |
| NFR-OPS-003 | Biaya infrastruktur terpantau dengan budget alert | MVP |
| NFR-OPS-004 | Semua data dev/test/staging sintetis | MVP |
