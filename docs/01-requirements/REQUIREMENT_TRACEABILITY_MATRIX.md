# Requirement Traceability Matrix — ClinicRME SaaS

| | |
|---|---|
| Versi | 0.1 — dibangkitkan dari SRS.md & NFR.md |
| Tanggal | 3 November 2026 |

> Dibangkitkan oleh `tools/gen_rtm.py` dari SRS, NFR, WORKFLOWS, USE_CASES, ACCEPTANCE_CRITERIA, komentar tabel di `db/schema/*.sql`, dan `x-requirements` di `api/openapi.yaml`. Kolom Test Case & Status Test diisi mulai Stage 4. Jangan edit file ini manual.

**Ringkasan:** 223 requirement — MVP 181, Lanjutan 42, perlu review medis 19. Requirement MVP dengan acceptance criteria: 181/181. Requirement fungsional MVP dengan API/mekanisme: 147/147; dengan tabel tertaut: 147/147.

| Req ID | Ringkasan | Prioritas | Stage | Workflow | Review Medis | Use Case | Acceptance Criteria | Tabel | API / Mekanisme | Test Case | Status Test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GEN-FR-001 | Semua data milik tenant hanya dapat diakses oleh pengguna tenant tersebut. | MVP | Semua |  |  |  | AC-GEN-FR-001-1..2 | semua tabel tenant (RLS) | Semua (RLS) | | |
| GEN-FR-002 | Semua aksi tulis dicatat di audit log (siapa, apa, kapan, dari mana). | MVP | Semua |  |  |  | AC-GEN-FR-002-1 | audit_log | Semua (audit) | | |
| GEN-FR-003 | Data klinis dan transaksi yang telah disahkan tidak dapat dihapus atau diubah; koreksi ... | MVP | Semua |  |  |  | AC-GEN-FR-003-1..2 | clinical_note, invoice, payment, refund, stock_movement | Semua (trigger immutability) | | |
| GEN-FR-004 | Setiap daftar data mendukung pencarian, filter, sortir, dan paginasi. | MVP | Semua |  |  |  | AC-GEN-FR-004-1 | semua tabel daftar | Semua endpoint daftar | | |
| GEN-FR-005 | Antarmuka berbahasa Indonesia; format tanggal `dd/MM/yyyy`, mata uang Rupiah, zona wakt... | MVP | Semua |  |  |  | AC-GEN-FR-005-1..2 | branch | Semua | | |
| GEN-FR-006 | Setiap dokumen bisnis memiliki nomor unik berformat dapat dikonfigurasi per tenant (MRN... | MVP | Semua |  |  |  | AC-GEN-FR-006-1..2 | document_sequence | app.next_document_number() | | |
| GEN-FR-007 | Perubahan bersamaan pada data yang sama terdeteksi (optimistic locking) dan pengguna di... | MVP | Semua |  |  |  | AC-GEN-FR-007-1 | semua tabel dengan kolom version | Semua (If-Match) | | |
| PLT-FR-001 | Platform admin membuat tenant baru beserta tenant admin pertama (undangan email). | MVP | 5 | WF-14 |  | UC-PLT-01 | AC-PLT-FR-001-1 | tenant | platformTenantCreate, platformTenantList | | |
| PLT-FR-002 | Tenant memiliki tipe: Klinik Utama, Klinik Pratama, Praktik Mandiri. | MVP | 5 |  |  | UC-PLT-01 | AC-PLT-FR-002-1 | tenant | platformTenantCreate | | |
| PLT-FR-003 | Tenant memiliki paket langganan dengan batas user, cabang, dan fitur. | MVP | 5 |  |  | UC-PLT-01 | AC-PLT-FR-003-1 | subscription_plan | platformPlanList, platformTenantCreate | | |
| PLT-FR-004 | Sistem menegakkan kuota paket di backend; penolakan menampilkan pesan yang jelas. | MVP | 5 |  |  | UC-IAM-01 | AC-PLT-FR-004-1 | app_user, branch, subscription_plan, tenant_subscription | userInvite, branchCreate | | |
| PLT-FR-005 | Tenant memiliki status: Trial, Aktif, Grace, Suspended, Terminated; setiap perubahan te... | MVP | 5 |  |  | UC-PLT-02 | AC-PLT-FR-005-1 | tenant, tenant_status_history | platformTenantStatus | | |
| PLT-FR-006 | Saat Suspended, hanya tenant admin yang dapat login untuk pembayaran/ekspor. | MVP | 5 |  |  | UC-PLT-02 | AC-PLT-FR-006-1 | tenant, user_session | platformTenantStatus | | |
| PLT-FR-007 | Tenant admin mengatur profil klinik: nama, alamat, izin, logo, kop surat. | MVP | 5 |  |  | UC-PLT-03 | AC-PLT-FR-007-1 | tenant | tenantProfileGet, tenantProfileUpdate | | |
| PLT-FR-008 | Tenant dapat meminta ekspor seluruh data; hasil berupa arsip terenkripsi dengan tautan ... | MVP | 5 |  |  | UC-PLT-04 | AC-PLT-FR-008-1..2 | tenant_export_job | tenantExportCreate, tenantExportGet | | |
| PLT-FR-009 | Superadmin tidak dapat membuka data klinis tenant; akses dukungan hanya via break-glass... | MVP | 5 |  |  | UC-PLT-05 | AC-PLT-FR-009-1..2 | support_access_grant | platformSupportAccess | | |
| PLT-FR-010 | Subdomain per tenant (`klinikabc.clinicrme.id`). | LJT | 5 |  |  |  |  |  |  | | |
| PLT-FR-011 | Feature flag per tenant. | MVP | 5 |  |  | UC-PLT-01 | AC-PLT-FR-011-1 | tenant_feature_flag | platformFeatureFlag | | |
| PLT-FR-012 | Penagihan langganan otomatis via payment gateway. | LJT | 5 |  |  |  |  |  |  | | |
| PLT-FR-013 | Kebijakan penanganan data tenant Terminated mengikuti kewajiban retensi rekam medis (da... | MVP | 5 |  |  | UC-PLT-02 | AC-PLT-FR-013-1 | tenant, tenant_status_history | platformTenantStatus | | |
| IAM-FR-001 | User hanya dapat dibuat melalui undangan dari tenant admin (email, role, cabang). | MVP | 3, 6 |  |  | UC-IAM-01 | AC-IAM-FR-001-1..2 | app_user, user_invitation | invitationGet, userList, userInvite | | |
| IAM-FR-002 | Login dengan Google (OIDC); akun Google harus cocok dengan undangan aktif saat penautan... | MVP | 3, 6 |  |  | UC-IAM-02 | AC-IAM-FR-002-1..3 | user_identity | authGoogleStart, authGoogleCallback | | |
| IAM-FR-003 | Login dengan email + password; kebijakan password minimum & lockout setelah N kali gagal. | MVP | 3, 6 |  |  | UC-IAM-03 | AC-IAM-FR-003-1..2 | user_credential | authPasswordLogin | | |
| IAM-FR-004 | Reset password via tautan email bertoken berbatas waktu. | MVP | 3, 6 |  |  | UC-IAM-04 | AC-IAM-FR-004-1 | user_credential | authPasswordResetRequest, authPasswordResetConfirm | | |
| IAM-FR-005 | MFA TOTP wajib untuk role admin tenant & platform; opsional per tenant untuk role lain. | MVP | 3, 6 |  |  | UC-IAM-02, UC-IAM-03 | AC-IAM-FR-005-1..2 | user_mfa | authMfaVerify, authMfaEnroll | | |
| IAM-FR-006 | Tenant dapat membatasi login Google ke domain tertentu. | LJT | 3, 6 |  |  |  |  |  |  | | |
| IAM-FR-007 | Role template bawaan: Tenant Admin, Dokter, Perawat/Bidan, Pendaftaran, Farmasi, Kasir,... | MVP | 3, 6 |  |  | UC-IAM-05 | AC-IAM-FR-007-1 | role | roleList | | |
| IAM-FR-008 | Tenant admin membuat role custom dari daftar permission. | MVP | 3, 6 |  |  | UC-IAM-05 | AC-IAM-FR-008-1 | permission, role | roleCreate, roleUpdate, permissionList | | |
| IAM-FR-009 | User ditugaskan ke satu atau lebih cabang; saat login memilih cabang aktif. | MVP | 3, 6 |  |  | UC-IAM-01, UC-IAM-02 | AC-IAM-FR-009-1 | user_role_assignment | meGet, meSelectBranch | | |
| IAM-FR-010 | Menu aplikasi tampil sesuai permission efektif user di cabang aktif. | MVP | 3, 6 |  |  | UC-IAM-05 | AC-IAM-FR-010-1 | menu_item | meGet, meMenu | | |
| IAM-FR-011 | Setiap endpoint memeriksa permission di backend, terlepas dari menu. | MVP | 3, 6 |  |  | UC-IAM-05 | AC-IAM-FR-011-1..2 | permission, role_permission, user_role_assignment | permissionList | | |
| IAM-FR-012 | Jadwal login berdasarkan hari & jam jaga (dapat diaktifkan per role/user). | LJT | 3, 6 |  |  |  |  |  |  | | |
| IAM-FR-013 | User melihat & mencabut sesi aktifnya; admin dapat mencabut sesi user lain. | MVP | 3, 6 |  |  | UC-IAM-06 | AC-IAM-FR-013-1 | user_session | meSessions, meRevokeSession, userRevokeAllSessions | | |
| IAM-FR-014 | Menonaktifkan user mencabut seluruh sesinya seketika. | MVP | 3, 6 |  |  | UC-IAM-06 | AC-IAM-FR-014-1 | user_session | userDisable | | |
| IAM-FR-015 | Delegasi akses sementara (mis. dokter pengganti) dengan masa berlaku & persetujuan. | LJT | 3, 6 |  |  |  |  |  |  | | |
| IAM-FR-016 | User dapat ditautkan ke data tenaga kesehatan (dokter/perawat) untuk tanda tangan klinis. | MVP | 3, 6 |  |  | UC-IAM-01 | AC-IAM-FR-016-1 | app_user, practitioner | userInvite, encounterSign | | |
| AUD-FR-001 | Audit log mencatat aksi tulis, login/logout, gagal login, export, dan perubahan permiss... | MVP | 3 |  |  | UC-PLT-05, UC-AUD-01 | AC-AUD-FR-001-1 | audit_log | authLogout, auditSearch | | |
| AUD-FR-002 | Audit log mencatat akses **baca** rekam medis pasien. | MVP | 3 |  |  | UC-AUD-01, UC-CLN-02 | AC-AUD-FR-002-1 | audit_log | auditSearch, patientGet, encounterChart | | |
| AUD-FR-003 | Audit log tidak dapat diubah/dihapus melalui aplikasi; integritas diverifikasi dengan h... | MVP | 3 |  |  | UC-AUD-01 | AC-AUD-FR-003-1..2 | audit_log | DB: trigger + app.write_audit() | | |
| AUD-FR-004 | Auditor/admin mencari audit log berdasarkan user, pasien, aksi, rentang waktu. | MVP | 3 |  |  | UC-AUD-01 | AC-AUD-FR-004-1 | audit_log | auditSearch | | |
| AUD-FR-005 | Pasien (melalui klinik) dapat memperoleh daftar siapa yang mengakses rekam medisnya. | LJT | 3 |  |  |  |  |  |  | | |
| MST-FR-001 | CRUD fasilitas, cabang, unit/poli, ruang layanan, lokasi farmasi. | MVP | 7 |  |  | UC-MST-01 | AC-MST-FR-001-1 | service_unit | branchList, branchCreate, unitList, unitCreate | | |
| MST-FR-002 | CRUD tenaga kesehatan: nama, NIK, jenis, spesialisasi, STR, SIP & masa berlaku. | MVP | 7 |  |  | UC-MST-02 | AC-MST-FR-002-1 | practitioner | practitionerList, practitionerCreate, practitionerUpdate | | |
| MST-FR-003 | Peringatan STR/SIP yang akan kedaluwarsa. | LJT | 7 |  |  |  |  |  |  | | |
| MST-FR-004 | CRUD layanan: konsultasi, tindakan, paket, administrasi. | MVP | 7 |  |  | UC-MST-03 | AC-MST-FR-004-1 | service_item | serviceItemList, serviceItemCreate | | |
| MST-FR-005 | Tarif per layanan × cabang × kategori penjamin dengan periode berlaku. | MVP | 7 | WF-03 |  | UC-MST-03 | AC-MST-FR-005-1..2 | tariff | tariffList, tariffCreate | | |
| MST-FR-006 | CRUD penjamin: Umum, Asuransi (nama, kode), Perusahaan (kontrak). | MVP | 7 | WF-04 |  | UC-MST-04 | AC-MST-FR-006-1 | payer | payerList, payerCreate | | |
| MST-FR-007 | Satuan & konversi (mis. 1 box = 10 strip = 100 tablet). | MVP | 7 |  |  | UC-MST-05 | AC-MST-FR-007-1 | uom | uomList | | |
| MST-FR-008 | Impor/ekspor Excel/CSV dengan dry-run dan laporan error per baris. | MVP | 7 |  |  | UC-MST-05 | AC-MST-FR-008-1..3 | semua tabel master | masterImport, masterExport | | |
| MST-FR-009 | Perubahan master tercatat (before/after). | MVP | 7 |  |  | UC-MST-01, UC-MST-02, UC-MST-03 | AC-MST-FR-009-1 | audit_log | practitionerUpdate | | |
| MST-FR-010 | Master supplier obat. | MVP | 7 |  |  | UC-MST-05 | AC-MST-FR-010-1 | supplier | supplierList | | |
| MST-FR-011 | Wilayah administratif (provinsi–kelurahan) untuk alamat pasien. | MVP | 7 |  |  | UC-MST-05 | AC-MST-FR-011-1 | branch, patient, region | regionList | | |
| TRM-FR-001 | ICD-10 tersedia dengan kode asli, display Bahasa Indonesia, dan versi sumber. | MVP | 7 |  |  | UC-TRM-01 | AC-TRM-FR-001-1 | code_system, concept | conceptSearch | | |
| TRM-FR-002 | ICD-9-CM (subset tindakan) tersedia dengan kode asli & versi. | MVP | 7 |  |  | UC-TRM-01 | AC-TRM-FR-002-1 | code_system | conceptSearch | | |
| TRM-FR-003 | Tenant dapat menandai diagnosis/tindakan favorit; subset divalidasi tenaga medis. | MVP | 7 |  | Ya | UC-TRM-01 | AC-TRM-FR-003-1 | tenant_concept_favorite | conceptFavorite | | |
| TRM-FR-004 | Pencarian kode berdasarkan kode atau kata kunci (sinonim). | MVP | 7 |  |  | UC-TRM-01 | AC-TRM-FR-004-1 | concept | conceptSearch | | |
| TRM-FR-005 | Referensi obat menggunakan KFA SATUSEHAT. | MVP | 7 |  |  | UC-CLN-03 | AC-TRM-FR-005-1 | drug_item | conceptSearch, prescriptionSave | | |
| REG-FR-001 | Registrasi pasien baru dengan MRN otomatis. Data wajib minimal: nama, tanggal lahir, je... | MVP | 8 | WF-01 | Ya | UC-REG-01 | AC-REG-FR-001-1..2 | patient | patientCreate, patientUpdate | | |
| REG-FR-002 | Pasien tanpa NIK (bayi baru lahir, WNA, tanpa identitas) dapat didaftarkan dengan ident... | MVP | 8 | WF-01 |  | UC-REG-01 | AC-REG-FR-002-1 | patient | patientCreate | | |
| REG-FR-003 | Pencarian pasien berdasarkan nama (toleran salah ketik), NIK, MRN, telepon, tanggal lahir. | MVP | 8 |  |  | UC-REG-02 | AC-REG-FR-003-1..2 | patient | patientSearch | | |
| REG-FR-004 | Sistem menampilkan kandidat duplikat sebelum pasien baru disimpan. | MVP | 8 |  |  | UC-REG-01 | AC-REG-FR-004-1..2 | patient | patientCreate, patientDuplicateCheck | | |
| REG-FR-005 | Penggabungan (merge) dua rekam pasien dengan permission khusus, tanpa menghapus data, t... | MVP | 8 |  |  | UC-REG-03 | AC-REG-FR-005-1..2 | encounter, patient | patientMerge | | |
| REG-FR-006 | Kontak darurat & wali (relasi, nama, telepon). | MVP | 8 |  |  | UC-REG-01 | AC-REG-FR-006-1 | patient_contact | patientCreate, patientUpdate | | |
| REG-FR-007 | Penjamin pasien: Umum / Asuransi (no. polis, masa berlaku) / Perusahaan (no. karyawan).... | MVP | 8 |  |  | UC-REG-01 | AC-REG-FR-007-1 | patient_coverage | patientCreate, patientUpdate | | |
| REG-FR-008 | Consent umum pasien tercatat dengan versi dokumen & waktu. | MVP | 8 |  | Ya | UC-REG-01 | AC-REG-FR-008-1 | patient_consent | patientConsentRecord | | |
| REG-FR-009 | Data NIK disimpan terenkripsi; pencarian NIK tidak membuka nilai asli di log. | MVP | 8 |  |  | UC-REG-01 | AC-REG-FR-009-1 | patient | patientCreate | | |
| REG-FR-010 | Cetak kartu pasien / label. | LJT | 8 |  |  |  |  |  |  | | |
| REG-FR-011 | Lookup nomor IHS SATUSEHAT berdasarkan NIK saat registrasi. | MVP | 8 | WF-01 |  | UC-REG-01 | AC-REG-FR-011-1 | fhir_sync_record, patient | patientCreate | | |
| REG-FR-012 | Pasien dapat dipakai lintas cabang dalam satu tenant. | MVP | 8 |  |  | UC-REG-02 | AC-REG-FR-012-1 | patient | patientSearch, patientGet | | |
| SCH-FR-001 | Jadwal praktik dokter per cabang/poli: hari, jam, kuota. | MVP | 8 |  |  | UC-SCH-01 | AC-SCH-FR-001-1 | practitioner_schedule | scheduleList, scheduleCreate | | |
| SCH-FR-002 | Pengecualian jadwal (cuti, libur). | MVP | 8 |  |  | UC-SCH-01 | AC-SCH-FR-002-1 | schedule_exception | scheduleExceptionCreate | | |
| SCH-FR-003 | Appointment oleh petugas berdasarkan slot & kuota. | MVP | 8 | WF-02 |  | UC-SCH-02 | AC-SCH-FR-003-1 | appointment | slotList, appointmentCreate, appointmentList | | |
| SCH-FR-004 | Appointment mandiri oleh pasien via Android. | LJT | 8 |  |  |  |  |  |  | | |
| SCH-FR-005 | Walk-in langsung menghasilkan kunjungan & nomor antrean. | MVP | 8 | WF-01 |  | UC-SCH-03 | AC-SCH-FR-005-1 | encounter, queue_counter, queue_ticket | encounterWalkIn | | |
| SCH-FR-006 | Check-in appointment mengubah status menjadi hadir & memberi nomor antrean. | MVP | 8 | WF-02 |  | UC-SCH-03 | AC-SCH-FR-006-1 | appointment, encounter, queue_ticket | appointmentCheckIn | | |
| SCH-FR-007 | Nomor antrean unik per cabang/poli/hari, aman terhadap pendaftaran bersamaan. | MVP | 8 |  |  | UC-SCH-03 | AC-SCH-FR-007-1 | queue_counter, queue_ticket | appointmentCheckIn, encounterWalkIn | | |
| SCH-FR-008 | Panggil, lewati, panggil ulang antrean; tampilan layar TV real-time. | MVP | 8 |  |  | UC-SCH-04 | AC-SCH-FR-008-1..2 | queue_ticket | queueCall, queueSkip, queueBoard | | |
| SCH-FR-009 | Suara panggilan antrean. | LJT | 8 |  |  |  |  |  |  | | |
| SCH-FR-010 | Pembatalan & reschedule appointment dengan alasan. | MVP | 8 |  |  | UC-SCH-02 | AC-SCH-FR-010-1 | appointment | appointmentCancel, appointmentReschedule, encounterCancel | | |
| SCH-FR-011 | Auto no-show setelah batas waktu yang dapat dikonfigurasi. | MVP | 8 | WF-02 |  | UC-SCH-05 | AC-SCH-FR-011-1 | appointment | Job worker (no-show) | | |
| SCH-FR-012 | Pengingat appointment ke pasien (tanpa informasi medis). | LJT | 8 |  |  |  |  |  |  | | |
| SCH-FR-013 | Status kunjungan terlihat di papan kerja: Terdaftar → Hadir → Triase → Diperiksa → Farm... | MVP | 8 |  |  | UC-SCH-03 | AC-SCH-FR-013-1 | encounter | encounterBoard | | |
| CLN-FR-001 | Worklist dokter: daftar pasien antre untuk dokter & cabang aktif. | MVP | 9 |  |  | UC-CLN-02 | AC-CLN-FR-001-1 | encounter | encounterBoard, encounterChart | | |
| CLN-FR-002 | Perawat merekam tanda vital: TD, nadi, napas, suhu, SpO₂, BB, TB, IMT otomatis. | MVP | 9 | WF-01 | Ya | UC-CLN-01 | AC-CLN-FR-002-1..2 | observation | vitalsRecord | | |
| CLN-FR-003 | Peringatan nilai vital di luar rentang wajar. | LJT | 9 |  | Ya |  |  |  |  | | |
| CLN-FR-004 | Anamnesis & SOAP (Subjective, Objective, Assessment, Plan). | MVP | 9 |  | Ya | UC-CLN-02 | AC-CLN-FR-004-1 | clinical_note | noteSave | | |
| CLN-FR-005 | Template klinis per spesialisasi (minimal: umum, gigi, anak, kebidanan). | MVP | 9 |  | Ya | UC-CLN-02 | AC-CLN-FR-005-1 | clinical_note, service_unit | noteSave | | |
| CLN-FR-006 | Pencatatan alergi (zat, reaksi, tingkat keparahan) tampil menonjol di header pasien. | MVP | 9 |  | Ya | UC-CLN-01 | AC-CLN-FR-006-1 | allergy_intolerance | allergyCreate | | |
| CLN-FR-007 | Riwayat penyakit & obat yang sedang digunakan. | MVP | 9 |  | Ya | UC-CLN-01 | AC-CLN-FR-007-1 | patient_history | historyCreate | | |
| CLN-FR-008 | Diagnosis ICD-10: satu primer wajib, sekunder opsional, dengan status (baru/lama). | MVP | 9 |  | Ya | UC-CLN-02 | AC-CLN-FR-008-1 | condition_dx | diagnosesSet | | |
| CLN-FR-009 | Tindakan ICD-9-CM dengan pelaksana; otomatis masuk ke tagihan. | MVP | 9 |  |  | UC-CLN-02 | AC-CLN-FR-009-1 | procedure_act | procedureAdd | | |
| CLN-FR-010 | Resep elektronik non-racikan: obat, dosis, frekuensi, rute, durasi, jumlah, aturan pakai. | MVP | 9 |  | Ya | UC-CLN-03 | AC-CLN-FR-010-1 | prescription | prescriptionSave | | |
| CLN-FR-011 | Resep racikan: komponen, jumlah bungkus/kapsul, aturan pakai. | MVP | 9 |  | Ya | UC-CLN-03 | AC-CLN-FR-011-1 | prescription_compound_component | prescriptionSave | | |
| CLN-FR-012 | Peringatan alergi dan duplikasi obat saat meresepkan. | MVP | 9 |  | Ya | UC-CLN-03 | AC-CLN-FR-012-1..2 | allergy_intolerance, drug_item, prescription_item | prescriptionSave | | |
| CLN-FR-013 | Peringatan interaksi obat. | LJT | 9 |  |  |  |  |  |  | | |
| CLN-FR-014 | Order pemeriksaan lab ke aplikasi lab eksisting. | MVP | 9 | WF-07 |  | UC-CLN-04 | AC-CLN-FR-014-1 | lab_order | labOrderCreate | | |
| CLN-FR-015 | Hasil lab tampil di encounter & riwayat pasien; fallback input hasil manual / unggah PDF. | MVP | 9 | WF-07 |  | UC-CLN-04 | AC-CLN-FR-015-1 | lab_result | labResultManual | | |
| CLN-FR-016 | Riwayat kunjungan sebelumnya terlihat di layar encounter. | MVP | 9 |  |  | UC-CLN-02 | AC-CLN-FR-016-1 | condition_dx, encounter, prescription | patientEncounterHistory, encounterChart | | |
| CLN-FR-017 | Pengesahan rekam medis oleh dokter penanggung jawab mengunci catatan. | MVP | 9 | WF-01 | Ya | UC-CLN-05 | AC-CLN-FR-017-1..2 | clinical_note | encounterSign | | |
| CLN-FR-018 | Diagnosis primer & SOAP wajib terisi sebelum pengesahan. | MVP | 9 |  | Ya | UC-CLN-05 | AC-CLN-FR-018-1 | clinical_note, condition_dx | encounterSign | | |
| CLN-FR-019 | Addendum untuk catatan yang sudah disahkan, dengan alasan & tanda tangan. | MVP | 9 |  |  | UC-CLN-06 | AC-CLN-FR-019-1 | clinical_addendum | addendumCreate | | |
| CLN-FR-020 | Resume medis rawat jalan (PDF). | MVP | 9 |  | Ya | UC-CLN-07 | AC-CLN-FR-020-1 | medical_document | medicalDocumentIssue | | |
| CLN-FR-021 | Surat keterangan sehat & sakit (PDF, nomor surat, kop klinik). | MVP | 9 |  |  | UC-CLN-07 | AC-CLN-FR-021-1 | medical_document | medicalDocumentIssue | | |
| CLN-FR-022 | Surat rujukan keluar. | MVP | 9 | WF-12 |  | UC-CLN-07 | AC-CLN-FR-022-1 | referral | referralCreate | | |
| CLN-FR-023 | Rencana tindak lanjut / jadwal kontrol membuat appointment. | MVP | 9 |  |  | UC-CLN-08 | AC-CLN-FR-023-1 | appointment | followUpCreate | | |
| CLN-FR-024 | Informed consent tindakan tercatat. | LJT | 9 |  | Ya |  |  |  |  | | |
| CLN-FR-025 | Odontogram untuk poli gigi. | LJT | 9 |  | Ya |  |  |  |  | | |
| CLN-FR-026 | Tanda tangan elektronik tersertifikasi untuk dokumen medis. | LJT | 9 |  |  |  |  |  |  | | |
| PHM-FR-001 | Master obat tenant: nama generik & dagang, bentuk, kekuatan, satuan, golongan (bebas, b... | MVP | 10 |  |  | UC-PHM-01 | AC-PHM-FR-001-1 | drug_item | drugList, drugCreate | | |
| PHM-FR-002 | Harga: harga beli, HNA, HET, harga jual per kategori penjamin. | MVP | 10 |  |  | UC-PHM-01 | AC-PHM-FR-002-1 | drug_price | drugCreate | | |
| PHM-FR-003 | Penerimaan barang dari supplier dengan no. faktur, batch, tanggal kedaluwarsa, harga. | MVP | 10 |  |  | UC-PHM-01 | AC-PHM-FR-003-1 | goods_receipt, stock_batch | goodsReceiptCreate | | |
| PHM-FR-004 | Stok dicatat per batch per lokasi sebagai ledger mutasi. | MVP | 10 |  |  | UC-PHM-01 | AC-PHM-FR-004-1 | stock_movement | goodsReceiptCreate, stockList | | |
| PHM-FR-005 | Pemilihan batch otomatis FEFO (default) atau FIFO per tenant. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-005-1 | stock_balance, stock_batch, tenant | prescriptionDispense | | |
| PHM-FR-006 | Worklist resep: resep masuk dari dokter. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-006-1 | prescription | pharmacyWorklist | | |
| PHM-FR-007 | Telaah resep (administratif, farmasetik, klinis) dengan checklist. | MVP | 10 | WF-01 | Ya | UC-PHM-02 | AC-PHM-FR-007-1 | prescription | prescriptionReview | | |
| PHM-FR-008 | Dispensing mengurangi stok & menambahkan baris obat ke tagihan. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-008-1 | dispense | prescriptionDispense | | |
| PHM-FR-009 | Resep parsial: sisa tercatat dan dapat diambil kemudian. | MVP | 10 |  |  | UC-PHM-03 | AC-PHM-FR-009-1 | dispense, prescription_item | prescriptionDispense | | |
| PHM-FR-010 | Substitusi obat dengan persetujuan dokter di aplikasi. | MVP | 10 |  |  | UC-PHM-03 | AC-PHM-FR-010-1 | prescription_item | substitutionRequest, substitutionDecide | | |
| PHM-FR-011 | Cetak etiket obat. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-011-1 | medical_document, stored_file | prescriptionDispense | | |
| PHM-FR-012 | Penjualan obat bebas tanpa kunjungan. | MVP | 10 | WF-05 |  | UC-PHM-04 | AC-PHM-FR-012-1 | otc_sale | otcSaleCreate | | |
| PHM-FR-013 | Stok negatif & obat kedaluwarsa tidak dapat dikeluarkan. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-013-1..2 | stock_balance, stock_batch, stock_movement | prescriptionDispense | | |
| PHM-FR-014 | Peringatan stok minimum & mendekati kedaluwarsa. | MVP | 10 |  |  | UC-PHM-05 | AC-PHM-FR-014-1 | drug_item, stock_balance, stock_batch | stockAlerts | | |
| PHM-FR-015 | Retur ke supplier & retur dari pasien. | LJT | 10 |  |  |  |  |  |  | | |
| PHM-FR-016 | Penyesuaian stok dengan alasan & persetujuan. | MVP | 10 |  |  | UC-PHM-05 | AC-PHM-FR-016-1 | stock_adjustment | stockAdjustmentRequest, stockAdjustmentDecide | | |
| PHM-FR-017 | Stock opname dengan selisih yang disetujui. | MVP | 10 |  |  | UC-PHM-05 | AC-PHM-FR-017-1 | stock_opname | opnameStart, opnameCount, opnameDecide | | |
| PHM-FR-018 | Transfer stok antar lokasi/cabang. | LJT | 10 |  |  |  |  |  |  | | |
| PHM-FR-019 | Akses obat narkotika/psikotropika dibatasi permission khusus & laporan pemakaian. | MVP | 10 |  |  | UC-PHM-02 | AC-PHM-FR-019-1 | drug_item | stockList, prescriptionDispense, reportControlledDrugs | | |
| PHM-FR-020 | Valuasi stok untuk laporan HPP. | LJT | 10 |  |  |  |  |  |  | | |
| BIL-FR-001 | Invoice terbentuk otomatis dari konsultasi, tindakan, obat, lab, dan item lain. | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-001-1 | invoice | billingWorklist, invoiceForEncounter, invoiceIssue | | |
| BIL-FR-002 | Harga pada invoice adalah snapshot tarif saat transaksi. | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-002-1 | invoice_line | invoiceForEncounter, invoiceIssue | | |
| BIL-FR-003 | Diskon per baris / total dengan batas & persetujuan. | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-003-1 | invoice, invoice_line | invoiceDiscount | | |
| BIL-FR-004 | Pembagian tagihan antara penjamin & pasien (co-pay, plafon). | MVP | 11 | WF-03 |  | UC-BIL-01 | AC-BIL-FR-004-1 | invoice | invoiceForEncounter | | |
| BIL-FR-005 | Pembayaran tunai, debit, kartu kredit (pencatatan EDC), transfer. | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-005-1 | payment | paymentCreate | | |
| BIL-FR-006 | QRIS dinamis via payment gateway dengan callback terverifikasi. | MVP | 11 |  |  | UC-BIL-02 | AC-BIL-FR-006-1..2 | payment, payment_gateway_txn | qrisChargeCreate, qrisChargeGet, paymentGatewayCallback | | |
| BIL-FR-007 | Satu invoice dapat dibayar dengan beberapa metode (split tender) dan sebagian. | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-007-1 | payment | paymentCreate | | |
| BIL-FR-008 | Kwitansi / struk (cetak & PDF). | MVP | 11 |  |  | UC-BIL-01 | AC-BIL-FR-008-1 | medical_document, payment | paymentCreate | | |
| BIL-FR-009 | Void invoice hanya via persetujuan; invoice baru menggantikan. | MVP | 11 |  |  | UC-BIL-03 | AC-BIL-FR-009-1 | invoice, invoice_void | invoiceVoidRequest, invoiceVoidDecide | | |
| BIL-FR-010 | Refund dengan alasan & persetujuan manajer (maker–checker). | MVP | 11 |  |  | UC-BIL-04 | AC-BIL-FR-010-1 | refund | refundRequest, refundDecide | | |
| BIL-FR-011 | Buka & tutup shift kasir; perhitungan kas fisik vs sistem, selisih tercatat. | MVP | 11 |  |  | UC-BIL-05 | AC-BIL-FR-011-1..2 | cashier_shift | paymentCreate, shiftOpen, shiftCurrent, shiftClose | | |
| BIL-FR-012 | Rekonsiliasi harian transaksi QRIS dengan laporan settlement. | MVP | 11 |  |  | UC-BIL-02 | AC-BIL-FR-012-1 | payment_gateway_txn | qrisReconciliation | | |
| BIL-FR-013 | Piutang penjamin perusahaan/asuransi & pelunasannya. | MVP | 11 | WF-03 |  | UC-BIL-06 | AC-BIL-FR-013-1 | receivable | receivableList, receivablePay | | |
| BIL-FR-014 | Tagihan kolektif ke perusahaan per periode. | LJT | 11 | WF-04 |  |  |  |  |  | | |
| BIL-FR-015 | Deposit pasien. | LJT | 11 |  |  |  |  |  |  | | |
| BIL-FR-016 | Laporan transaksi tidak wajar (void/refund/diskon berlebih, selisih kas). | MVP | 11 | WF-09 |  | UC-BIL-04, UC-RPT-03 | AC-BIL-FR-016-1 | cashier_shift, invoice_line, invoice_void, refund | reportAnomalies | | |
| BIL-FR-017 | Kebutuhan pajak / e-Faktur pada invoice. | LJT | 11 |  |  |  |  |  |  | | |
| INT-FR-001 | Kredensial SATUSEHAT per fasilitas disimpan aman & dapat diuji koneksinya. | MVP | 12 |  |  | UC-INT-01 | AC-INT-FR-001-1 | integration_connection | satusehatConfigure, satusehatTest | | |
| INT-FR-002 | Sinkronisasi Organization, Location, Practitioner. | MVP | 12 |  |  | UC-INT-01 | AC-INT-FR-002-1 | branch, facility, fhir_sync_record, practitioner | satusehatSyncMaster | | |
| INT-FR-003 | Lookup IHS Patient by NIK. | MVP | 12 |  |  | UC-INT-02 | AC-INT-FR-003-1 | patient | satusehatRecords | | |
| INT-FR-004 | Pengiriman Encounter, Condition, Observation (vital), Procedure setelah pengesahan. | MVP | 12 |  |  | UC-INT-02 | AC-INT-FR-004-1 | condition_dx, encounter, fhir_sync_record, observation, outbox_event, procedure_act | satusehatSummary | | |
| INT-FR-005 | Pengiriman MedicationRequest & MedicationDispense. | MVP | 12 |  |  | UC-INT-02 | AC-INT-FR-005-1 | dispense, fhir_sync_record, prescription | satusehatSummary | | |
| INT-FR-006 | Pengiriman ServiceRequest / DiagnosticReport lab. | LJT | 12 |  |  |  |  |  |  | | |
| INT-FR-007 | Pengiriman Composition / resume. | LJT | 12 |  |  |  |  |  |  | | |
| INT-FR-008 | Validasi payload sebelum kirim; error ditampilkan dengan jelas. | MVP | 12 |  |  | UC-INT-02 | AC-INT-FR-008-1 | fhir_sync_record | satusehatRecords | | |
| INT-FR-009 | Retry otomatis, dead-letter, kirim ulang manual teraudit. | MVP | 12 |  |  | UC-INT-02 | AC-INT-FR-009-1..2 | fhir_sync_record, integration_dead_letter | satusehatRecords, satusehatRetry | | |
| INT-FR-010 | Dashboard status integrasi per tenant. | MVP | 12 |  |  | UC-INT-03 | AC-INT-FR-010-1 | fhir_sync_record | satusehatSummary, satusehatRecords | | |
| INT-FR-011 | Rekonsiliasi data lokal vs terkirim. | MVP | 12 |  |  | UC-INT-03 | AC-INT-FR-011-1 | fhir_sync_record | satusehatReconciliation | | |
| INT-FR-012 | Update resource ketika ada addendum. | MVP | 12 | WF-11 |  | UC-CLN-06 | AC-INT-FR-012-1 | clinical_addendum, fhir_sync_record | addendumCreate | | |
| BPJ-FR-001 | Cek kepesertaan BPJS saat registrasi. | LJT | LJT |  |  |  |  |  |  | | |
| BPJ-FR-002 | Pendaftaran & pelayanan via P-Care untuk FKTP. | LJT | LJT |  |  |  |  |  |  | | |
| BPJ-FR-003 | Rujukan online BPJS. | LJT | LJT | WF-12 |  |  |  |  |  | | |
| BPJ-FR-004 | Model data penjamin MVP menyiapkan field kepesertaan BPJS. | MVP | LJT |  |  | UC-MST-04 | AC-BPJ-FR-004-1 | patient_coverage, payer | payerCreate | | |
| POR-FR-001 | Registrasi akun pasien & penautan ke rekam pasien di klinik dengan verifikasi OTP. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-002 | Riwayat kunjungan & diagnosis (hanya yang disahkan). | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-003 | Riwayat resep & obat. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-004 | Hasil laboratorium. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-005 | Unduh dokumen medis. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-006 | Jadwal kontrol & pengingat. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-007 | Akun wali untuk anak/tanggungan. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-008 | Kelola & cabut perangkat. | LJT | 13 |  |  |  |  |  |  | | |
| POR-FR-009 | Notifikasi tanpa informasi medis sensitif. | LJT | 13 |  |  |  |  |  |  | | |
| RPT-FR-001 | Laporan kunjungan harian/bulanan per cabang, poli, dokter, penjamin. | MVP | 14 |  |  | UC-RPT-01 | AC-RPT-FR-001-1 | encounter | reportVisits | | |
| RPT-FR-002 | 10 besar diagnosis per periode. | MVP | 14 |  |  | UC-RPT-01 | AC-RPT-FR-002-1 | concept, condition_dx | reportTopDiagnoses | | |
| RPT-FR-003 | Laporan pendapatan per layanan, metode bayar, penjamin. | MVP | 14 |  |  | UC-RPT-01 | AC-RPT-FR-003-1 | invoice_line, payment, refund | reportRevenue | | |
| RPT-FR-004 | Laporan closing kasir. | MVP | 14 | WF-10 |  | UC-RPT-01 | AC-RPT-FR-004-1 | cashier_shift, payment | reportCashierClosing | | |
| RPT-FR-005 | Laporan stok, mutasi, mendekati kedaluwarsa. | MVP | 14 |  |  | UC-RPT-02 | AC-RPT-FR-005-1 | stock_balance, stock_movement | reportStock | | |
| RPT-FR-006 | Laporan pemakaian narkotika/psikotropika. | MVP | 14 |  |  | UC-RPT-02 | AC-RPT-FR-006-1 | drug_item, stock_movement | reportControlledDrugs | | |
| RPT-FR-007 | Laporan piutang. | MVP | 14 |  |  | UC-RPT-01 | AC-RPT-FR-007-1 | receivable | reportReceivables | | |
| RPT-FR-008 | Export Excel/CSV/PDF dengan watermark & audit. | MVP | 14 |  |  | UC-RPT-03 | AC-RPT-FR-008-1 | audit_log, stored_file | reportExport | | |
| RPT-FR-009 | Dashboard ringkas harian untuk manajer. | MVP | 14 |  |  | UC-RPT-01 | AC-RPT-FR-009-1 | encounter, fhir_sync_record, payment | dashboardToday | | |
| RPT-FR-010 | Report builder berbasis katalog data (tanpa SQL). | LJT | 14 |  |  |  |  |  |  | | |
| RPT-FR-011 | Laporan terjadwal & distribusi. | LJT | 14 |  |  |  |  |  |  | | |
| RPT-FR-012 | Laporan waktu tunggu pasien. | LJT | 14 |  |  |  |  |  |  | | |
| DOC-FR-001 | Template dokumen (resume, surat, kwitansi, etiket) memakai kop & logo tenant. | MVP | 9 |  |  | UC-PLT-03, UC-CLN-07 | AC-DOC-FR-001-1 | tenant | tenantProfileUpdate, medicalDocumentIssue | | |
| DOC-FR-002 | Dokumen PDF tersimpan & dapat diunduh ulang dengan isi sama (versi tersimpan). | MVP | 9 |  |  | UC-CLN-07 | AC-DOC-FR-002-1 | medical_document, stored_file | medicalDocumentIssue, medicalDocumentGet | | |
| DOC-FR-003 | Unggah berkas pendukung (hasil lab luar, foto) ke rekam pasien. | MVP | 9 |  |  | UC-CLN-04 | AC-DOC-FR-003-1 | stored_file | fileUploadRequest, labResultManual | | |
| NTF-FR-001 | Email transaksional: undangan user, reset password. | MVP | 8 |  |  | UC-IAM-01, UC-IAM-04 | AC-NTF-FR-001-1 | user_invitation | authPasswordResetRequest, userInvite | | |
| NTF-FR-002 | Pengingat appointment via WhatsApp/SMS. | LJT | 8 |  |  |  |  |  |  | | |
| NFR-PERF-001 | Latensi API operasi transaksional | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-PERF-002 | Pencarian pasien | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-PERF-003 | Muat layar encounter lengkap | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-PERF-004 | Kapasitas awal | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-PERF-005 | Laporan interaktif | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-AVL-001 | Ketersediaan bulanan | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-AVL-002 | Jendela maintenance terencana | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-DR-001 | RPO | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-DR-002 | RTO | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-DR-003 | Prosedur downtime klinik | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-001 | 0 kebocoran lintas tenant pada suite test isolasi | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-002 | TLS 1.2+ untuk semua koneksi | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-003 | Enkripsi at rest untuk DB & storage; enkripsi kolom untuk NIK | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-004 | MFA wajib untuk akun admin | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-005 | Sesi idle berakhir otomatis (default 30 menit untuk staf, dapat diatur tenant) | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-006 | Tidak ada PHI di log aplikasi | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-007 | Rate limiting login & API | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-008 | Dependency & secret scanning di CI; tidak ada temuan kritis saat rilis | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-SEC-009 | Penetration test independen sebelum go-live | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-PRV-001 | Pemberitahuan privasi & consent sesuai UU PDP / PP 33/2026 | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-PRV-002 | Hak subjek data (akses, koreksi, pembatasan) dapat dilayani melalui klinik | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-PRV-003 | Notifikasi kegagalan pelindungan data mengikuti tenggat yang berlaku | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-AUD-001 | 100% aksi tulis & baca rekam medis tercatat | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-AUD-002 | Masa simpan audit log (OD-023) | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-RET-001 | Rekam medis disimpan ≥ 25 tahun sejak kunjungan terakhir (REG-03) | MVP | 3 |  |  |  | Target NFR |  |  | | |
| NFR-UX-001 | Bahasa Indonesia | MVP | Semua |  |  |  | Target NFR |  |  | | |
| NFR-UX-002 | Dapat dioperasikan dengan keyboard untuk pendaftaran & SOAP (shortcut) | MVP | Semua |  |  |  | Target NFR |  |  | | |
| NFR-UX-003 | Responsif minimal untuk tablet (layar ≥ 768 px) | MVP | Semua |  |  |  | Target NFR |  |  | | |
| NFR-UX-004 | Kontras & ukuran teks memenuhi WCAG 2.1 AA untuk layar utama | LJT | Semua |  |  |  | Target NFR |  |  | | |
| NFR-CMP-001 | Chrome & Edge, 2 versi terakhir | MVP | Semua |  |  |  | Target NFR |  |  | | |
| NFR-CMP-002 | Printer thermal 58/80 mm untuk struk & etiket; A4/A5 untuk dokumen | MVP | Semua |  |  |  | Target NFR |  |  | | |
| NFR-AND-001 | Android versi minimum (OD-017) | LJT | 13 |  |  |  | Target NFR |  |  | | |
| NFR-OPS-001 | Monitoring, alert, dan error tracking aktif di produksi | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-OPS-002 | Deploy tanpa downtime (rolling) | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-OPS-003 | Biaya infrastruktur terpantau dengan budget alert | MVP | 15 |  |  |  | Target NFR |  |  | | |
| NFR-OPS-004 | Semua data dev/test/staging sintetis | MVP | 15 |  |  |  | Target NFR |  |  | | |
