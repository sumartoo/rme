# HIPAA Security Rule — Gap Assessment

| | |
|---|---|
| Versi | 0.1 — DRAFT (Stage 3) |
| Tanggal | 4 November 2026 |
| Acuan | 45 CFR Part 164 Subpart C (Security Rule yang berlaku) |

> **Pernyataan posisi.** ClinicRME beroperasi di Indonesia dan tidak terikat HIPAA. HIPAA Security Rule dipakai **hanya sebagai kerangka acuan kontrol**. Dokumen ini **bukan** klaim kepatuhan HIPAA, dan istilah "HIPAA compliant" tidak boleh dipakai di materi produk (prinsip roadmap #9, RSK-007).
>
> **Status regulasi.** HHS menerbitkan usulan perubahan besar Security Rule (NPRM, 6 Januari 2025). Per pertengahan 2026 aturan itu belum final; agenda regulasi federal menargetkan tindakan final Juli 2027. Penilaian ini memakai aturan yang berlaku dan mencatat usulan NPRM sebagai arah (kolom "NPRM").

**Status:** ✅ terpenuhi oleh desain/uji · 🟡 sebagian · ❌ belum · ➖ tidak relevan

## 1. Administrative Safeguards — §164.308

| Standar | Kontrol ClinicRME | Status | Gap / tindak lanjut |
|---|---|---|---|
| Security management process — risk analysis | THREAT_MODEL.md (28 ancaman, STRIDE) | ✅ | Ulangi tahunan & saat perubahan besar |
| — risk management | SECURITY_CONTROLS.md; RISK_REGISTER.md | ✅ | — |
| — sanction policy | Bagi staf ClinicRME: kebijakan internal; bagi staf klinik: tanggung jawab klinik | ❌ | Kebijakan internal ClinicRME (Stage 16); panduan untuk klinik |
| — information system activity review | Audit log + laporan akses | 🟡 | Laporan akses & alert pola (Stage 9/15) |
| Assigned security responsibility | PO sebagai penanggung jawab keamanan sementara | 🟡 | Tunjuk penanggung jawab keamanan & PPDP (OD-069) |
| Workforce security / authorization & clearance | Undangan wajib, role, nonaktif mencabut sesi | ✅ | — |
| Information access management | RBAC + cabang + RLS; matriks permission | ✅ | Review akses berkala oleh tenant admin (SC-ORG-04, Stage 6) |
| Security awareness & training | — | ❌ | Materi pelatihan staf klinik (Stage 16); pelatihan internal |
| — log-in monitoring | Audit `LOGIN_FAILED`, lockout | 🟡 | Alert lonjakan (Stage 15) |
| — password management | Argon2id, kebijakan minimum, reset bertoken | ✅ desain | Dibuktikan di PoC |
| Security incident procedures | INCIDENT_RESPONSE_PLAN.md | ✅ desain | Latihan tabletop sebelum go-live |
| Contingency plan — backup, DR, emergency mode | DEPLOYMENT_ARCHITECTURE §5–6 (PITR, HA, prosedur downtime) | 🟡 | Uji restore (Stage 15); DR lintas region (DEC-017) |
| — testing & revision | Uji restore bulanan | ❌ | Stage 15 |
| — applications & data criticality analysis | Aset A1–A9 di threat model | ✅ | — |
| Evaluation (periodik) | Review threat model tahunan; pentest | ❌ | Pentest independen Stage 16 |
| Business associate contracts | Padanan: DPA klinik ↔ ClinicRME; perjanjian dengan sub-prosesor | 🟡 | DPA final (OD-060) |

## 2. Physical Safeguards — §164.310

| Standar | Kontrol | Status | Catatan |
|---|---|---|---|
| Facility access controls | Diwariskan dari Google Cloud | ✅ (diwariskan) | Simpan laporan kepatuhan GCP sebagai bukti |
| Workstation use & security | Tanggung jawab klinik | ➖ / 🟡 | Panduan keamanan perangkat klinik (Stage 16): kunci layar, akun OS terpisah, tidak berbagi login |
| Device & media controls | Tidak ada media fisik di ClinicRME; data di cloud | ✅ | Laptop developer: enkripsi disk, tanpa data produksi |

## 3. Technical Safeguards — §164.312

| Standar | Kontrol | Status | Bukti / gap |
|---|---|---|---|
| Access control — unique user identification | Akun per orang; tidak ada akun bersama | ✅ desain | Larangan akun bersama di ToS & panduan |
| — emergency access procedure | Break-glass platform (teraudit); delegasi akses klinis (Lanjutan) | 🟡 | Prosedur akses darurat klinis (Stage 6) |
| — automatic logoff | Idle 30 menit | ✅ desain | PoC |
| — encryption & decryption | At rest (GCP) + NIK/TOTP terenkripsi aplikasi | ✅ desain | KMS di Stage 4/15 |
| Audit controls | Audit append-only, hash chain | ✅ | T20–T22 |
| Integrity — mechanism to authenticate ePHI | Immutability + content hash + audit chain | ✅ | T07–T09, T21–T22 |
| Person or entity authentication | Google OIDC / password + MFA admin | 🟡 | MFA wajib untuk admin; dokter wajib secara default, dapat dimatikan tenant (OD-024, DEC-019; Stage 6) |
| Transmission security | TLS 1.2+; HSTS | 🟡 | Konfigurasi LB di Stage 15 |

## 4. Organizational & Documentation — §164.314, §164.316

| Standar | Status | Catatan |
|---|---|---|
| Kebijakan & prosedur terdokumentasi | ✅ | `docs/03-security/` |
| Retensi dokumentasi 6 tahun | ✅ | Dokumen di repo (git history) |
| Review & pembaruan berkala | 🟡 | Jadwal review di Stage 17 |

## 5. Arah NPRM 2025 (belum berlaku) vs Desain

| Usulan NPRM | Desain ClinicRME |
|---|---|
| MFA wajib secara luas | MFA wajib admin; dapat diwajibkan tenant untuk semua user — pertimbangkan default wajib untuk dokter |
| Enkripsi ePHI at rest & in transit wajib | Sudah direncanakan |
| Inventaris aset teknologi & peta aliran data | Sebagian (SYSTEM_ARCHITECTURE, DATA_DICTIONARY); inventaris aset formal Stage 15 |
| Pemulihan sistem kritis dalam 72 jam | Target RTO 4 jam |
| Pemindaian kerentanan berkala & pentest tahunan | Direncanakan (SC-SDLC-03, SC-SDLC-06) |
| Verifikasi tahunan keamanan business associate | Padanan: laporan keamanan berkala untuk klinik (DPA) |

## 6. Ringkasan Gap Prioritas

| # | Gap | Rencana |
|---|---|---|
| 1 | Pelatihan & sanksi | Stage 16 |
| 2 | Uji restore & contingency | Stage 15 |
| 3 | Evaluasi independen (pentest) | Stage 16 |
| 4 | DPA final | OD-060 |
| 5 | Penanggung jawab keamanan & PPDP formal | OD-069 |
| 6 | MFA lebih luas | OD-024 |

## Sumber Status NPRM

HIPAA Journal (pembaruan Juli 2026); Physicians Practice (24 Juli 2026); Accountable HQ (status per Maret 2026).
