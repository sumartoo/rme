# Open Decisions Register — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 |
| Tanggal | 3 November 2026 |

Daftar induk semua OPEN DECISION. Setelah diputuskan, keputusan dicatat di `DECISION_LOG.md` dan status di sini diubah.

## A. Harus Diputuskan di Stage 0 (penentu gate)

| ID | Pertanyaan | Opsi | Rekomendasi | Status |
|---|---|---|---|---|
Semua keputusan penentu Stage 0 sudah diambil — lihat bagian D.

## B. Perlu Data / Tindakan di Stage 0–1

| ID | Pertanyaan | Tindakan |
|---|---|---|
| OD-020 | Model harga: per cabang, per user, per kunjungan, atau kombinasi? | Survei 3–5 calon pelanggan |
| OD-056 | Kapasitas tim & target waktu | Tetapkan jumlah orang & jam per minggu |
| OD-057 | Anggaran awal (infra, pentest, vendor) | Estimasi di Stage 1–2 |
| OD-058 | Akun sandbox SATUSEHAT | Daftar di portal developer SATUSEHAT |
| OD-059 | Vendor aplikasi lab di klinik pilot | Kumpulkan dari klinik pilot |
| OD-060 | Bentuk Data Processing Agreement klinik ↔ ClinicRME | Konsultasi hukum |

## B2. Baru dari Stage 3

| ID | Pertanyaan | Usulan |
|---|---|---|
| OD-067 | Peran para pihak untuk aplikasi pasien | Stage 13 |
| OD-068 | Perilaku pembatasan pemrosesan atas permintaan pasien | Stage 8 |
| OD-069 | Penunjukan PPDP ClinicRME | Sebelum pilot |
| OD-070 | Model harga & teknis penyimpanan arsip setelah tenant berhenti | Stage 5 / 15 |

## B3. Baru dari Stage 4

| ID | Pertanyaan | Usulan |
|---|---|---|

## B4. Baru dari Stage 5 (menunggu PO)

| ID | Pertanyaan | Usulan |
|---|---|---|

## C. Ditetapkan di Stage Berikutnya

Lihat `docs/APP_DESIGN.md` §13 dan masing-masing `docs/stages/STAGE_XX_*.md` (OD-003 s.d. OD-054).

## D. Sudah Diputuskan

| ID | Keputusan | Ref |
|---|---|---|
| OD-003 | Nx `enforce-module-boundaries` | ADR-0001 |
| OD-005 | Nx + pnpm | ADR-0001 |
| OD-010 | Google OIDC + email/password di NestJS | ADR-0003 |
| OD-055 | Project Owner: Sumarto | DEC-004 |
| OD-019 | Clinical advisor sementara: Sumarto; review tenaga medis wajib sebelum gate Stage 9 | DEC-005 |
| OD-001 | BPJS masuk scope sebagai Lanjutan | DEC-006 |
| OD-002 | Telemedicine tidak masuk scope versi pertama | DEC-007 |
| OD-018 | Stage 3 = desain + PoC | DEC-008 |
| OD-036 | Integrasi lab di Stage 9 | DEC-009 |
| OD-061 | MVP-first | DEC-010 |
| OD-008 | Farmasi → kasir, konfigurabel | DEC-013 |
| OD-022 | Pasien lintas cabang dalam tenant | DEC-013 |
| OD-063 | Resep parsial ditagih sesuai yang diserahkan | DEC-013 |
| OD-064 | Substitusi oleh dokter lain yang bertugas di cabang sama | DEC-013 |
| OD-065 | Lab ditagih kasir klinik (default) | DEC-013 |
| OD-015 / OD-016 | SLA 99,5%, RPO 15 menit, RTO 4 jam | DEC-014 |
| OD-004 | Monorepo Nx | ADR-0001/0009 |
| OD-006 | Terraform | DEC-016 |
| OD-007 | Shared schema + RLS | DEC-016 |
| OD-009 | Tanpa FHIR API publik di MVP | DEC-016 |
| OD-013 / OD-046 | shadcn/ui + Tailwind + Recharts | DEC-016 |
| OD-047 | Laporan di DB utama; read replica saat perlu | DEC-016 |
| OD-054 | Drizzle ORM | DEC-016 |
| OD-011 | CMEK tidak di MVP | DEC-019 |
| OD-023 | Audit RM ≥ 25 th; keuangan & stok 10 th; login & admin 2 th | DEC-019 |
| OD-024 | MFA dokter wajib secara default, dapat dimatikan tenant (Stage 6) | DEC-019 |
| OD-066 | Pemindaian malware wajib sebelum produksi | DEC-019 |
| OD-025 | GitHub Actions | DEC-021 |
| OD-026 | Pemindai gratis: gitleaks, osv-scanner, pnpm audit, Semgrep CE | DEC-021 (Trivy: lihat OD-026a) |
| OD-071 | `db/migrations/` sumber kebenaran skema | DEC-021 |
| OD-072 | Node 22, TS 5.9, NestJS 11, Next 16, Nx 24 | DEC-021 |
| OD-073 | PostgreSQL service container untuk uji | DEC-021 |
| OD-074 | Worker memakai role owner sampai Stage 15 | DEC-021 |
| OD-026a | Scan image dengan osv-scanner, bukan Trivy | DEC-022 |
| OD-027 | Invoice manual untuk pilot; penagihan otomatis (PLT-FR-012) Lanjutan | DEC-025 |
| OD-028 | Ekspor: NDJSON per tabel + manifest sha256, arsip AES-256-GCM; FHIR Bundle Stage 12 | DEC-025 |
| OD-075 | Identitas platform sesuai CR-0001 | DEC-025 |
| OD-076 | Break-glass: email ke semua tenant admin + audit tenant | DEC-025 |
| OD-077 | Support melihat daftar user & log audit tenant lewat konsol platform (fungsi DB ber-grant, teraudit); tanpa data pasien | DEC-026 |
| OD-078 | Undangan dapat diterima lewat Google atau dengan membuat password | DEC-029 |
| OD-079 | Daftar password umum: SecLists NCSC 100k (MIT), entri ≥ 10 karakter, dibundel | DEC-029 |
| OD-080 | MFA per role diatur tenant admin; TENANT_ADMIN & MANAJER selalu wajib | DEC-029 |
| OD-029 | Sesi saat jam jaga berakhir — ditunda bersama IAM-FR-012 (LJT) | DEC-028 |
