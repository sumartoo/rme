# Data Dictionary — ClinicRME SaaS

> Dibangkitkan otomatis dari `db/schema/*.sql` oleh `tools/gen_data_dictionary.py`. Jangan diedit manual — ubah komentar di DDL lalu bangkitkan ulang.

**89 tabel** · 82 tabel ber-`tenant_id` · 78 tabel dengan RLS.

## Indeks Tabel

| Tabel | Tenant | RLS | Deskripsi |
|---|---|---|---|
| [`allergy_intolerance`](#allergy-intolerance) | ✓ | ✓ | Alergi pasien, tampil di header klinis & farmasi (CLN-FR-006) |
| [`app_user`](#app-user) | ✓ | ✓ | Akun staf klinik; hanya dibuat dari undangan (IAM-FR-001) |
| [`appointment`](#appointment) | ✓ | ✓ | Janji temu; pembatalan/reschedule wajib alasan (SCH-FR-003/010/011) |
| [`audit_chain_head`](#audit-chain-head) | ✓ | ✓ | Kepala hash chain audit per tenant; hanya diubah oleh app.write_audit() |
| [`audit_log`](#audit-log) | ✓ | ✓ | Audit append-only berantai hash (AUD-FR-001..003). Tanpa PHI mentah. |
| [`branch`](#branch) | ✓ | ✓ | Cabang / lokasi pelayanan; zona waktu menentukan tampilan waktu (AC-GEN-FR-005-2) |
| [`cashier_shift`](#cashier-shift) | ✓ | ✓ | Shift kasir; satu shift OPEN per kasir; variance otomatis (BIL-FR-011) |
| [`clinical_addendum`](#clinical-addendum) | ✓ | ✓ | Koreksi atas catatan yang sudah disahkan; append-only (CLN-FR-019) |
| [`clinical_note`](#clinical-note) | ✓ | ✓ | Catatan SOAP utama per kunjungan; SIGNED = immutable (CLN-FR-004/017) |
| [`code_system`](#code-system) | global | — | Sistem kode & versi sumber (TRM-FR-001/002, OD-030) |
| [`concept`](#concept) | global | — | Kode asli tanpa modifikasi + display Bahasa Indonesia (AC-TRM-FR-001-1) |
| [`condition_dx`](#condition-dx) | ✓ | ✓ | Diagnosis ICD-10; tepat satu primer per kunjungan (AC-CLN-FR-008-1) |
| [`consent_document`](#consent-document) | ✓ | ✓ | Teks consent berversi |
| [`dispense`](#dispense) | ✓ | ✓ | Satu sesi penyerahan obat; resep parsial = beberapa dispense (PHM-FR-008/009) |
| [`dispense_line`](#dispense-line) | ✓ | ✓ | Obat & batch yang diserahkan per baris resep; memicu stock_movement DISPENSE |
| [`document_sequence`](#document-sequence) | ✓ | ✓ | Counter nomor dokumen per tenant/jenis/scope; diambil atomik (GEN-FR-006) |
| [`drug_item`](#drug-item) | ✓ | ✓ | Master obat tenant; golongan menentukan aturan jual bebas & akses (PHM-FR-001, PHM-FR-019) |
| [`drug_price`](#drug-price) | ✓ | ✓ | Harga jual obat per penjamin & periode (PHM-FR-002). Harga beli ada di batch. |
| [`encounter`](#encounter) | ✓ | ✓ | Kunjungan rawat jalan; status mengikuti WF-01 (SCH-FR-013) |
| [`facility`](#facility) | ✓ | ✓ | Fasilitas pelayanan kesehatan dalam tenant; padanan Organization SATUSEHAT |
| [`fhir_sync_record`](#fhir-sync-record) | ✓ | ✓ | Status pengiriman per resource FHIR; dasar dashboard & rekonsiliasi (INT-FR-009..011) |
| [`goods_receipt`](#goods-receipt) | ✓ | ✓ | Penerimaan barang dari supplier (PHM-FR-003) |
| [`goods_receipt_line`](#goods-receipt-line) | ✓ | ✓ | Baris penerimaan barang; qty_base = qty dalam satuan dasar obat |
| [`integration_connection`](#integration-connection) | ✓ | ✓ | Konfigurasi integrasi; secret_ref menunjuk Secret Manager, bukan nilai rahasia (INT-FR-001) |
| [`integration_dead_letter`](#integration-dead-letter) | ✓ | ✓ | Kegagalan permanen yang perlu ditangani manual; kirim ulang teraudit (INT-FR-009) |
| [`invoice`](#invoice) | ✓ | ✓ | Tagihan; setelah ISSUED hanya status & paid_amount yang berubah (BIL-FR-001/004/009) |
| [`invoice_line`](#invoice-line) | ✓ | ✓ | Baris tagihan dengan harga snapshot (BIL-FR-002) |
| [`invoice_void`](#invoice-void) | ✓ | ✓ | Permintaan void invoice dengan persetujuan (BIL-FR-009) |
| [`lab_order`](#lab-order) | ✓ | ✓ | Order ke aplikasi lab eksisting (CLN-FR-014, DEC-009) |
| [`lab_order_item`](#lab-order-item) | ✓ | ✓ | Pemeriksaan yang diminta dalam satu order lab |
| [`lab_result`](#lab-result) | ✓ | ✓ | Hasil lab dari konektor, input manual, atau unggahan PDF (CLN-FR-015) |
| [`medical_document`](#medical-document) | ✓ | ✓ | Dokumen medis terbit (PDF tersimpan, tidak dibuat ulang) (CLN-FR-020/021, DOC-FR-002) |
| [`menu_item`](#menu-item) | global | — | Definisi menu sidebar; ditampilkan sesuai permission efektif (IAM-FR-010) |
| [`observation`](#observation) | ✓ | ✓ | Tanda vital & observasi (CLN-FR-002); batas fisik menolak salah input (AC-CLN-FR-002-2) |
| [`otc_sale`](#otc-sale) | ✓ | ✓ | Penjualan obat bebas tanpa kunjungan (PHM-FR-012) |
| [`otc_sale_line`](#otc-sale-line) | ✓ | ✓ | Baris penjualan bebas; hanya obat golongan BEBAS/BEBAS_TERBATAS (trigger) |
| [`outbox_event`](#outbox-event) | ✓ | ✓ | Event domain ditulis dalam transaksi yang sama dengan data (ADR-0004); payload hanya ID, tanpa PHI |
| [`patient`](#patient) | ✓ | ✓ | Master Patient Index per tenant, dipakai lintas cabang (REG-FR-001/002/012) |
| [`patient_consent`](#patient-consent) | ✓ | ✓ | Consent pasien dengan versi dokumen & waktu (REG-FR-008) |
| [`patient_contact`](#patient-contact) | ✓ | ✓ | Kontak darurat & wali (REG-FR-006) |
| [`patient_coverage`](#patient-coverage) | ✓ | ✓ | Penjamin pasien; satu pasien dapat punya beberapa (REG-FR-007); field BPJS disiapkan (BPJ-FR-004) |
| [`patient_history`](#patient-history) | ✓ | ✓ | Riwayat penyakit & obat rutin (CLN-FR-007) |
| [`payer`](#payer) | ✓ | ✓ | Penjamin: Umum, Asuransi, Perusahaan, BPJS (MST-FR-006, BPJ-FR-004) |
| [`payment`](#payment) | ✓ | ✓ | Pembayaran append-only; idempotency_key mencegah pencatatan ganda (BIL-FR-005..007, AC-BIL-FR-006-2) |
| [`payment_gateway_txn`](#payment-gateway-txn) | ✓ | ✓ | Transaksi QRIS & status callback/settlement (BIL-FR-006/012) |
| [`permission`](#permission) | global | — | Daftar permission global, format <modul>.<resource>.<aksi> (IAM-FR-008) |
| [`practitioner`](#practitioner) | ✓ | ✓ | Tenaga medis & tenaga kesehatan dengan STR/SIP (MST-FR-002) |
| [`practitioner_schedule`](#practitioner-schedule) | ✓ | ✓ | Jadwal praktik mingguan dokter (SCH-FR-001); 1 = Senin |
| [`prescription`](#prescription) | ✓ | ✓ | Resep elektronik; status farmasi tetap dapat berubah setelah RM disahkan (CLN-FR-010, PHM-FR-007) |
| [`prescription_compound_component`](#prescription-compound-component) | ✓ | ✓ | Komponen resep racikan (CLN-FR-011) |
| [`prescription_item`](#prescription-item) | ✓ | ✓ | Baris resep non-racikan / racikan; qty_dispensed melacak resep parsial (PHM-FR-009/010) |
| [`procedure_act`](#procedure-act) | ✓ | ✓ | Tindakan ICD-9-CM; otomatis menjadi baris tagihan (CLN-FR-009) |
| [`queue_counter`](#queue-counter) | ✓ | ✓ | Counter antrean per cabang/unit/hari (SCH-FR-007) |
| [`queue_ticket`](#queue-ticket) | ✓ | ✓ | Nomor antrean unik per cabang/unit/hari (SCH-FR-007/008) |
| [`receivable`](#receivable) | ✓ | ✓ | Piutang porsi penjamin (BIL-FR-013) |
| [`referral`](#referral) | ✓ | ✓ | Rujukan keluar (CLN-FR-022) |
| [`refund`](#refund) | ✓ | ✓ | Refund maker–checker; penyetuju ≠ pengaju (BIL-FR-010) |
| [`region`](#region) | global | — | Wilayah: 1 provinsi, 2 kab/kota, 3 kecamatan, 4 kelurahan/desa |
| [`role`](#role) | ✓ | ✓ | Role tenant; template bawaan + custom (IAM-FR-007/008) |
| [`role_permission`](#role-permission) | ✓ | ✓ | Permission yang dimiliki role |
| [`schedule_exception`](#schedule-exception) | ✓ | ✓ | Cuti dokter atau libur cabang (SCH-FR-002) |
| [`service_item`](#service-item) | ✓ | ✓ | Layanan yang dapat ditagih (MST-FR-004) |
| [`service_unit`](#service-unit) | ✓ | ✓ | Poli, ruang layanan, lokasi farmasi, kasir, lab (MST-FR-001) |
| [`stock_adjustment`](#stock-adjustment) | ✓ | ✓ | Penyesuaian stok dengan maker–checker (PHM-FR-016) |
| [`stock_balance`](#stock-balance) | ✓ | ✓ | Saldo per batch per lokasi; hanya diubah trigger ledger; CHECK >= 0 menolak stok negatif |
| [`stock_batch`](#stock-batch) | ✓ | ✓ | Batch obat dengan tanggal kedaluwarsa & harga beli per satuan dasar (PHM-FR-003) |
| [`stock_location`](#stock-location) | ✓ | ✓ | Lokasi stok: apotek, gudang (per cabang) |
| [`stock_movement`](#stock-movement) | ✓ | ✓ | Ledger mutasi stok, append-only (PHM-FR-004); qty bertanda (+ masuk, − keluar) |
| [`stock_opname`](#stock-opname) | ✓ | ✓ | Sesi stock opname; selisih menjadi movement OPNAME setelah disetujui (PHM-FR-017) |
| [`stock_opname_line`](#stock-opname-line) | ✓ | ✓ | Hasil hitung fisik per batch pada sesi opname |
| [`stored_file`](#stored-file) | ✓ | ✓ | Metadata berkas di Cloud Storage (ADR-0013, DOC-FR-002/003) |
| [`subscription_plan`](#subscription-plan) | global | — | Paket langganan SaaS (PLT-FR-003) |
| [`supplier`](#supplier) | ✓ | ✓ | Pemasok obat (MST-FR-010) |
| [`support_access_grant`](#support-access-grant) | ✓ | — | Break-glass akses dukungan: beralasan, maks. 8 jam, teraudit (PLT-FR-009) |
| [`tariff`](#tariff) | ✓ | ✓ | Tarif per layanan × cabang × penjamin × periode; periode tidak boleh tumpang tindih (AC-MST-FR-005-1) |
| [`tenant`](#tenant) | global | ✓ | Pelanggan SaaS: klinik utama, klinik pratama, atau praktik mandiri (PLT-FR-001/002/005) |
| [`tenant_concept_favorite`](#tenant-concept-favorite) | ✓ | ✓ | Subset diagnosis/tindakan favorit tenant, wajib divalidasi tenaga medis (TRM-FR-003) |
| [`tenant_export_job`](#tenant-export-job) | ✓ | — | Permintaan ekspor seluruh data tenant (PLT-FR-008) |
| [`tenant_feature_flag`](#tenant-feature-flag) | ✓ | — | Feature flag per tenant untuk rilis bertahap (PLT-FR-011) |
| [`tenant_status_history`](#tenant-status-history) | ✓ | — | Histori perubahan status tenant beserta alasan (AC-PLT-FR-005-1) |
| [`tenant_subscription`](#tenant-subscription) | ✓ | — | Riwayat langganan; tepat satu baris is_current per tenant |
| [`uom`](#uom) | ✓ | ✓ | Satuan (tablet, strip, box, ml, botol, ...) (MST-FR-007) |
| [`uom_conversion`](#uom-conversion) | ✓ | ✓ | 1 from_uom = factor × to_uom; opsional spesifik obat |
| [`user_credential`](#user-credential) | ✓ | ✓ | Password Argon2id & status lockout (IAM-FR-003) |
| [`user_identity`](#user-identity) | ✓ | ✓ | Identitas login per provider; Google dikunci pada claim sub (IAM-FR-002, ADR-0003) |
| [`user_invitation`](#user-invitation) | ✓ | ✓ | Undangan user, default berlaku 7 hari (AC-IAM-FR-001-2) |
| [`user_mfa`](#user-mfa) | ✓ | ✓ | TOTP terenkripsi & hash recovery code (IAM-FR-005) |
| [`user_role_assignment`](#user-role-assignment) | ✓ | ✓ | Penugasan role ke user, opsional per cabang (NULL = semua cabang) (IAM-FR-009) |
| [`user_session`](#user-session) | ✓ | ✓ | Sesi login; dicabut saat user dinonaktifkan (IAM-FR-013/014) |

## allergy_intolerance

Alergi pasien, tampil di header klinis & farmasi (CLN-FR-006)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `substance` | text | ✓ |  |  |
| `category` | text | ✓ |  |  |
| `reaction` | text |  |  |  |
| `severity` | text |  |  |  |
| `status` | text | ✓ | `'ACTIVE'::text` |  |
| `recorded_by` | uuid | ✓ |  |  |
| `recorded_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `patient_id` → `patient`

## app_user

Akun staf klinik; hanya dibuat dari undangan (IAM-FR-001)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `email` | text | ✓ |  |  |
| `full_name` | text | ✓ |  |  |
| `phone` | text |  |  |  |
| `status` | text | ✓ | `'ACTIVE'::text` |  |
| `practitioner_id` | uuid |  |  | Tautan ke tenaga kesehatan untuk tanda tangan klinis (IAM-FR-016) |
| `mfa_required` | boolean | ✓ | `false` |  |
| `last_login_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `practitioner_id` → `practitioner`; `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## appointment

Janji temu; pembatalan/reschedule wajib alasan (SCH-FR-003/010/011)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `practitioner_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid | ✓ |  |  |
| `schedule_id` | uuid |  |  |  |
| `slot_start` | timestamp with time zone | ✓ |  |  |
| `channel` | text | ✓ | `'STAFF'::text` |  |
| `status` | text | ✓ | `'BOOKED'::text` |  |
| `status_reason` | text |  |  |  |
| `rescheduled_to_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `branch_id` → `branch`; `patient_id` → `patient`; `practitioner_id` → `practitioner`; `schedule_id` → `practitioner_schedule`; `unit_id` → `service_unit`

**Trigger:** `trg_touch`

## audit_chain_head

Kepala hash chain audit per tenant; hanya diubah oleh app.write_audit()

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `last_seq` | bigint | ✓ | `0` |  |
| `last_hash` | text | ✓ | `repeat('0'::text, 64)` |  |

**Relasi:** `tenant_id` → `tenant`

## audit_log

Audit append-only berantai hash (AUD-FR-001..003). Tanpa PHI mentah.

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `seq` | bigint | ✓ |  |  |
| `occurred_at` | timestamp with time zone | ✓ | `now()` |  |
| `actor_user_id` | uuid |  |  |  |
| `actor_kind` | text | ✓ | `'USER'::text` |  |
| `on_behalf_of` | uuid |  |  |  |
| `action` | text | ✓ |  | CREATE, UPDATE, READ, SIGN, ADDENDUM, VOID, REFUND, EXPORT, LOGIN, LOGIN_FAILED, LOGOUT, PERMISSION_CHANGE, ... |
| `resource_type` | text | ✓ |  |  |
| `resource_id` | uuid |  |  |  |
| `patient_id` | uuid |  |  | Diisi untuk aksi terkait pasien agar pencarian "siapa mengakses RM pasien X" cepat (AUD-FR-002/004) |
| `ip` | inet |  |  |  |
| `user_agent` | text |  |  |  |
| `request_id` | text |  |  |  |
| `change_summary` | jsonb |  |  |  |
| `prev_hash` | text | ✓ |  |  |
| `hash` | text | ✓ |  | sha256(prev_hash // representasi kanonik entri) |

**Trigger:** `trg_audit_log_immutable`

## branch

Cabang / lokasi pelayanan; zona waktu menentukan tampilan waktu (AC-GEN-FR-005-2)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `facility_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `address` | text |  |  |  |
| `region_code` | text |  |  |  |
| `phone` | text |  |  |  |
| `timezone` | text | ✓ | `'Asia/Jakarta'::text` |  |
| `satusehat_location_id` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `facility_id` → `facility`; `region_code` → `region`

**Trigger:** `trg_touch`

## cashier_shift

Shift kasir; satu shift OPEN per kasir; variance otomatis (BIL-FR-011)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `cashier_id` | uuid | ✓ |  |  |
| `opened_at` | timestamp with time zone | ✓ | `now()` |  |
| `opening_cash` | numeric(18,2) | ✓ |  |  |
| `closed_at` | timestamp with time zone |  |  |  |
| `counted_cash` | numeric(18,2) |  |  |  |
| `expected_cash` | numeric(18,2) |  |  |  |
| `variance` | numeric(18,2) |  | `(counted_cash - expected_cash)` |  |
| `variance_note` | text |  |  |  |
| `verified_by` | uuid |  |  |  |
| `status` | text | ✓ | `'OPEN'::text` |  |

**Relasi:** `branch_id` → `branch`; `cashier_id` → `app_user`

## clinical_addendum

Koreksi atas catatan yang sudah disahkan; append-only (CLN-FR-019)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `note_id` | uuid | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `content` | text | ✓ |  |  |
| `changes` | jsonb |  |  |  |
| `author_id` | uuid | ✓ |  |  |
| `signed_at` | timestamp with time zone | ✓ | `now()` |  |
| `content_hash` | text | ✓ |  |  |

**Relasi:** `author_id` → `practitioner`; `note_id` → `clinical_note`

**Trigger:** `trg_addendum_immutable`

## clinical_note

Catatan SOAP utama per kunjungan; SIGNED = immutable (CLN-FR-004/017)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `template_code` | text | ✓ | `'UMUM'::text` |  |
| `subjective` | text |  |  |  |
| `objective` | text |  |  |  |
| `assessment` | text |  |  |  |
| `plan` | text |  |  |  |
| `structured` | jsonb | ✓ | `'{}'::jsonb` | Isian terstruktur dari template spesialisasi (CLN-FR-005) |
| `status` | text | ✓ | `'DRAFT'::text` |  |
| `signed_by` | uuid |  |  |  |
| `signed_at` | timestamp with time zone |  |  |  |
| `content_hash` | text |  |  | SHA-256 isi kanonik saat pengesahan (ADR-0006) |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `encounter_id` → `encounter`; `signed_by` → `practitioner`

**Trigger:** `trg_clinical_note_guard`, `trg_touch`

## code_system

Sistem kode & versi sumber (TRM-FR-001/002, OD-030)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `version` | text | ✓ |  |  |
| `source` | text | ✓ |  |  |
| `effective_date` | date |  |  |  |
| `is_current` | boolean | ✓ | `false` |  |

## concept

Kode asli tanpa modifikasi + display Bahasa Indonesia (AC-TRM-FR-001-1)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `system_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `display_id` | text | ✓ |  |  |
| `display_en` | text |  |  |  |
| `parent_code` | text |  |  |  |
| `synonyms` | text[] | ✓ | `'{}'::text[]` |  |
| `is_active` | boolean | ✓ | `true` |  |

**Relasi:** `system_id` → `code_system`

## condition_dx

Diagnosis ICD-10; tepat satu primer per kunjungan (AC-CLN-FR-008-1)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `concept_id` | uuid | ✓ |  |  |
| `rank` | text | ✓ |  |  |
| `case_status` | text | ✓ | `'BARU'::text` |  |
| `note` | text |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |

**Relasi:** `concept_id` → `concept`; `encounter_id` → `encounter`

**Trigger:** `trg_condition_guard`

## consent_document

Teks consent berversi

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `consent_type` | text | ✓ |  |  |
| `version` | text | ✓ |  |  |
| `content` | text | ✓ |  |  |
| `effective_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## dispense

Satu sesi penyerahan obat; resep parsial = beberapa dispense (PHM-FR-008/009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `prescription_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `dispensed_by` | uuid | ✓ |  |  |
| `dispensed_at` | timestamp with time zone | ✓ | `now()` |  |
| `handed_to` | text |  |  |  |

**Relasi:** `location_id` → `stock_location`; `prescription_id` → `prescription`

## dispense_line

Obat & batch yang diserahkan per baris resep; memicu stock_movement DISPENSE

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `dispense_id` | uuid | ✓ |  |  |
| `prescription_item_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `qty_base` | numeric(18,4) | ✓ |  |  |

**Relasi:** `batch_id` → `stock_batch`; `dispense_id` → `dispense`; `prescription_item_id` → `prescription_item`

## document_sequence

Counter nomor dokumen per tenant/jenis/scope; diambil atomik (GEN-FR-006)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `doc_type` | text | ✓ |  |  |
| `scope_key` | text | ✓ |  |  |
| `pattern` | text | ✓ |  |  |
| `next_value` | bigint | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

## drug_item

Master obat tenant; golongan menentukan aturan jual bebas & akses (PHM-FR-001, PHM-FR-019)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `generic_name` | text | ✓ |  |  |
| `brand_name` | text |  |  |  |
| `dosage_form` | text | ✓ |  |  |
| `strength` | text |  |  |  |
| `base_uom_id` | uuid | ✓ |  |  |
| `drug_class` | text | ✓ |  |  |
| `kfa_code` | text |  |  | Kode KFA SATUSEHAT (TRM-FR-005) |
| `ingredients` | text[] | ✓ | `'{}'::text[]` | Zat aktif (lowercase) untuk pengecekan alergi & duplikasi (CLN-FR-012) |
| `min_stock` | numeric(18,4) | ✓ | `0` |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `base_uom_id` → `uom`; `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## drug_price

Harga jual obat per penjamin & periode (PHM-FR-002). Harga beli ada di batch.

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `drug_item_id` | uuid | ✓ |  |  |
| `branch_id` | uuid |  |  |  |
| `payer_type` | text |  |  |  |
| `hna` | numeric(18,2) |  |  |  |
| `het` | numeric(18,2) |  |  |  |
| `sell_price` | numeric(18,2) | ✓ |  |  |
| `valid_from` | date | ✓ |  |  |
| `valid_to` | date |  |  |  |

**Relasi:** `branch_id` → `branch`; `drug_item_id` → `drug_item`

## encounter

Kunjungan rawat jalan; status mengikuti WF-01 (SCH-FR-013)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_no` | text | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid | ✓ |  |  |
| `practitioner_id` | uuid | ✓ |  |  |
| `appointment_id` | uuid |  |  |  |
| `coverage_id` | uuid |  |  |  |
| `payer_type` | text | ✓ | `'UMUM'::text` |  |
| `arrival_type` | text | ✓ |  |  |
| `status` | text | ✓ | `'ARRIVED'::text` |  |
| `cancel_reason` | text |  |  |  |
| `arrived_at` | timestamp with time zone |  |  |  |
| `consult_started_at` | timestamp with time zone |  |  |  |
| `consult_ended_at` | timestamp with time zone |  |  |  |
| `finished_at` | timestamp with time zone |  |  |  |
| `satusehat_id` | text |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `appointment_id` → `appointment`; `branch_id` → `branch`; `coverage_id` → `patient_coverage`; `patient_id` → `patient`; `practitioner_id` → `practitioner`; `unit_id` → `service_unit`

**Trigger:** `trg_touch`

## facility

Fasilitas pelayanan kesehatan dalam tenant; padanan Organization SATUSEHAT

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `facility_type` | text | ✓ |  |  |
| `license_number` | text |  |  |  |
| `satusehat_org_id` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## fhir_sync_record

Status pengiriman per resource FHIR; dasar dashboard & rekonsiliasi (INT-FR-009..011)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `resource_type` | text | ✓ |  |  |
| `local_type` | text | ✓ |  |  |
| `local_id` | uuid | ✓ |  |  |
| `satusehat_id` | text |  |  |  |
| `status` | text | ✓ | `'PENDING'::text` |  |
| `attempts` | integer | ✓ | `0` |  |
| `last_error` | text |  |  |  |
| `payload_hash` | text |  |  |  |
| `last_sent_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

## goods_receipt

Penerimaan barang dari supplier (PHM-FR-003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `receipt_no` | text | ✓ |  |  |
| `supplier_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `invoice_no` | text | ✓ |  |  |
| `received_at` | timestamp with time zone | ✓ | `now()` |  |
| `received_by` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'POSTED'::text` |  |

**Relasi:** `location_id` → `stock_location`; `supplier_id` → `supplier`

## goods_receipt_line

Baris penerimaan barang; qty_base = qty dalam satuan dasar obat

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `goods_receipt_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `qty` | numeric(18,4) | ✓ |  |  |
| `uom_id` | uuid | ✓ |  |  |
| `qty_base` | numeric(18,4) | ✓ |  |  |
| `unit_price` | numeric(18,2) | ✓ |  |  |

**Relasi:** `batch_id` → `stock_batch`; `goods_receipt_id` → `goods_receipt`; `uom_id` → `uom`

## integration_connection

Konfigurasi integrasi; secret_ref menunjuk Secret Manager, bukan nilai rahasia (INT-FR-001)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `facility_id` | uuid | ✓ |  |  |
| `kind` | text | ✓ |  |  |
| `environment` | text | ✓ |  |  |
| `secret_ref` | text | ✓ |  |  |
| `config` | jsonb | ✓ | `'{}'::jsonb` |  |
| `last_test_at` | timestamp with time zone |  |  |  |
| `last_test_ok` | boolean |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |

**Relasi:** `facility_id` → `facility`

## integration_dead_letter

Kegagalan permanen yang perlu ditangani manual; kirim ulang teraudit (INT-FR-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `source` | text | ✓ |  |  |
| `ref_id` | uuid |  |  |  |
| `error` | text | ✓ |  |  |
| `payload_ref` | jsonb |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `resolved_at` | timestamp with time zone |  |  |  |
| `resolved_by` | uuid |  |  |  |
| `resolution` | text |  |  |  |

**Relasi:** `tenant_id` → `tenant`

## invoice

Tagihan; setelah ISSUED hanya status & paid_amount yang berubah (BIL-FR-001/004/009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `invoice_no` | text |  |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `patient_id` | uuid |  |  |  |
| `encounter_id` | uuid |  |  |  |
| `otc_sale_id` | uuid |  |  |  |
| `status` | text | ✓ | `'DRAFT'::text` |  |
| `gross_amount` | numeric(18,2) | ✓ | `0` |  |
| `discount_amount` | numeric(18,2) | ✓ | `0` |  |
| `net_amount` | numeric(18,2) | ✓ | `0` |  |
| `payer_portion` | numeric(18,2) | ✓ | `0` |  |
| `patient_portion` | numeric(18,2) | ✓ | `0` |  |
| `paid_amount` | numeric(18,2) | ✓ | `0` |  |
| `payer_id` | uuid |  |  |  |
| `issued_at` | timestamp with time zone |  |  |  |
| `issued_by` | uuid |  |  |  |
| `replaces_invoice_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `branch_id` → `branch`; `encounter_id` → `encounter`; `otc_sale_id` → `otc_sale`; `patient_id` → `patient`; `payer_id` → `payer`; `replaces_invoice_id` → `invoice`

**Trigger:** `trg_invoice_guard`, `trg_touch`

## invoice_line

Baris tagihan dengan harga snapshot (BIL-FR-002)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `invoice_id` | uuid | ✓ |  |  |
| `line_no` | smallint | ✓ |  |  |
| `source_type` | text | ✓ |  |  |
| `source_id` | uuid |  |  |  |
| `description` | text | ✓ |  |  |
| `qty` | numeric(18,4) | ✓ |  |  |
| `unit_price` | numeric(18,2) | ✓ |  |  |
| `discount_amount` | numeric(18,2) | ✓ | `0` |  |
| `line_total` | numeric(18,2) | ✓ |  |  |
| `payer_portion` | numeric(18,2) | ✓ | `0` |  |
| `patient_portion` | numeric(18,2) | ✓ | `0` |  |
| `discount_approved_by` | uuid |  |  |  |

**Relasi:** `invoice_id` → `invoice`

**Trigger:** `trg_invoice_line_guard`

## invoice_void

Permintaan void invoice dengan persetujuan (BIL-FR-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `invoice_id` | uuid | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `requested_by` | uuid | ✓ |  |  |
| `approved_by` | uuid |  |  |  |
| `status` | text | ✓ | `'REQUESTED'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `decided_at` | timestamp with time zone |  |  |  |

**Relasi:** `invoice_id` → `invoice`

**Trigger:** `trg_invoice_void_guard`

## lab_order

Order ke aplikasi lab eksisting (CLN-FR-014, DEC-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `order_no` | text | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `ordered_by` | uuid | ✓ |  |  |
| `lab_connector` | text |  |  |  |
| `external_order_id` | text |  |  |  |
| `status` | text | ✓ | `'ORDERED'::text` |  |
| `clinical_info` | text |  |  |  |
| `ordered_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `encounter_id` → `encounter`; `ordered_by` → `practitioner`

## lab_order_item

Pemeriksaan yang diminta dalam satu order lab

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `lab_order_id` | uuid | ✓ |  |  |
| `service_item_id` | uuid | ✓ |  |  |

**Relasi:** `lab_order_id` → `lab_order`; `service_item_id` → `service_item`

## lab_result

Hasil lab dari konektor, input manual, atau unggahan PDF (CLN-FR-015)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `lab_order_id` | uuid | ✓ |  |  |
| `lab_order_item_id` | uuid |  |  |  |
| `source` | text | ✓ |  |  |
| `test_name` | text |  |  |  |
| `value_text` | text |  |  |  |
| `unit` | text |  |  |  |
| `reference_range` | text |  |  |  |
| `flag` | text |  |  |  |
| `file_id` | uuid |  |  |  |
| `resulted_at` | timestamp with time zone | ✓ | `now()` |  |
| `entered_by` | uuid |  |  |  |

**Relasi:** `file_id` → `stored_file`; `lab_order_id` → `lab_order`; `lab_order_item_id` → `lab_order_item`

## medical_document

Dokumen medis terbit (PDF tersimpan, tidak dibuat ulang) (CLN-FR-020/021, DOC-FR-002)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `document_no` | text | ✓ |  |  |
| `doc_type` | text | ✓ |  |  |
| `encounter_id` | uuid |  |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `file_id` | uuid | ✓ |  |  |
| `data` | jsonb | ✓ | `'{}'::jsonb` |  |
| `issued_by` | uuid | ✓ |  |  |
| `issued_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `encounter_id` → `encounter`; `file_id` → `stored_file`; `patient_id` → `patient`

**Trigger:** `trg_medical_document_immutable`

## menu_item

Definisi menu sidebar; ditampilkan sesuai permission efektif (IAM-FR-010)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `code` | text | ✓ |  |  |
| `parent_code` | text |  |  |  |
| `label` | text | ✓ |  |  |
| `route` | text |  |  |  |
| `icon` | text |  |  |  |
| `required_permission` | text |  |  |  |
| `sort_order` | integer | ✓ | `0` |  |

**Relasi:** `parent_code` → `menu_item`; `required_permission` → `permission`

## observation

Tanda vital & observasi (CLN-FR-002); batas fisik menolak salah input (AC-CLN-FR-002-2)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `value_num` | numeric(10,2) |  |  |  |
| `value_text` | text |  |  |  |
| `unit` | text |  |  |  |
| `recorded_by` | uuid | ✓ |  |  |
| `recorded_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `encounter_id` → `encounter`

**Trigger:** `trg_observation_guard`

## otc_sale

Penjualan obat bebas tanpa kunjungan (PHM-FR-012)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `sale_no` | text | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `patient_id` | uuid |  |  |  |
| `sold_by` | uuid | ✓ |  |  |
| `sold_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `branch_id` → `branch`; `location_id` → `stock_location`; `patient_id` → `patient`

## otc_sale_line

Baris penjualan bebas; hanya obat golongan BEBAS/BEBAS_TERBATAS (trigger)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `otc_sale_id` | uuid | ✓ |  |  |
| `drug_item_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `qty_base` | numeric(18,4) | ✓ |  |  |
| `unit_price` | numeric(18,2) | ✓ |  |  |

**Relasi:** `batch_id` → `stock_batch`; `drug_item_id` → `drug_item`; `otc_sale_id` → `otc_sale`

**Trigger:** `trg_otc_drug_class`

## outbox_event

Event domain ditulis dalam transaksi yang sama dengan data (ADR-0004); payload hanya ID, tanpa PHI

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `event_type` | text | ✓ |  |  |
| `aggregate_type` | text | ✓ |  |  |
| `aggregate_id` | uuid | ✓ |  |  |
| `payload` | jsonb | ✓ | `'{}'::jsonb` |  |
| `status` | text | ✓ | `'PENDING'::text` |  |
| `attempts` | integer | ✓ | `0` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `dispatched_at` | timestamp with time zone |  |  |  |

**Relasi:** `tenant_id` → `tenant`

## patient

Master Patient Index per tenant, dipakai lintas cabang (REG-FR-001/002/012)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `mrn` | text | ✓ |  |  |
| `full_name` | text | ✓ |  |  |
| `birth_date` | date | ✓ |  |  |
| `sex` | text | ✓ |  |  |
| `identity_type` | text | ✓ |  |  |
| `nik_encrypted` | bytea |  |  | NIK terenkripsi di aplikasi; tidak pernah ditulis ke log (REG-FR-009) |
| `nik_hash` | text |  |  | HMAC-SHA256 NIK untuk pencarian & deteksi duplikat pasti (REG-FR-004) |
| `identity_value_encrypted` | bytea |  |  |  |
| `mother_patient_id` | uuid |  |  |  |
| `phone` | text |  |  |  |
| `email` | text |  |  |  |
| `address` | text |  |  |  |
| `region_code` | text |  |  |  |
| `ihs_number` | text |  |  |  |
| `ihs_status` | text | ✓ | `'PENDING'::text` |  |
| `status` | text | ✓ | `'ACTIVE'::text` |  |
| `merged_into_id` | uuid |  |  | Pasien tujuan merge; data tidak dihapus (REG-FR-005) |
| `registered_branch_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `merged_into_id` → `patient`; `mother_patient_id` → `patient`; `region_code` → `region`; `registered_branch_id` → `branch`; `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## patient_consent

Consent pasien dengan versi dokumen & waktu (REG-FR-008)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `consent_document_id` | uuid | ✓ |  |  |
| `granted` | boolean | ✓ |  |  |
| `signed_by_name` | text |  |  |  |
| `signed_by_relation` | text |  |  |  |
| `recorded_by` | uuid | ✓ |  |  |
| `recorded_at` | timestamp with time zone | ✓ | `now()` |  |
| `revoked_at` | timestamp with time zone |  |  |  |

**Relasi:** `consent_document_id` → `consent_document`; `patient_id` → `patient`

## patient_contact

Kontak darurat & wali (REG-FR-006)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `relation` | text | ✓ |  |  |
| `full_name` | text | ✓ |  |  |
| `phone` | text | ✓ |  |  |
| `is_guardian` | boolean | ✓ | `false` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `patient_id` → `patient`

## patient_coverage

Penjamin pasien; satu pasien dapat punya beberapa (REG-FR-007); field BPJS disiapkan (BPJ-FR-004)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `payer_id` | uuid | ✓ |  |  |
| `member_no` | text |  |  |  |
| `plan_name` | text |  |  |  |
| `employee_no` | text |  |  |  |
| `bpjs_faskes_code` | text |  |  |  |
| `valid_from` | date |  |  |  |
| `valid_to` | date |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `patient_id` → `patient`; `payer_id` → `payer`

## patient_history

Riwayat penyakit & obat rutin (CLN-FR-007)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `patient_id` | uuid | ✓ |  |  |
| `history_type` | text | ✓ |  |  |
| `description` | text | ✓ |  |  |
| `recorded_by` | uuid | ✓ |  |  |
| `recorded_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `patient_id` → `patient`

## payer

Penjamin: Umum, Asuransi, Perusahaan, BPJS (MST-FR-006, BPJ-FR-004)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `payer_type` | text | ✓ |  |  |
| `contract` | jsonb |  |  | Ketentuan kontrak: plafon, co-pay %, termin pembayaran |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## payment

Pembayaran append-only; idempotency_key mencegah pencatatan ganda (BIL-FR-005..007, AC-BIL-FR-006-2)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `receipt_no` | text | ✓ |  |  |
| `invoice_id` | uuid | ✓ |  |  |
| `shift_id` | uuid | ✓ |  |  |
| `method` | text | ✓ |  |  |
| `amount` | numeric(18,2) | ✓ |  |  |
| `cash_tendered` | numeric(18,2) |  |  |  |
| `reference` | text |  |  |  |
| `idempotency_key` | text | ✓ |  |  |
| `received_by` | uuid | ✓ |  |  |
| `received_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `invoice_id` → `invoice`; `shift_id` → `cashier_shift`

**Trigger:** `trg_payment_immutable`

## payment_gateway_txn

Transaksi QRIS & status callback/settlement (BIL-FR-006/012)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `invoice_id` | uuid | ✓ |  |  |
| `provider` | text | ✓ |  |  |
| `provider_ref` | text |  |  |  |
| `amount` | numeric(18,2) | ✓ |  |  |
| `qr_payload` | text |  |  |  |
| `status` | text | ✓ | `'PENDING'::text` |  |
| `expires_at` | timestamp with time zone |  |  |  |
| `payment_id` | uuid |  |  |  |
| `callback_count` | integer | ✓ | `0` |  |
| `last_callback_at` | timestamp with time zone |  |  |  |
| `settled` | boolean | ✓ | `false` |  |
| `settlement_ref` | text |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `invoice_id` → `invoice`; `payment_id` → `payment`

## permission

Daftar permission global, format <modul>.<resource>.<aksi> (IAM-FR-008)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `code` | text | ✓ |  |  |
| `module` | text | ✓ |  |  |
| `description` | text | ✓ |  |  |

## practitioner

Tenaga medis & tenaga kesehatan dengan STR/SIP (MST-FR-002)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `full_name` | text | ✓ |  |  |
| `nik_encrypted` | bytea |  |  |  |
| `nik_hash` | text |  |  | HMAC-SHA256 NIK dengan kunci per lingkungan; untuk pencarian & keunikan |
| `practitioner_type` | text | ✓ |  |  |
| `specialty` | text |  |  |  |
| `str_number` | text |  |  |  |
| `str_valid_until` | date |  |  |  |
| `sip_number` | text |  |  |  |
| `sip_valid_until` | date |  |  |  |
| `satusehat_ihs_id` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## practitioner_schedule

Jadwal praktik mingguan dokter (SCH-FR-001); 1 = Senin

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `practitioner_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid | ✓ |  |  |
| `day_of_week` | smallint | ✓ |  |  |
| `start_time` | time without time zone | ✓ |  |  |
| `end_time` | time without time zone | ✓ |  |  |
| `slot_minutes` | smallint | ✓ | `15` |  |
| `quota` | integer | ✓ |  |  |
| `valid_from` | date | ✓ | `CURRENT_DATE` |  |
| `valid_to` | date |  |  |  |

**Relasi:** `branch_id` → `branch`; `practitioner_id` → `practitioner`; `unit_id` → `service_unit`

## prescription

Resep elektronik; status farmasi tetap dapat berubah setelah RM disahkan (CLN-FR-010, PHM-FR-007)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `prescription_no` | text | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `prescriber_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'DRAFT'::text` |  |
| `review_checklist` | jsonb |  |  |  |
| `reviewed_by` | uuid |  |  |  |
| `reviewed_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `encounter_id` → `encounter`; `prescriber_id` → `practitioner`

**Trigger:** `trg_prescription_guard`, `trg_touch`

## prescription_compound_component

Komponen resep racikan (CLN-FR-011)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `prescription_item_id` | uuid | ✓ |  |  |
| `drug_item_id` | uuid | ✓ |  |  |
| `qty` | numeric(18,4) | ✓ |  |  |
| `uom_id` | uuid | ✓ |  |  |

**Relasi:** `drug_item_id` → `drug_item`; `prescription_item_id` → `prescription_item`; `uom_id` → `uom`

## prescription_item

Baris resep non-racikan / racikan; qty_dispensed melacak resep parsial (PHM-FR-009/010)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `prescription_id` | uuid | ✓ |  |  |
| `line_no` | smallint | ✓ |  |  |
| `is_compound` | boolean | ✓ | `false` |  |
| `drug_item_id` | uuid |  |  |  |
| `compound_name` | text |  |  |  |
| `compound_form` | text |  |  |  |
| `dose` | text |  |  |  |
| `frequency` | text | ✓ |  |  |
| `route` | text | ✓ |  |  |
| `duration_days` | smallint |  |  |  |
| `qty` | numeric(18,4) | ✓ |  |  |
| `uom_id` | uuid | ✓ |  |  |
| `instructions` | text |  |  |  |
| `qty_dispensed` | numeric(18,4) | ✓ | `0` |  |
| `substituted_from_drug_id` | uuid |  |  |  |
| `substitution_reason` | text |  |  |  |
| `substitution_approved_by` | uuid |  |  |  |

**Relasi:** `drug_item_id` → `drug_item`; `prescription_id` → `prescription`; `substitution_approved_by` → `practitioner`; `uom_id` → `uom`

**Trigger:** `trg_prescription_item_guard`

## procedure_act

Tindakan ICD-9-CM; otomatis menjadi baris tagihan (CLN-FR-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `concept_id` | uuid |  |  |  |
| `service_item_id` | uuid | ✓ |  |  |
| `performed_by` | uuid | ✓ |  |  |
| `qty` | numeric(10,2) | ✓ | `1` |  |
| `performed_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `concept_id` → `concept`; `encounter_id` → `encounter`; `performed_by` → `practitioner`; `service_item_id` → `service_item`

**Trigger:** `trg_procedure_guard`

## queue_counter

Counter antrean per cabang/unit/hari (SCH-FR-007)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid | ✓ |  |  |
| `queue_date` | date | ✓ |  |  |
| `last_number` | integer | ✓ | `0` |  |

**Relasi:** `branch_id` → `branch`; `unit_id` → `service_unit`

## queue_ticket

Nomor antrean unik per cabang/unit/hari (SCH-FR-007/008)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid | ✓ |  |  |
| `queue_date` | date | ✓ |  |  |
| `queue_number` | integer | ✓ |  |  |
| `display_code` | text | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'WAITING'::text` |  |
| `called_at` | timestamp with time zone |  |  |  |
| `call_count` | integer | ✓ | `0` |  |

**Relasi:** `branch_id` → `branch`; `encounter_id` → `encounter`; `unit_id` → `service_unit`

## receivable

Piutang porsi penjamin (BIL-FR-013)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `invoice_id` | uuid | ✓ |  |  |
| `payer_id` | uuid | ✓ |  |  |
| `amount` | numeric(18,2) | ✓ |  |  |
| `paid_amount` | numeric(18,2) | ✓ | `0` |  |
| `due_date` | date |  |  |  |
| `status` | text | ✓ | `'OPEN'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `invoice_id` → `invoice`; `payer_id` → `payer`

## referral

Rujukan keluar (CLN-FR-022)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `encounter_id` | uuid | ✓ |  |  |
| `destination` | text | ✓ |  |  |
| `destination_unit` | text |  |  |  |
| `reason` | text | ✓ |  |  |
| `clinical_summary` | text |  |  |  |
| `document_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |

**Relasi:** `encounter_id` → `encounter`

## refund

Refund maker–checker; penyetuju ≠ pengaju (BIL-FR-010)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `refund_no` | text | ✓ |  |  |
| `payment_id` | uuid | ✓ |  |  |
| `amount` | numeric(18,2) | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `method` | text | ✓ |  |  |
| `requested_by` | uuid | ✓ |  |  |
| `requested_at` | timestamp with time zone | ✓ | `now()` |  |
| `approved_by` | uuid |  |  |  |
| `decided_at` | timestamp with time zone |  |  |  |
| `status` | text | ✓ | `'REQUESTED'::text` |  |

**Relasi:** `payment_id` → `payment`

**Trigger:** `trg_refund_guard`

## region

Wilayah: 1 provinsi, 2 kab/kota, 3 kecamatan, 4 kelurahan/desa

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `code` | text | ✓ |  |  |
| `parent_code` | text |  |  |  |
| `level` | smallint | ✓ |  |  |
| `name` | text | ✓ |  |  |

**Relasi:** `parent_code` → `region`

## role

Role tenant; template bawaan + custom (IAM-FR-007/008)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `is_template` | boolean | ✓ | `false` |  |
| `requires_mfa` | boolean | ✓ | `false` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## role_permission

Permission yang dimiliki role

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `role_id` | uuid | ✓ |  |  |
| `permission_code` | text | ✓ |  |  |

**Relasi:** `permission_code` → `permission`; `role_id` → `role`

## schedule_exception

Cuti dokter atau libur cabang (SCH-FR-002)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `practitioner_id` | uuid |  |  |  |
| `branch_id` | uuid |  |  |  |
| `exception_date` | date | ✓ |  |  |
| `reason` | text | ✓ |  |  |

**Relasi:** `branch_id` → `branch`; `practitioner_id` → `practitioner`

## service_item

Layanan yang dapat ditagih (MST-FR-004)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `service_type` | text | ✓ |  |  |
| `icd9cm_code` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `tenant_id` → `tenant`

**Trigger:** `trg_touch`

## service_unit

Poli, ruang layanan, lokasi farmasi, kasir, lab (MST-FR-001)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `unit_type` | text | ✓ |  |  |
| `specialty` | text |  |  |  |
| `default_template` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Relasi:** `branch_id` → `branch`

**Trigger:** `trg_touch`

## stock_adjustment

Penyesuaian stok dengan maker–checker (PHM-FR-016)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `qty_delta` | numeric(18,4) | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `requested_by` | uuid | ✓ |  |  |
| `approved_by` | uuid |  |  |  |
| `status` | text | ✓ | `'REQUESTED'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `decided_at` | timestamp with time zone |  |  |  |

**Relasi:** `batch_id` → `stock_batch`; `location_id` → `stock_location`

**Trigger:** `trg_stock_adjustment_guard`

## stock_balance

Saldo per batch per lokasi; hanya diubah trigger ledger; CHECK >= 0 menolak stok negatif

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `qty_on_hand` | numeric(18,4) | ✓ | `0` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `batch_id` → `stock_batch`; `location_id` → `stock_location`

## stock_batch

Batch obat dengan tanggal kedaluwarsa & harga beli per satuan dasar (PHM-FR-003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `drug_item_id` | uuid | ✓ |  |  |
| `batch_no` | text | ✓ |  |  |
| `expiry_date` | date | ✓ |  |  |
| `unit_cost` | numeric(18,4) | ✓ |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `drug_item_id` → `drug_item`

## stock_location

Lokasi stok: apotek, gudang (per cabang)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `branch_id` | uuid | ✓ |  |  |
| `unit_id` | uuid |  |  |  |
| `name` | text | ✓ |  |  |
| `is_active` | boolean | ✓ | `true` |  |

**Relasi:** `branch_id` → `branch`; `unit_id` → `service_unit`

## stock_movement

Ledger mutasi stok, append-only (PHM-FR-004); qty bertanda (+ masuk, − keluar)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `movement_type` | text | ✓ |  |  |
| `qty` | numeric(18,4) | ✓ |  |  |
| `ref_type` | text | ✓ |  |  |
| `ref_id` | uuid | ✓ |  |  |
| `actor_id` | uuid |  |  |  |
| `occurred_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `batch_id` → `stock_batch`; `location_id` → `stock_location`

**Trigger:** `trg_stock_movement_apply`, `trg_stock_movement_immutable`

## stock_opname

Sesi stock opname; selisih menjadi movement OPNAME setelah disetujui (PHM-FR-017)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `location_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'COUNTING'::text` |  |
| `started_by` | uuid | ✓ |  |  |
| `started_at` | timestamp with time zone | ✓ | `now()` |  |
| `approved_by` | uuid |  |  |  |
| `approved_at` | timestamp with time zone |  |  |  |

**Relasi:** `location_id` → `stock_location`

## stock_opname_line

Hasil hitung fisik per batch pada sesi opname

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `opname_id` | uuid | ✓ |  |  |
| `batch_id` | uuid | ✓ |  |  |
| `system_qty` | numeric(18,4) | ✓ |  |  |
| `counted_qty` | numeric(18,4) | ✓ |  |  |
| `note` | text |  |  |  |

**Relasi:** `batch_id` → `stock_batch`; `opname_id` → `stock_opname`

## stored_file

Metadata berkas di Cloud Storage (ADR-0013, DOC-FR-002/003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `category` | text | ✓ |  |  |
| `object_path` | text | ✓ |  |  |
| `content_type` | text | ✓ |  |  |
| `size_bytes` | bigint | ✓ |  |  |
| `sha256` | text | ✓ |  |  |
| `patient_id` | uuid |  |  |  |
| `uploaded_by` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## subscription_plan

Paket langganan SaaS (PLT-FR-003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `max_users` | integer | ✓ |  |  |
| `max_branches` | integer | ✓ |  |  |
| `features` | jsonb | ✓ | `'{}'::jsonb` | Fitur yang diaktifkan paket, mis. {"pharmacy":true,"lab":true} |
| `monthly_price` | numeric(18,2) | ✓ | `0` |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

## supplier

Pemasok obat (MST-FR-010)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `phone` | text |  |  |  |
| `address` | text |  |  |  |
| `is_active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## support_access_grant

Break-glass akses dukungan: beralasan, maks. 8 jam, teraudit (PLT-FR-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `platform_user` | uuid | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `starts_at` | timestamp with time zone | ✓ | `now()` |  |
| `expires_at` | timestamp with time zone | ✓ |  |  |
| `revoked_at` | timestamp with time zone |  |  |  |

**Relasi:** `tenant_id` → `tenant`

## tariff

Tarif per layanan × cabang × penjamin × periode; periode tidak boleh tumpang tindih (AC-MST-FR-005-1)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `service_item_id` | uuid | ✓ |  |  |
| `branch_id` | uuid |  |  |  |
| `payer_type` | text |  |  |  |
| `payer_id` | uuid |  |  |  |
| `price` | numeric(18,2) | ✓ |  |  |
| `valid_from` | date | ✓ |  |  |
| `valid_to` | date |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `created_by` | uuid |  |  |  |

**Relasi:** `branch_id` → `branch`; `payer_id` → `payer`; `service_item_id` → `service_item`

## tenant

Pelanggan SaaS: klinik utama, klinik pratama, atau praktik mandiri (PLT-FR-001/002/005)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `legal_name` | text | ✓ |  |  |
| `display_name` | text | ✓ |  |  |
| `tenant_type` | text | ✓ |  |  |
| `status` | text | ✓ | `'PROVISIONING'::text` |  |
| `timezone` | text | ✓ | `'Asia/Jakarta'::text` |  |
| `settings` | jsonb | ✓ | `'{}'::jsonb` | Konfigurasi tenant: alur farmasi/kasir (DEC-013), batas diskon, lockout, toleransi no-show, dll. |
| `logo_file_id` | uuid |  |  |  |
| `letterhead` | jsonb |  |  | Kop surat: nama, alamat, telepon, izin (PLT-FR-007) |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_by` | uuid |  |  |  |
| `version` | integer | ✓ | `1` |  |

**Trigger:** `trg_touch`

## tenant_concept_favorite

Subset diagnosis/tindakan favorit tenant, wajib divalidasi tenaga medis (TRM-FR-003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `concept_id` | uuid | ✓ |  |  |
| `specialty` | text |  |  |  |
| `validated_by` | uuid |  |  |  |
| `validated_at` | timestamp with time zone |  |  |  |

**Relasi:** `concept_id` → `concept`; `tenant_id` → `tenant`

## tenant_export_job

Permintaan ekspor seluruh data tenant (PLT-FR-008)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `requested_by` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'QUEUED'::text` |  |
| `file_id` | uuid |  |  |  |
| `expires_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `finished_at` | timestamp with time zone |  |  |  |

**Relasi:** `tenant_id` → `tenant`

## tenant_feature_flag

Feature flag per tenant untuk rilis bertahap (PLT-FR-011)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `feature_code` | text | ✓ |  |  |
| `enabled` | boolean | ✓ |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## tenant_status_history

Histori perubahan status tenant beserta alasan (AC-PLT-FR-005-1)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `from_status` | text |  |  |  |
| `to_status` | text | ✓ |  |  |
| `reason` | text | ✓ |  |  |
| `actor_id` | uuid |  |  |  |
| `occurred_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## tenant_subscription

Riwayat langganan; tepat satu baris is_current per tenant

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `plan_id` | uuid | ✓ |  |  |
| `start_at` | timestamp with time zone | ✓ |  |  |
| `end_at` | timestamp with time zone |  |  |  |
| `trial_end_at` | timestamp with time zone |  |  |  |
| `is_current` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `plan_id` → `subscription_plan`; `tenant_id` → `tenant`

## uom

Satuan (tablet, strip, box, ml, botol, ...) (MST-FR-007)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |

**Relasi:** `tenant_id` → `tenant`

## uom_conversion

1 from_uom = factor × to_uom; opsional spesifik obat

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `from_uom_id` | uuid | ✓ |  |  |
| `to_uom_id` | uuid | ✓ |  |  |
| `factor` | numeric(18,6) | ✓ |  |  |
| `drug_item_id` | uuid |  |  |  |

**Relasi:** `drug_item_id` → `drug_item`; `from_uom_id` → `uom`; `to_uom_id` → `uom`

## user_credential

Password Argon2id & status lockout (IAM-FR-003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `password_hash` | text | ✓ |  |  |
| `password_changed_at` | timestamp with time zone | ✓ | `now()` |  |
| `failed_attempts` | integer | ✓ | `0` |  |
| `locked_until` | timestamp with time zone |  |  |  |

**Relasi:** `user_id` → `app_user`

## user_identity

Identitas login per provider; Google dikunci pada claim sub (IAM-FR-002, ADR-0003)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `provider` | text | ✓ |  |  |
| `subject` | text | ✓ |  |  |
| `email_at_link` | text |  |  |  |
| `linked_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `user_id` → `app_user`

## user_invitation

Undangan user, default berlaku 7 hari (AC-IAM-FR-001-2)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `email` | text | ✓ |  |  |
| `role_ids` | uuid[] | ✓ |  |  |
| `branch_ids` | uuid[] | ✓ | `'{}'::uuid[]` |  |
| `token_hash` | text | ✓ |  |  |
| `invited_by` | uuid |  |  |  |
| `expires_at` | timestamp with time zone | ✓ |  |  |
| `accepted_at` | timestamp with time zone |  |  |  |
| `accepted_user_id` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `tenant_id` → `tenant`

## user_mfa

TOTP terenkripsi & hash recovery code (IAM-FR-005)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `tenant_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `totp_secret_encrypted` | bytea | ✓ |  |  |
| `recovery_codes_hash` | text[] | ✓ | `'{}'::text[]` |  |
| `enabled_at` | timestamp with time zone | ✓ | `now()` |  |

**Relasi:** `user_id` → `app_user`

## user_role_assignment

Penugasan role ke user, opsional per cabang (NULL = semua cabang) (IAM-FR-009)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `role_id` | uuid | ✓ |  |  |
| `branch_id` | uuid |  |  | FK ke branch ditambahkan di 040_masterdata.sql |
| `valid_from` | timestamp with time zone | ✓ | `now()` |  |
| `valid_to` | timestamp with time zone |  |  |  |

**Relasi:** `branch_id` → `branch`; `role_id` → `role`; `user_id` → `app_user`

## user_session

Sesi login; dicabut saat user dinonaktifkan (IAM-FR-013/014)

| Kolom | Tipe | Wajib | Default | Keterangan |
|---|---|---|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `tenant_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `branch_id` | uuid |  |  |  |
| `mfa_verified` | boolean | ✓ | `false` |  |
| `ip` | inet |  |  |  |
| `user_agent` | text |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `last_seen_at` | timestamp with time zone | ✓ | `now()` |  |
| `expires_at` | timestamp with time zone | ✓ |  |  |
| `revoked_at` | timestamp with time zone |  |  |  |
| `revoke_reason` | text |  |  |  |
| `token_hash` | text | ✓ |  | SHA-256 dari token sesi 256-bit di cookie; token mentah tidak pernah disimpan (SC-AUTH-06) |
| `mfa_failed_attempts` | integer | ✓ | `0` | Kode MFA salah pada sesi ini; mencapai batas → sesi dicabut (SC-AUTH-05) |

**Relasi:** `branch_id` → `branch`; `user_id` → `app_user`
