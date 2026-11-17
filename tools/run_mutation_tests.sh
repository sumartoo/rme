#!/usr/bin/env bash
# Uji mutasi kontrol keamanan (Stage 3 M1–M4 diulang di monorepo — RSK-020; M5 Stage 4; M6–M14 Stage 5; M15–M17 Stage 6; M18–M22 Stage 7; M23–M38 Stage 8; M39–M59 Stage 9; M60–M89 Stage 10; M90–M133 Stage 11; M134–M175 Stage 12, M176+ Stage 14).
# Setiap mutasi sengaja merusak satu kontrol, menjalankan suite integrasi API, dan LULUS hanya bila
# uji yang menjaga kontrol itu GAGAL. Kode selalu dikembalikan (trap), juga bila skrip dihentikan.
#
# Pemakaian: TEST_PG_ADMIN_URL=postgres://... tools/run_mutation_tests.sh
#            MUTATION_E2E=1 juga menjalankan mutasi UI (M10, butuh Chromium Playwright; lebih lama karena build ulang).
set -uo pipefail
cd "$(dirname "$0")/.."
: "${TEST_PG_ADMIN_URL:?TEST_PG_ADMIN_URL wajib diisi}"

AUTH=libs/iam/src/lib/auth.service.ts
SESSION=libs/iam/src/lib/session.service.ts
MIG2=db/migrations/0002_partition_grants_audit_partitions.sql
MIG3=db/migrations/0003_platform_identity_and_tenant_lifecycle.sql
GUARD=libs/iam/src/lib/security.guard.ts
PGUARD=libs/platform/src/lib/platform-security.guard.ts
LAYOUT=apps/platform-admin/src/app/layout.tsx
MIG5=db/migrations/0005_break_glass_and_notifications.sql
MIG6=db/migrations/0006_feature_flag_rls.sql
TOTP=libs/shared/src/lib/totp.ts
IAMUSERS=libs/iam/src/lib/users.controller.ts
ACCOUNT=libs/iam/src/lib/account.controller.ts
EXPORT=libs/db/src/lib/tenant-export.ts
AUDITCHG=libs/db/src/lib/change.ts          # auditChange (dulu masterdata/common.ts; dipakai juga modul pasien)
PRACT=libs/masterdata/src/lib/practitioners.controller.ts
MIG12=db/migrations/0012_master_services_tariffs.sql
TERM=libs/masterdata/src/lib/terminology.controller.ts
IMPORTS=libs/masterdata/src/lib/imports.controller.ts
PATIENT=libs/patient/src/lib/patient.controller.ts
MIG15=db/migrations/0015_patient_registration.sql
IDEM=libs/db/src/lib/idempotency.ts
MIG16=db/migrations/0016_scheduling.sql
BOOK=libs/scheduling/src/lib/appointment.repo.ts
SCHED=libs/scheduling/src/lib/schedules.controller.ts
NOSHOW=libs/db/src/lib/no-show.ts
ENCREPO=libs/scheduling/src/lib/encounter.repo.ts
ENCCTL=libs/scheduling/src/lib/encounters.controller.ts
QDISP=libs/scheduling/src/lib/queue-display.controller.ts
CHART=libs/clinical/src/lib/chart.controller.ts
CHARTREPO=libs/clinical/src/lib/chart.repo.ts
MIG19=db/migrations/0019_clinical_record.sql
SIGNCTL=libs/clinical/src/lib/sign.controller.ts
REAUTH=libs/clinical/src/lib/reauth.ts
MIG20=db/migrations/0020_clinical_signing.sql
RXREPO=libs/clinical/src/lib/prescription.repo.ts
RXCTL=libs/clinical/src/lib/prescription.controller.ts
MIG21=db/migrations/0021_prescription.sql
LABCTL=libs/clinical/src/lib/lab.controller.ts
DOCCTL=libs/clinical/src/lib/documents.controller.ts
MIG22=db/migrations/0022_lab_documents.sql
RECV=libs/pharmacy/src/lib/receipts.controller.ts
PRICE=libs/pharmacy/src/lib/prices.controller.ts
LOCS=libs/pharmacy/src/lib/locations.controller.ts
DISP=libs/pharmacy/src/lib/dispense.controller.ts
DREPO=libs/pharmacy/src/lib/dispense.repo.ts
RXREM=libs/db/src/lib/rx-remainder.ts
SUBC=libs/pharmacy/src/lib/substitution.controller.ts
ADJC=libs/pharmacy/src/lib/adjustments.controller.ts
OPNC=libs/pharmacy/src/lib/opname.controller.ts
CRPT=libs/pharmacy/src/lib/controlled-report.controller.ts
OTCC=libs/pharmacy/src/lib/otc.controller.ts
SRPT=libs/pharmacy/src/lib/stock-report.controller.ts
INVREPO=libs/billing/src/lib/invoice.repo.ts
INVCTL=libs/billing/src/lib/invoice.controller.ts
PAYCTL=libs/billing/src/lib/payment.controller.ts
SHIFTREPO=libs/billing/src/lib/shift.repo.ts
PAYREPO=libs/billing/src/lib/payment.repo.ts
QRCTL=libs/billing/src/lib/qris.controller.ts
CORCTL=libs/billing/src/lib/correction.controller.ts
OVCTL=libs/billing/src/lib/oversight.controller.ts
SSCTL=libs/integration/src/lib/satusehat.controller.ts
SSLIB=libs/db/src/lib/satusehat.ts
SSENC=libs/db/src/lib/satusehat-encounter.ts
SSFU=libs/db/src/lib/satusehat-followup.ts
SSREC=libs/db/src/lib/satusehat-reconcile.ts
RPTCLIN=libs/reporting/src/lib/clinical-report.controller.ts
RPTCOM=libs/reporting/src/lib/report-common.ts
RPTFIN=libs/reporting/src/lib/finance-report.controller.ts
INTEG=libs/clinical/src/lib/integrity.ts
FILES=("$AUTH" "$SESSION" "$MIG2" "$MIG3" "$GUARD" "$PGUARD" "$LAYOUT" "$EXPORT" "$MIG5" "$MIG6" "$TOTP" "$IAMUSERS" "$ACCOUNT" "$AUDITCHG" "$PRACT" "$MIG12" "$TERM" "$IMPORTS" "$PATIENT" "$MIG15" "$IDEM" "$MIG16" "$BOOK" "$SCHED" "$NOSHOW" "$ENCREPO" "$ENCCTL" "$QDISP" "$CHART" "$CHARTREPO" "$MIG19" "$SIGNCTL" "$REAUTH" "$MIG20" "$RXREPO" "$RXCTL" "$MIG21" "$LABCTL" "$DOCCTL" "$MIG22" "$RECV" "$PRICE" "$LOCS" "$DISP" "$DREPO" "$RXREM" "$SUBC" "$ADJC" "$OPNC" "$CRPT" "$OTCC" "$SRPT" "$INVREPO" "$INVCTL" "$PAYCTL" "$PAYREPO" "$QRCTL" "$CORCTL" "$OVCTL" "$SSCTL" "$SSLIB" "$SSENC" "$SSFU" "$INTEG" "$SHIFTREPO" "$SSREC" "$RPTCLIN" "$RPTCOM" "$RPTFIN")
BACKUP=$(mktemp -d)
cp "${FILES[@]}" "$BACKUP"/
restore() { for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$f"; done; }
trap restore EXIT

run_suite() { (cd apps/api && npx jest --config jest.integration.config.cts --runInBand --verbose 2>&1) | sed 's/\x1b\[[0-9;]*m//g'; }

# mutate <id> <deskripsi> <uji-yang-wajib-gagal (regex)> <perintah mutasi>
fail=0
mutate() {
  local id=$1 desc=$2 expect=$3 cmd=$4
  # MUTATION_ONLY="M16 M17" → hanya mutasi itu (cepat saat mengembangkan); default semua
  if [ -n "${MUTATION_ONLY:-}" ] && [[ " $MUTATION_ONLY " != *" $id "* ]]; then return; fi
  restore
  eval "$cmd" || { echo "$id: perintah mutasi gagal"; fail=1; return; }
  local out; out=$(eval "$5 run_suite")
  # Header kegagalan Jest: "● <describe> › <ID> <judul>"
  local failed; failed=$(echo "$out" | grep -E '^\s+● .* › [A-Z][0-9]+b? ' | sed -E 's/.* › ([A-Z][0-9]+b?) .*/\1/' | sort -u | tr '\n' ' ')
  local summary; summary=$(echo "$out" | grep -E '^Tests:')
  if echo "$failed" | grep -Eq "$expect"; then
    echo "TERDETEKSI  $id  $desc  → gagal: ${failed}| $summary"
  else
    echo "LOLOS(!)    $id  $desc  → uji yang diharapkan gagal tidak gagal (${failed:-tidak ada}) | $summary"
    fail=1
  fi
}

echo "# Uji mutasi — $(date -u +%FT%TZ)"
mutate M1 "pengecekan tenant sesi vs subdomain dihapus" 'E12' \
  "sed -i \"s/if (!hostTenantId || s.tenant_id !== hostTenantId) return { ok: false, reason: 'TENANT_MISMATCH' };/if (!hostTenantId) return { ok: false, reason: 'TENANT_MISMATCH' };/\" $SESSION && grep -q 'if (!hostTenantId) return' $SESSION" ""
mutate M2 "role DB aplikasi diberi BYPASSRLS" 'E1[0-3]' "true" "CRME_MUTATION=M2"
mutate M3 "batas percobaan MFA dilonggarkan" 'E32' \
  "sed -i 's/s.mfa_failed_attempts >= this.cfg.mfaMaxAttempts/s.mfa_failed_attempts >= 1000/' $AUTH && grep -q '>= 1000' $AUTH" ""
mutate M4 "rotasi sesi saat MFA dihapus" 'E08' \
  "sed -i \"/revoke_reason = 'ROTATED_MFA'/d\" $AUTH && ! grep -q ROTATED_MFA $AUTH" ""
mutate M5 "partisi audit kembali dapat diakses role aplikasi (perbaikan migrasi 0002 dihapus)" 'F14' \
  "sed -i \"/EXECUTE format('REVOKE ALL ON %s FROM PUBLIC/d\" $MIG2 && ! grep -q \"REVOKE ALL ON %s FROM\" $MIG2" ""
mutate M6 "role DB platform diberi SELECT pada tabel klinis" 'P15' "true" "CRME_MUTATION=M6"
mutate M7 "guard klinik tidak lagi memblokir sesi saat tenant SUSPENDED" 'P12' \
  "sed -i \"s/if (c.hostTenantStatus === 'SUSPENDED' \&\& /if (false \&\& /\" $GUARD && grep -q 'if (false && ' $GUARD" ""
mutate M8 "guard platform tidak mewajibkan MFA" 'P01' \
  "sed -i 's/if (!s.mfa_verified \&\& !meta<boolean>(ALLOW_WITHOUT_MFA_KEY))/if (false)/' $PGUARD && grep -q 'if (false)' $PGUARD" ""
mutate M9 "trigger kuota user dihapus dari migrasi 0003" 'P16' \
  "sed -i '/CREATE TRIGGER trg_quota_users/,+1d' $MIG3 && ! grep -q trg_quota_users $MIG3" ""
mutate M11 "ekspor tenant dibaca tanpa SET ROLE clinicrme_app (koneksi pemilik melewati RLS)" 'K05' \
  "sed -i \"/set local role clinicrme_app/d\" $EXPORT && ! grep -q 'set local role' $EXPORT" ""
mutate M12 "fungsi break-glass tidak lagi memeriksa masa berlaku grant" 'B06' \
  "sed -i 's/AND now() >= starts_at AND now() < expires_at;/;/' $MIG5 && ! grep -q 'now() < expires_at' $MIG5" ""
mutate M13 "sesi tanpa MFA boleh mendaftar ulang authenticator (menimpa secret)" 'E33' \
  "sed -i 's/if (existing \&\& !c.mfaVerified) throw/if (false) throw/' $AUTH && grep -q 'if (false) throw' $AUTH" ""
mutate M14 "RLS tenant_feature_flag tidak diaktifkan (migrasi 0006)" 'K10' \
  "sed -i '/ENABLE ROW LEVEL SECURITY/d' $MIG6 && ! grep -q 'ENABLE ROW LEVEL' $MIG6" ""
mutate M15 "anti-replay TOTP dimatikan (kode yang sama boleh dipakai ulang)" 'E34' \
  "sed -i 's/step <= Number(lastStep)/false/' $TOTP && grep -q 'null && false' $TOTP" ""
mutate M16 "pencegahan eskalasi hak dimatikan (pemberi boleh memberi izin admin yang tidak dimilikinya)" 'I04' \
  "sed -i 's/ADMIN_PERMISSION.test(p) \&\& !mine.has(p)/false/' $IAMUSERS && grep -q 'some((p) => false)' $IAMUSERS" ""
mutate M17 "token reset password dapat dipakai ulang (used_at tidak diperiksa)" 'I06' \
  "sed -i 's/ and r.used_at is null and r.expires_at > now()/ and r.expires_at > now()/; s/ where id = \${r.id} and used_at is null returning id/ where id = \${r.id} returning id/' $ACCOUNT && ! grep -q 'r.used_at is null' $ACCOUNT" ""
mutate M18 "audit master tidak menyamarkan kolom rahasia (NIK)" 'M06' \
  "sed -i \"s/secret.includes(k) \&\& v !== null ? '\[rahasia\]' : v/v/\" $AUDITCHG && ! grep -q \"? '\[rahasia\]' : v\" $AUDITCHG" ""
mutate M19 "NIK tenaga kesehatan dikembalikan utuh di respons (tanpa penyamaran)" 'M06' \
  "sed -i 's/(nik ? \`\${nik.slice(0, 4)}\*\*\*\*\*\*\*\*\${nik.slice(-4)}\` : null)/nik/' $PRACT && ! grep -q 'nik.slice(0, 4)' $PRACT" ""
mutate M20 "tarif dapat ditimpa (trigger tariff_guard tidak dipasang)" 'M13' \
  "sed -i '/^CREATE TRIGGER trg_tariff_guard/d' $MIG12 && ! grep -q 'trg_tariff_guard BEFORE' $MIG12" ""
mutate M21 "favorit diagnosis dapat divalidasi siapa saja (pemeriksaan dokter/SIP OD-084 dilewati)" 'M22' \
  "sed -i 's/      if (b.validated) await this.assertValidator(tx);/      if (b.validated \&\& false) await this.assertValidator(tx);/' $TERM && grep -q 'b.validated && false' $TERM" ""
mutate M22 "impor menyimpan sebagian walau ada baris error (bukan satu transaksi utuh)" 'M24' \
  "sed -i 's/        if (dryRun || errors.length) throw rollback;/        if (dryRun) throw rollback;/' $IMPORTS && grep -q '        if (dryRun) throw rollback;' $IMPORTS" ""
mutate M23 "data pasien dapat dihapus role aplikasi (REVOKE DELETE migrasi 0015 dihapus)" 'P12' \
  "sed -i '/^REVOKE DELETE ON patient FROM clinicrme_app;/d' $MIG15 && ! grep -q '^REVOKE DELETE ON patient FROM' $MIG15" ""
mutate M24 "Idempotency-Key diabaikan (klik ganda membuat pasien ganda / gagal)" 'P02' \
  "sed -i 's/^  if (prev) {/  if (prev \&\& false) {/' $IDEM && grep -q 'if (prev && false) {' $IDEM" ""
mutate M25 "registrasi mengabaikan kandidat duplikat (alasan tidak lagi wajib)" 'P05' \
  "sed -i 's/if (found.candidates.length > 0 \&\& !b.duplicateOverrideReason) {/if (false) {/' $PATIENT && grep -q 'if (false) {' $PATIENT" ""
mutate M26 "NIK pasien tercatat apa adanya di audit registrasi" 'P01|P14' \
  "sed -i 's/      after: this.auditView(d, dup.nikHash, dup.identityHash),/      after: { ...this.auditView(d, dup.nikHash, dup.identityHash), nik: b.nik },/' $PATIENT && grep -q 'nik: b.nik },' $PATIENT" ""
mutate M27 "jadwal dokter boleh tumpang tindih (exclusion constraint dilemahkan)" 'S01' \
  "sed -i 's/    app.timerange(start_time, end_time) WITH \\&\\&,/    id WITH =,/' $MIG16 && ! grep -q 'app.timerange(start_time, end_time) WITH' $MIG16" ""
mutate M28 "kuota sesi janji temu tidak diperiksa" 'S04|S05' \
  "sed -i 's/  if (n >= s.quota) throw/  if (false) throw/' $BOOK && grep -q 'if (false) throw' $BOOK" ""
mutate M29 "pemesanan mengabaikan cuti dokter / libur cabang" 'S08' \
  "sed -i 's/  if (ex) throw problem(409, .SCH-409-CLOSED./  if (false \\&\\& ex) throw problem(409, \\x27SCH-409-CLOSED\\x27/' $BOOK && grep -q 'if (false && ex) throw' $BOOK" ""
mutate M30 "no-show otomatis menandai janji sebelum sesi praktik berakhir" 'S11' \
  "sed -i 's/(((a.slot_start at time zone b.timezone)::date + s.end_time) at time zone b.timezone),/a.slot_start,/' $NOSHOW && grep -q '^               a.slot_start,\$' $NOSHOW" ""
mutate M31 "perubahan jadwal tidak memeriksa janji temu mendatang" 'S09' \
  "sed -i 's/      await this.assertBookingsStillFit(tx, id);/      \\/\\/ dimatikan/' $SCHED && grep -q '// dimatikan' $SCHED" ""
mutate M32 "penjamin asuransi tanpa verifikasi kepesertaan diterima" 'Q02' \
  "sed -i 's/    else if (!b.eligibilityNote?.trim()) {/    else if (false) {/' $ENCREPO && grep -q 'else if (false) {' $ENCREPO" ""
mutate M33 "pasien janji temu terlambat tetap mendapat urutan jam slot" 'Q03' \
  "sed -i 's/sortKey: a.late ? new Date().toISOString() : slot/sortKey: slot/' $ENCCTL && grep -q 'sortKey: slot,' $ENCCTL" ""
mutate M34 "batal kunjungan tidak membatalkan tiket antrean" 'Q07' \
  "sed -i '/update queue_ticket set status = .CANCELLED./,+1d' $ENCCTL && ! grep -q 'update queue_ticket set status' $ENCCTL" ""
mutate M35 "pasien dapat didaftarkan dua kali di poli yang sama pada hari yang sama" 'Q01' \
  "sed -i 's/  if (active) throw/  if (false) throw/' $ENCREPO && grep -q 'if (false) throw' $ENCREPO" ""
mutate M36 "tautan layar antrean yang sudah dicabut tetap dapat dibuka" 'D04' \
  "sed -i 's/ where token_hash = \${sha256(token)} and revoked_at is null\$/ where token_hash = \${sha256(token)}/' $QDISP && grep -qxF '       where token_hash = \${sha256(token)}' $QDISP" ""
mutate M37 "layar antrean menampilkan inisial pasien walau pengaturan klinik mati" 'D02' \
  "sed -i 's/\${b.initials ? sql.p.full_name. : sql.null::text.} as patient_name/p.full_name as patient_name/' $QDISP && grep -q '           p.full_name as patient_name' $QDISP" ""
mutate M38 "perubahan antrean tidak memberi sinyal ke layar TV" 'D03' \
  "sed -i \"s/  await tx.execute(sql.select pg_notify('clinicrme_queue'.*/  void tx;/\" $ENCREPO && grep -q '^  void tx;\$' $ENCREPO" ""

mutate M39 "rekam medis yang sudah disahkan masih dapat ditulisi lewat API" 'C10' \
  "sed -i \"s/  if (e.note_status === 'SIGNED') throw/  if (false) throw/\" $CHARTREPO && grep -q '  if (false) throw' $CHARTREPO" ""
mutate M40 "pembukaan rekam medis tidak tercatat di audit" 'C08' \
  "sed -i \"s/      await audit(tx, 'CLINICAL_RECORD_READ'/      void (tx, 'CLINICAL_RECORD_READ'/\" $CHART && grep -q \"void (tx, 'CLINICAL_RECORD_READ'\" $CHART" ""
mutate M41 "kode non-ICD-10 diterima sebagai diagnosis" 'C05' \
  "sed -i \"s/ and c.is_active and s.is_current and s.code = 'ICD10'/ and c.is_active/\" $CHART && ! grep -q \"s.code = 'ICD10'\" $CHART" ""
mutate M42 "role aplikasi dapat menghapus data alergi pasien" 'C07' \
  "sed -i 's/^REVOKE DELETE ON allergy_intolerance, /REVOKE DELETE ON /' $MIG19 && grep -q '^REVOKE DELETE ON patient_history, observation' $MIG19" ""
mutate M43 "perawat dapat menulis SOAP lengkap (melewati OD-092)" 'C03' \
  "sed -i \"s/@RequirePermission('clinical.note.write') @BodySchema(NoteBody)/@RequirePermission('clinical.vitals.write') @BodySchema(NoteBody)/\" $CHART && grep -q \"'clinical.vitals.write') @BodySchema(NoteBody)\" $CHART" ""

mutate M44 "pengesahan tanpa konfirmasi ulang kata sandi/TOTP" 'C12' \
  "sed -i '0,/    const method = await reauthenticate(this.db, this.cfg, b);/s//    const method = \x27PASSWORD\x27 as const;/' $SIGNCTL && grep -q \"const method = 'PASSWORD' as const;\" $SIGNCTL" ""
mutate M45 "rekam medis tanpa SOAP lengkap / diagnosis primer dapat disahkan" 'C11' \
  "sed -i 's/    if (missing.length) throw/    if (false \&\& missing.length) throw/' $SIGNCTL && grep -q 'if (false && missing.length) throw' $SIGNCTL" ""
mutate M46 "dokter yang tidak bertugas di cabang dapat mengesahkan sebagai pengganti" 'C14' \
  "sed -i 's/      if (!onDuty) throw/      if (false) throw/' $SIGNCTL && grep -q '      if (false) throw' $SIGNCTL" ""
mutate M47 "addendum dapat ditambahkan ke catatan yang belum disahkan (database)" 'C16' \
  "sed -i '/^CREATE TRIGGER trg_addendum_insert/d' $MIG20 && ! grep -q 'trg_addendum_insert BEFORE' $MIG20" ""
mutate M48 "verifikasi hash selalu menyatakan valid" 'C17' \
  "sed -i 's/valid: recomputed === n.content_hash,/valid: true,/' $SIGNCTL && grep -q 'valid: true,' $SIGNCTL" ""
mutate M49 "kode TOTP yang sama dapat dipakai ulang untuk pengesahan" 'C15' \
  "sed -i '/      await tx.execute(sql\`update user_mfa set last_totp_step/d' $REAUTH && ! grep -q 'last_totp_step = ' $REAUTH" ""

mutate M50 "resep obat yang pasiennya alergi tidak memicu peringatan" 'C23|C24' \
  "sed -i 's/      const hit = allergies.find((a) => ing.includes(a) || a.includes(ing));/      const hit = undefined as string | undefined; void allergies;/' $RXREPO && grep -q 'const hit = undefined as string' $RXREPO" ""
mutate M51 "resep diterbitkan walau peringatan belum diberi alasan" 'C24' \
  "sed -i 's/        if (open.length) throw/        if (false \&\& open.length) throw/' $RXCTL && grep -q 'if (false && open.length) throw' $RXCTL" ""
mutate M52 "konsultasi dapat diselesaikan sebelum rekam medis disahkan" 'C24' \
  "sed -i \"s/      if (n?.status !== 'SIGNED') throw/      if (false) throw/\" $RXCTL && grep -q '      if (false) throw' $RXCTL" ""
mutate M53 "komponen racikan dapat diubah setelah resep diterbitkan (database)" 'C24' \
  "sed -i '/^CREATE TRIGGER trg_compound_component_guard/,+1d' $MIG21 && ! grep -q 'trg_compound_component_guard BEFORE' $MIG21" ""
mutate M54 "peringatan tidak dihitung ulang saat resep diterbitkan" 'C25' \
  "sed -i 's/await computeAlerts(tx, e.patient_id, lines), rx.alerts/rx.alerts, rx.alerts/' $RXCTL && grep -q 'this.withReasons(rx.alerts, rx.alerts' $RXCTL" ""

mutate M55 "order lab menerima layanan yang bukan pemeriksaan lab" 'C26' \
  "sed -i \"s/ and is_active and service_type = 'LAB'\\\`);/ and is_active\\\`);/\" $LABCTL && ! grep -q \"service_type = 'LAB'\" $LABCTL" ""
mutate M56 "unggahan hasil lab bukan PDF diterima" 'C28' \
  "sed -i \"s/ || body.subarray(0, 5).toString('latin1') !== '%PDF-'//\" $LABCTL && ! grep -q \"'%PDF-'\" $LABCTL" ""
mutate M57 "dokumen medis dapat diterbitkan dari rekam medis yang belum disahkan" 'C29' \
  "sed -i \"s/    if (c.note_status !== 'SIGNED') throw/    if (false) throw/\" $DOCCTL && grep -q '    if (false) throw' $DOCCTL" ""
mutate M58 "hasil lab dapat diubah/dihapus role aplikasi" 'C27' \
  "sed -i '/^REVOKE UPDATE, DELETE ON lab_result FROM clinicrme_app;/d' $MIG22 && ! grep -q 'ON lab_result FROM' $MIG22" ""
mutate M59 "unduhan PDF dokumen medis tidak tercatat di audit" 'C29' \
  "sed -i \"s/      await audit(tx, 'MEDICAL_DOCUMENT_READ'/      void (tx, 'MEDICAL_DOCUMENT_READ'/\" $DOCCTL && grep -q \"void (tx, 'MEDICAL_DOCUMENT_READ'\" $DOCCTL" ""

mutate M60 "penerimaan barang menerima batch yang sudah kedaluwarsa" 'P04' \
  "sed -i 's/        if (l.expiryDate <= today) errors.push/        if (false) errors.push/' $RECV && grep -q '        if (false) errors.push' $RECV" ""
mutate M61 "obat golongan terbatas dapat diterima tanpa izin khusus" 'P04' \
  "sed -i 's/        if (RESTRICTED.includes(d.drug_class) \&\& /        if (false \&\& /' $RECV && grep -q 'if (false && !ctx()' $RECV" ""
mutate M62 "jumlah penerimaan tidak dikonversi ke satuan dasar" 'P03' \
  "sed -i 's/Math.round(l.qty \* factor \* 10_000)/Math.round(l.qty * 10_000)/' $RECV && grep -q 'Math.round(l.qty \* 10_000)' $RECV" ""
mutate M63 "faktur yang sama dapat diterima dua kali" 'P03' \
  "sed -i 's/      if (dupInv) throw/      if (false) throw/' $RECV && grep -q '      if (false) throw' $RECV" ""
mutate M64 "harga jual boleh melebihi HET" 'P02' \
  "sed -i 's/    if (b.het \&\& Number(b.sellPrice) > Number(b.het)) throw/    if (false) throw/' $PRICE && grep -q '    if (false) throw' $PRICE" ""
mutate M65 "lokasi stok bawaan cabang dapat dinonaktifkan" 'P01' \
  "sed -i 's/      if (cur.is_default \&\& b.isActive === false) throw/      if (false) throw/' $LOCS && grep -q '      if (false) throw' $LOCS" ""

mutate M66 "penyerahan mengeluarkan batch yang diterima lebih dulu, bukan kedaluwarsa terdekat (FEFO)" 'D01|D03' \
  "sed -i 's/: sql\`sb.expiry_date, sb.created_at\`}/: sql\`sb.created_at, sb.expiry_date\`}/' $DREPO && grep -q ': sql\`sb.created_at, sb.expiry_date\`}' $DREPO" ""
mutate M67 "telaah dengan masalah tetap memverifikasi resep" 'D02' \
  "sed -i 's/const result = Object.values(b.items).every((x) => x.ok) ? /const result = true ? /' $DISP && grep -q 'const result = true ? ' $DISP" ""
mutate M68 "obat dapat diserahkan sebelum telaah selesai" 'D02' \
  "sed -i \"s/      if (h.status === 'ISSUED') throw/      if (false) throw/\" $DISP && grep -q '      if (false) throw' $DISP" ""
mutate M69 "obat tanpa harga jual berlaku tetap diserahkan" 'D06' \
  "sed -i 's/          if (!price) { errors.push/          if (false) { errors.push/' $DISP && grep -q '          if (false) { errors.push' $DISP" ""
mutate M70 "racikan dapat diserahkan sebagian" 'D05' \
  "sed -i 's/        if (it.is_compound \&\& round4(l.qty) !== rem)/        if (false \&\& round4(l.qty) !== rem)/' $DISP && grep -q 'if (false && round4(l.qty) !== rem)' $DISP" ""
mutate M71 "obat golongan terbatas diserahkan tanpa izin khusus" 'D06' \
  "sed -i 's/          if (RESTRICTED.includes(need.drugClass)) assertRestrictedAllowed/          if (false) assertRestrictedAllowed/' $DISP && grep -q 'if (false) assertRestrictedAllowed' $DISP" ""
mutate M72 "stok tidak dikunci saat penyerahan bersamaan" 'D08' \
  "sed -i 's/  for (const d of \[...new Set(drugItemIds)\].sort()) {/  for (const d of [] as string[]) {/' $DREPO && grep -q 'for (const d of \[\] as string\[\])' $DREPO" ""
mutate M73 "sisa resep lewat batas ambil tidak ditutup otomatis" 'D04' \
  "sed -i \"s/     where p.status = 'PARTIALLY_DISPENSED'/     where false and p.status = 'PARTIALLY_DISPENSED'/\" $RXREM && grep -q 'where false and p.status' $RXREM" ""
mutate M74 "sisa resep tetap dapat diambil setelah batas waktu" 'D04' \
  "sed -i 's/      if (h.first_dispensed_at \&\& Date.parse/      if (false \&\& Date.parse/' $DISP && grep -q 'if (false && Date.parse' $DISP" ""

mutate M75 "substitusi dapat diputuskan dokter yang bukan penulis resep dan tidak bertugas" 'S02' \
  "sed -i 's/      if (!s.eligible) throw/      if (false) throw/' $SUBC && grep -q '      if (false) throw' $SUBC" ""
mutate M76 "obat asli tidak tercatat saat substitusi disetujui" 'S02' \
  "sed -i 's/substituted_from_drug_id = coalesce(substituted_from_drug_id, \${s.from_drug_id})/substituted_from_drug_id = null/' $SUBC && grep -q 'substituted_from_drug_id = null' $SUBC" ""
mutate M77 "baris yang menunggu substitusi tetap dapat diserahkan" 'S01' \
  "sed -i 's/        if (held.has(it.id)) {/        if (false) {/' $DISP && grep -q '        if (false) {' $DISP" ""
mutate M78 "pengaju dapat menyetujui penyesuaian stoknya sendiri" 'S03' \
  "sed -i 's/      if (cur.requested_by === ctx().userId) throw/      if (false) throw/' $ADJC && grep -q '      if (false) throw' $ADJC" ""
mutate M79 "penyesuaian disetujui walau saldo sekarang tidak cukup" 'S03' \
  "sed -i 's/        if (Number(q) + Number(cur.qty_delta) < 0) throw/        if (false) throw/' $ADJC && grep -q '        if (false) throw' $ADJC" ""
mutate M80 "yang memulai stock opname dapat menyetujuinya sendiri" 'S05' \
  "sed -i 's/      if (h.started_by === ctx().userId) throw/      if (false) throw/' $OPNC && grep -q '      if (false) throw' $OPNC" ""
mutate M81 "hasil opname dapat dikirim tanpa catatan untuk selisih" 'S04' \
  "sed -i 's/ or (x.counted_qty <> x.system_qty and coalesce(length(trim(x.note)), 0) < 3))/ or false)/' $OPNC && grep -q ' or false)' $OPNC" ""
mutate M82 "batch obat golongan terbatas dapat dihitung tanpa izin khusus" 'S04' \
  "sed -i 's/        if (RESTRICTED.includes(bt.drug_class) \&\& !ctx/        if (false \&\& !ctx/' $OPNC && grep -q 'if (false && !ctx' $OPNC" ""
mutate M83 "laporan obat terbatas tidak menghitung pengeluaran resep" 'S06' \
  "sed -i \"s/and mv.movement_type = 'DISPENSE'), 0))::text as dispensed/and mv.movement_type = 'OTC_SALE'), 0))::text as dispensed/\" $CRPT && grep -q \"'OTC_SALE'), 0))::text as dispensed\" $CRPT" ""

mutate M84 "obat keras dapat dijual bebas tanpa resep" 'G01' \
  "sed -i 's/        if (!OTC_CLASSES.includes(d.drug_class)) {/        if (false) {/' $OTCC && grep -q '        if (false) {' $OTCC" ""
mutate M85 "penjualan bebas memakai harga penjamin selain Umum" 'G01' \
  "sed -i \"s/currentPrice(tx, d.id, b.branchId, 'UMUM', br.today)/currentPrice(tx, d.id, b.branchId, 'BPJS', br.today)/\" $OTCC && grep -q \"'BPJS', br.today\" $OTCC" ""
mutate M86 "penjualan yang sudah dibayar/dibatalkan dapat dibatalkan lagi" 'G01' \
  "sed -i \"s/      if (s.status !== 'AWAITING_PAYMENT') throw/      if (false) throw/\" $OTCC && grep -q '      if (false) throw' $OTCC" ""
mutate M87 "stok tidak dikunci saat penjualan bebas" 'G04' \
  "sed -i 's/      await lockStock(tx, loc.id, ids);/      void ids;/' $OTCC && grep -q '      void ids;' $OTCC" ""
mutate M88 "laporan stok menghitung retur masuk sebagai penerimaan" 'G02' \
  "sed -i \"s/\\['RETURN_IN'\\])} as returned_in/['RECEIPT'])} as returned_in/\" $SRPT && grep -q \"'RECEIPT'\\])} as returned_in\" $SRPT" ""
mutate M89 "laporan stok tidak menghitung saldo awal" 'G02' \
  "sed -i 's/filter (where mv.occurred_at < \${b.t0}::timestamptz), 0))::text as opening/filter (where false), 0))::text as opening/' $SRPT && grep -q 'filter (where false), 0))::text as opening' $SRPT" ""

mutate M90 "tarif khusus penjamin tidak diprioritaskan di atas tarif umum" 'B05' \
  "sed -i 's/     order by (payer_id is not null) desc, (payer_type is not null) desc,/     order by (payer_id is not null) asc, (payer_type is not null) asc,/' $INVREPO && grep -q 'order by (payer_id is not null) asc' $INVREPO" ""
mutate M91 "co-pay penjamin diabaikan (pasien tidak menanggung bagiannya)" 'B05' \
  "sed -i 's/  const copay = Number(c.contract?.copayPercent ?? 0);/  const copay = 0;/' $INVREPO && grep -q '  const copay = 0;' $INVREPO" ""
mutate M92 "plafon penjamin per kunjungan diabaikan" 'B05' \
  "sed -i 's/  let cap = c.contract?.plafon !== undefined .*/  let cap = Infinity;/' $INVREPO && grep -q '  let cap = Infinity;' $INVREPO" ""
mutate M93 "diskon di atas batas klinik tidak perlu persetujuan" 'B04' \
  "sed -i \"s/pct > lim + 1e-9 ? 'PENDING'/false ? 'PENDING'/\" $INVCTL && grep -q \"false ? 'PENDING'\" $INVCTL" ""
mutate M94 "peminta diskon dapat menyetujui diskonnya sendiri" 'B04' \
  "sed -i 's/      if (l.discountRequestedBy === ctx().userId) throw/      if (false) throw/' $INVCTL && grep -q '      if (false) throw' $INVCTL" ""
mutate M95 "tagihan dapat terbit walau diskon masih menunggu persetujuan" 'B04' \
  "sed -i 's/      if (s.pending) throw/      if (false) throw/' $INVCTL && grep -q '      if (false) throw' $INVCTL" ""
mutate M96 "obat yang ditagih tidak ditandai BILLED saat terbit (dapat ditagih dua kali)" 'B03' \
  "sed -i \"s/update dispense_line set billing_status = 'BILLED'/update dispense_line set billing_status = 'UNBILLED'/\" $INVCTL && grep -q \"set billing_status = 'UNBILLED'\" $INVCTL" ""
mutate M97 "tagihan terbit masih dapat diubah lewat API" 'B03' \
  "sed -i \"s/    if (h.status !== 'DRAFT') throw problem(409, 'BIL-409-NOT-DRAFT', 'Tagihan sudah diterbitkan dan tidak dapat diubah');/    void h.status;/\" $INVCTL && grep -q '    void h.status;' $INVCTL" ""
mutate M98 "diskon dapat diberikan tanpa alasan" 'B04' \
  "sed -i \"s/        if (b.discountAmount > 0 \&\& (b.discountReason ?? '').length < 3) throw/        if (false) throw/\" $INVCTL && grep -q '        if (false) throw' $INVCTL" ""
mutate M99 "layanan tanpa tarif berlaku dilewati diam-diam saat membuat draf" 'B02' \
  "sed -i 's/  if (missing.length) throw/  if (false) throw/' $INVREPO && grep -q '  if (false) throw' $INVREPO" ""

mutate M100 "pembayaran dapat dicatat tanpa shift kasir terbuka" 'L01' \
  "sed -i 's/      if (!s) throw problem(409, .BIL-409-NO-SHIFT./      if (false) throw problem(409, \x27BIL-409-NO-SHIFT\x27/' $PAYCTL && grep -q 'if (false) throw problem(409, .BIL-409-NO-SHIFT' $PAYCTL" ""
mutate M101 "pembayaran melebihi sisa tagihan diterima" 'L02' \
  "sed -i 's/      if (b.amount > Number(o.outstanding) + 0.001) {/      if (false) {/' $PAYCTL && grep -q '      if (false) {' $PAYCTL" ""
mutate M102 "pembayaran non-tunai tanpa nomor referensi diterima" 'L02' \
  "sed -i \"s/      if (b.method !== 'TUNAI' \&\& (reference ?? '').length < 3) throw/      if (false) throw/\" $PAYCTL && grep -q '      if (false) throw' $PAYCTL" ""
mutate M103 "pembayaran sebagian langsung dianggap lunas" 'L02' \
  "sed -i \"s/paid + 0.005 >= Number(i.patient_portion) ? 'PAID'/paid > 0 ? 'PAID'/\" $PAYREPO && grep -q \"paid > 0 ? 'PAID'\" $PAYREPO" ""
mutate M104 "tagihan lunas tidak menyelesaikan kunjungan / penjualan bebas" 'L0[256]' \
  "sed -i \"s/  if (status === 'PAID' \&\& i.status !== 'PAID') await onPaid/  if (false) await onPaid/\" $PAYREPO && grep -q '  if (false) await onPaid' $PAYREPO" ""
mutate M105 "alur kasir-dulu tidak meneruskan kunjungan ke farmasi" 'L05' \
  "sed -i \"s/  const next = !e.pharmacy_first \&\& e.open_rx ? 'PHARMACY'/  const next = false ? 'PHARMACY'/\" $PAYREPO && grep -q \"const next = false ? 'PHARMACY'\" $PAYREPO" ""
mutate M106 "porsi penjamin tidak menjadi piutang saat terbit" 'L04' \
  "sed -i 's/      const receivable = await createReceivable(tx, id);/      const receivable = null as { amount: string } | null;/' $INVCTL && grep -q 'const receivable = null as' $INVCTL" ""
mutate M107 "selisih kas di atas toleransi tidak wajib keterangan" 'L03' \
  "sed -i \"s/      if (Math.abs(variance) > tol + 1e-9 \&\& (note ?? '').length < 5) {/      if (false) {/\" $PAYCTL && grep -q '      if (false) {' $PAYCTL" ""
mutate M108 "shift kasir dapat ditutup oleh kasir lain" 'L03' \
  "sed -i 's/      if (s.cashier_id !== ctx().userId) throw/      if (false) throw/' $PAYCTL && grep -q '      if (false) throw' $PAYCTL" ""
mutate M109 "kas yang diharapkan tidak menghitung pembayaran tunai" 'L03' \
  "sed -i \"s/where p.shift_id = s.id and p.method = 'TUNAI'), 0)::text as cash_in/where p.shift_id = s.id and false), 0)::text as cash_in/\" $SHIFTREPO && grep -q 'and false), 0)::text as cash_in' $SHIFTREPO" ""
mutate M110 "penjualan obat bebas tidak menjadi PAID saat tagihan lunas" 'L06' \
  "sed -i \"s/    await tx.execute(sql\\\`update otc_sale set status = 'PAID'/    await tx.execute(sql\\\`update otc_sale set status = 'AWAITING_PAYMENT'/\" $PAYREPO && grep -q \"set status = 'AWAITING_PAYMENT' where id\" $PAYREPO" ""

mutate M111 "callback QRIS diterima tanpa verifikasi signature" 'R01' \
  "sed -i 's/    if (!this.gw.verifySignature(raw, headers)) {/    if (false) {/' $QRCTL && grep -q '    if (false) {' $QRCTL" ""
mutate M112 "callback QRIS ganda diproses ulang" 'R01' \
  "sed -i \"s/      if (t.status === 'PAID') {/      if (false) {/\" $QRCTL && grep -q '      if (false) {' $QRCTL" ""
mutate M113 "callback QRIS dengan nominal berbeda tetap dicatat" 'R01' \
  "sed -i 's/      if (Math.abs(ev.amount - Number(t.amount)) > 0.001) {/      if (false) {/' $QRCTL && grep -q '      if (false) {' $QRCTL" ""
mutate M114 "QR QRIS dapat dibuat tanpa shift kasir terbuka" 'R01' \
  "sed -i 's/      if (!s) throw problem(409, .BIL-409-NO-SHIFT./      if (false) throw problem(409, \x27BIL-409-NO-SHIFT\x27/' $QRCTL && grep -q 'if (false) throw problem(409, .BIL-409-NO-SHIFT' $QRCTL" ""
mutate M115 "rekonsiliasi tidak mendeteksi nominal settlement yang berbeda" 'R03' \
  "sed -i 's/ or sl.amount <> sl.txn_amount$//' $QRCTL && ! grep -q 'or sl.amount <> sl.txn_amount' $QRCTL" ""
mutate M116 "tagihan yang sedang diajukan void tetap menerima pembayaran" 'R04' \
  "sed -i 's/  if (v) throw problem(409, .BIL-409-VOID-PENDING./  if (false) throw problem(409, \x27BIL-409-VOID-PENDING\x27/' $PAYREPO && grep -q 'if (false) throw problem(409, .BIL-409-VOID-PENDING' $PAYREPO" ""
mutate M117 "pengaju void dapat menyetujui void-nya sendiri" 'R04' \
  "sed -i 's/      if (v.requested_by === ctx().userId) throw/      if (false) throw/' $CORCTL && grep -q '      if (false) throw' $CORCTL" ""
mutate M118 "void tidak mengembalikan obat ke status belum ditagih" 'R04' \
  "sed -i \"s/with u as (update dispense_line set billing_status = 'UNBILLED', invoice_line_id = null/with u as (update dispense_line set invoice_line_id = invoice_line_id/\" $CORCTL && grep -q 'set invoice_line_id = invoice_line_id' $CORCTL" ""
mutate M119 "refund melebihi nominal pembayaran diterima" 'R05' \
  "sed -i 's/      if (b.amount > room + 0.001) throw/      if (false) throw/' $CORCTL && grep -q '      if (false) throw' $CORCTL" ""
mutate M120 "pengaju refund dapat menyetujui refund-nya sendiri" 'R05' \
  "sed -i 's/      if (r.requested_by === ctx().userId) throw/      if (false) throw/' $CORCTL && grep -q '      if (false) throw' $CORCTL" ""
mutate M121 "refund disetujui tidak menghitung ulang status tagihan" 'R05' \
  "sed -i 's/      const status = await settleInvoice(tx, r.invoice_id);/      const status = \x27TIDAK\x27;/' $CORCTL && grep -q \"const status = 'TIDAK';\" $CORCTL" ""
mutate M122 "kas shift yang diharapkan tidak dikurangi refund tunai" 'R05' \
  "sed -i 's/Number(s.cash_in) - Number(s.cash_refund)/Number(s.cash_in) - 0/' $SHIFTREPO && grep -q 'Number(s.cash_in) - 0' $SHIFTREPO" ""
mutate M123 "refund tunai disetujui walau shift pengaju sudah ditutup" 'R05' \
  "sed -i \"s/      if (r.method === 'TUNAI' \&\& r.shift_status !== 'OPEN') {/      if (false) {/\" $CORCTL && grep -q '      if (false) {' $CORCTL" ""

mutate M124 "pelunasan piutang melebihi saldo diterima" 'H01' \
  "sed -i 's/      if (b.amount > Number(r.balance) + 0.001) throw/      if (false) throw/' $OVCTL && grep -q '      if (false) throw' $OVCTL" ""
mutate M125 "piutang tidak pernah menjadi lunas" 'H01' \
  "sed -i \"s/then 'PAID' else 'PARTIAL' end/then 'PARTIAL' else 'PARTIAL' end/\" $OVCTL && grep -q \"then 'PARTIAL' else 'PARTIAL' end\" $OVCTL" ""
mutate M126 "piutang lunas/batal masih menerima pelunasan" 'H01' \
  "sed -i \"s/      if (r.status !== 'OPEN' \&\& r.status !== 'PARTIAL') throw/      if (false) throw/\" $OVCTL && grep -q '      if (false) throw' $OVCTL" ""
mutate M127 "kasir dapat memverifikasi shift miliknya sendiri" 'H02' \
  "sed -i 's/      if (s.cashier_id === ctx().userId) throw problem(403/      if (false) throw problem(403/' $OVCTL && grep -q 'if (false) throw problem(403' $OVCTL" ""
mutate M128 "verifikasi shift dengan selisih di atas toleransi tanpa catatan" 'H02' \
  "sed -i 's/      if (Math.abs(Number(s.variance ?? 0)) > tol + 1e-9 \&\& (note ?? .*/      if (false) {/' $OVCTL && grep -q '      if (false) {' $OVCTL" ""
mutate M129 "batas void per kasir per shift tidak ditandai" 'H03' \
  "sed -i 's/         where n.n > \${c.voids}::int and/         where n.n > 999 and/' $OVCTL && grep -q 'where n.n > 999 and' $OVCTL" ""
mutate M130 "void/refund di luar jam operasional tidak ditandai (logika jam terbalik)" 'H03' \
  "sed -i 's/        sql\`not ((/        sql\`((/' $OVCTL && ! grep -q 'sql\`not ((' $OVCTL" ""
mutate M131 "selisih kas di atas toleransi tidak ditandai" 'H03' \
  "sed -i 's/abs(s.variance) > \${c.tol}::numeric/abs(s.variance) > 100000000/' $OVCTL && grep -q 'abs(s.variance) > 100000000' $OVCTL" ""
mutate M132 "diskon di atas batas yang sudah disetujui tidak ditandai" 'H03' \
  "sed -i \"s/l.discount_status in ('PENDING', 'APPROVED')/l.discount_status in ('PENDING')/\" $OVCTL && grep -q \"l.discount_status in ('PENDING')\" $OVCTL" ""
mutate M133 "bayar tunai + QRIS melebihi tagihan tidak ditandai" 'H03' \
  "sed -i 's/x.total > i.patient_portion and/x.total > i.patient_portion * 2 and/' $OVCTL && grep -q 'x.total > i.patient_portion \* 2 and' $OVCTL" ""

mutate M134 "kredensial SATUSEHAT tersimpan tanpa client secret" 'J01' \
  "sed -i 's/      if (!secret) throw problem(400, .INT-400-SECRET./      if (false) throw problem(400, \x27INT-400-SECRET\x27/' $SSCTL && grep -q 'if (false) throw problem(400, .INT-400-SECRET' $SSCTL" ""
mutate M135 "client secret SATUSEHAT disimpan tanpa enkripsi" 'J01' \
  "sed -i 's/b.clientSecret ? encrypt(this.cfg.encryptionKeyHex, b.clientSecret) :/b.clientSecret ? Buffer.from(b.clientSecret) :/' $SSCTL && grep -q 'Buffer.from(b.clientSecret)' $SSCTL" ""
mutate M136 "ganti lingkungan SATUSEHAT tidak mereset IHS" 'J06' \
  "sed -i 's/^      if (switching) {$/      if (false) {/' $SSCTL && grep -q '^      if (false) {$' $SSCTL" ""
mutate M137 "koneksi simulator dipakai worker di produksi" 'J05' \
  "sed -i \"s/(conn.environment === 'SIMULATOR' \&\& o.allowSimulator === false)/false/\" $SSLIB && grep -q 'if (!conn || false) return null;' $SSLIB" ""
mutate M138 "lookup IHS gagal diulang setiap putaran (tanpa jeda sehari)" 'J05' \
  "sed -i \"s/ihs_checked_at < \\\$1::timestamptz - interval '1 day'/ihs_checked_at < \\\$1::timestamptz - interval '0 day'/\" $SSLIB && grep -q \"interval '0 day'\" $SSLIB" ""
mutate M139 "pasien yang pemrosesannya dibatasi tetap dicari di SATUSEHAT" 'J05' \
  "sed -i \"s/ and not processing_restricted$//\" $SSLIB && ! grep -q 'not processing_restricted' $SSLIB" ""
mutate M140 "batas 7 hari lookup IHS otomatis diabaikan" 'J05' \
  "sed -i \"s/created_at > \\\$1::timestamptz - interval '7 days'/created_at > \\\$1::timestamptz - interval '70 days'/\" $SSLIB && grep -q \"interval '70 days'\" $SSLIB" ""
mutate M141 "kredensial ditolak di satu klinik menghentikan lookup semua klinik" 'J05' \
  "sed -i 's/        if (!(e instanceof SatuSehatError)) throw e;/        throw e;/' $SSLIB && grep -q '^        throw e;$' $SSLIB" ""

mutate M142 "kunjungan dikirim walau pasien belum punya IHS" 'U01' \
  "sed -i \"s/  if (d.patient.ihsStatus !== 'FOUND' || !d.patient.ihs) {/  if (false) {/\" $SSENC && grep -q '^  if (false) {$' $SSENC" ""
mutate M143 "kunjungan tanpa diagnosis primer tidak ditahan" 'U01' \
  "sed -i \"s/  if (!d.conditions.some((c) => c.rank === 'PRIMER')) blocking.push/  if (false) blocking.push/\" $SSENC && grep -q 'if (false) blocking.push' $SSENC" ""
mutate M144 "pasien yang membatasi pemrosesan tetap dikirim ke SATUSEHAT" 'U02' \
  "sed -i 's/  if (d.data.patient.restricted) {/  if (false) {/' $SSENC && grep -q '^  if (false) {$' $SSENC" ""
mutate M145 "percobaan ulang tidak mencari Encounter yang sudah tersimpan (duplikat)" 'U04' \
  "sed -i 's/    if (!existing \&\& (prev?.attempts ?? 0) > 0) {/    if (false) {/' $SSENC && grep -q '^    if (false) {$' $SSENC" ""
mutate M146 "jadwal backoff diabaikan (dicoba ulang setiap putaran)" 'U04' \
  "sed -i 's/(r.next_attempt_at is null or r.next_attempt_at <= \$3::timestamptz)/true/' $SSENC && grep -q \"r.status = 'PENDING' and true\" $SSENC" ""
mutate M147 "gangguan sementara dicoba ulang tanpa batas (tidak pernah DEAD)" 'U05' \
  "sed -i 's/    const dead = attempts >= RETRY_BACKOFF_MIN.length;/    const dead = false;/' $SSENC && grep -q 'const dead = false;' $SSENC" ""
mutate M148 "penolakan validasi SATUSEHAT dicoba ulang" 'U05' \
  "sed -i \"s/    if (e.kind === 'VALIDATION' || e.kind === 'NOT_FOUND') {/    if (false) {/\" $SSENC && grep -q '^    if (false) {$' $SSENC" ""
mutate M149 "kredensial ditolak di satu klinik menghentikan pengiriman semua klinik" 'U06' \
  "sed -i 's/        total.failedTenants++;.*/        throw e;/' $SSENC && grep -q '^        throw e;$' $SSENC" ""
mutate M150 "status pengiriman kunjungan dapat dibaca tanpa izin rekam medis" 'U02' \
  "sed -i \"s/@RequirePermission('clinical.record.read') @Get('encounters\/:id\/satusehat')/@RequirePermission('billing.invoice.read') @Get('encounters\/:id\/satusehat')/\" $SSCTL && grep -q \"'billing.invoice.read') @Get('encounters\" $SSCTL" ""
mutate M151 "audit pengiriman memuat identitas pasien" 'U03' \
  "sed -i 's/JSON.stringify({ encounterNo: d.data.encounterNo,/JSON.stringify({ patient: d.data.patient.name, encounterNo: d.data.encounterNo,/' $SSENC && grep -q 'patient: d.data.patient.name' $SSENC" ""

mutate M152 "obat tanpa kode KFA tetap dikirim" 'V01' \
  "sed -i 's/    : (!it.kfa_code ? \[/    : (false ? [/' $SSFU && grep -q ': (false ? \[' $SSFU" ""
mutate M153 "resep dikirim sebelum Encounter terkirim" 'V01' \
  "sed -i \"s/er.local_id = e.id and er.status = 'SENT'/er.local_id = e.id/g\" $SSFU && ! grep -q \"er.local_id = e.id and er.status = 'SENT'\" $SSFU" ""
mutate M154 "penyerahan obat dikirim walau resepnya belum terkirim" 'V02' \
  "sed -i \"s/      ...(l.mr_status !== 'SENT' ? \[/      ...(false ? [/\" $SSFU && grep -q '      ...(false ? \[' $SSFU" ""
mutate M155 "percobaan ulang resep tidak mencari MedicationRequest yang sudah tersimpan (duplikat)" 'V03' \
  "sed -i 's/      if ((i.attempts ?? 0) > 0) {/      if (false) {/' $SSFU && grep -q '^      if (false) {$' $SSFU" ""
mutate M156 "dead-letter tanpa notifikasi admin" 'V03' \
  "sed -i 's/total.followUp.DEAD > deadBefore)/total.followUp.DEAD > deadBefore + 999)/' $SSENC && grep -q 'deadBefore + 999' $SSENC" ""
mutate M157 "notifikasi dead-letter menumpuk (tanpa dedup)" 'V03' \
  "sed -i \"s/     where not exists (select 1 from app.outbox_event where event_type = 'SATUSEHAT_DEAD_LETTER'.*/     where true\\\`, [connectionId]);/\" $SSFU && grep -q '     where true' $SSFU" ""
mutate M158 "kiriman tertahan/terkirim dapat dikirim ulang manual" 'V04' \
  "sed -i \"s/      if (r.status !== 'ERROR' \&\& r.status !== 'DEAD') throw/      if (false) throw/\" $SSCTL && grep -q '      if (false) throw' $SSCTL" ""
mutate M159 "kirim ulang manual tanpa izin integration.manage" 'V04' \
  "sed -i \"s/@RequirePermission('integration.manage') @NoBody() @Post('integrations\/satusehat\/records/@RequirePermission('billing.invoice.read') @NoBody() @Post('integrations\/satusehat\/records/\" $SSCTL && grep -q \"'billing.invoice.read') @NoBody() @Post('integrations\" $SSCTL" ""
mutate M160 "diagnosis yang dihapus addendum tidak dikirim entered-in-error" 'V05' \
  "sed -i 's/  const removed = current.filter((x) => !newCodes.has(x.code));/  const removed = current.filter(() => false);/' $SSFU && grep -q 'current.filter(() => false)' $SSFU" ""
mutate M161 "semua addendum diagnosis dikirim (yang lama tidak digantikan)" 'V06' \
  "sed -i 's/select distinct on (a.note_id) a.id, a.signed_at/select a.id, a.signed_at/' $SSFU && ! grep -q 'distinct on (a.note_id)' $SSFU" ""
mutate M162 "perubahan diagnosis addendum tidak ikut di-hash" 'C16b' \
  "sed -i 's/stableStringify(changes ? { v: 1, ...rest, changes } : { v: 1, ...rest })/stableStringify({ v: 1, ...rest })/' $INTEG && grep -q 'stableStringify({ v: 1, ...rest })' $INTEG" ""
mutate M163 "addendum dengan diagnosis yang sama diterima" 'C16b' \
  "sed -i 's/        if (sig(list) === sig(await effectiveDiagnosesOf(tx, n.encounter_id))) {/        if (false) {/' $SIGNCTL && grep -q '^        if (false) {$' $SIGNCTL" ""
mutate M164 "obat pasien yang membatasi pemrosesan tetap dikirim" 'V06' \
  "sed -i 's/^  if (h.restricted) {/  if (false) {/' $SSFU && ! grep -q 'if (h.restricted)' $SSFU" ""

mutate M165 "dashboard tidak menghitung kiriman terkirim" 'O01' \
  "sed -i \"s/count(r.id) filter (where r.status = 'SENT')::int as sent/count(r.id) filter (where r.status = 'X')::int as sent/\" $SSCTL && grep -q \"r.status = 'X'\" $SSCTL" ""
mutate M166 "dashboard tidak menampilkan antrean kunjungan disahkan" 'O01' \
  "sed -i 's/select count(\*)::int as queued from encounter e/select 0 as queued from encounter e/' $SSCTL && grep -q 'select 0 as queued' $SSCTL" ""
mutate M167 "rekonsiliasi menghitung pasien yang membatasi pemrosesan sebagai selisih" 'O02' \
  "sed -i 's/difference: list.length - sent.length - skipped.length + mismatch.length/difference: list.length - sent.length + mismatch.length/' $SSCTL && grep -q 'difference: list.length - sent.length + mismatch.length' $SSCTL" ""
mutate M168 "rekonsiliasi mengabaikan ID SATUSEHAT yang tidak cocok" 'O02' \
  "sed -i 's/      const mismatch = sent.filter((x) => !x.rec_ss || x.rec_ss !== x.enc_ss);/      const mismatch = sent.filter(() => false);/' $SSCTL && grep -q 'sent.filter(() => false)' $SSCTL" ""
mutate M169 "rekonsiliasi & antrean memasukkan kunjungan yang belum disahkan" 'O01' \
  "sed -i \"s/join clinical_note n on n.encounter_id = e.id and n.status = 'SIGNED' join branch b/join clinical_note n on n.encounter_id = e.id join branch b/g\" $SSCTL && ! grep -q \"and n.status = 'SIGNED' join branch b\" $SSCTL" ""
mutate M170 "Encounter yang tidak ada di SATUSEHAT tidak terdeteksi" 'O03' \
  "sed -i 's/^  if (!remoteId) {/  if (false) {/' $SSREC && grep -q '^  if (false) {' $SSREC" ""
mutate M171 "ID SATUSEHAT turunan yang hilang tidak diisi" 'O02' \
  "sed -i 's/      const m = remote.find((x) => x.code === l.code \&\& !used.has(x.id));/      const m = remote.find(() => false);/' $SSREC && grep -q 'remote.find(() => false)' $SSREC" ""
mutate M172 "data ganda di SATUSEHAT tidak dilaporkan" 'O03' \
  "sed -i 's/      if (extra > 0) dup += extra;/      if (false) dup += extra;/' $SSREC && grep -q 'if (false) dup' $SSREC" ""
mutate M173 "rekonsiliasi mencocokkan ulang semua kunjungan tiap jalan" 'O02' \
  "sed -i 's/and (r.remote_checked_at is null or r.remote_checked_at < r.last_sent_at/and (true or r.remote_checked_at < r.last_sent_at/' $SSREC && grep -q 'and (true or r.remote_checked_at' $SSREC" ""
mutate M174 "dashboard dapat dibaca tanpa izin integration.read" 'O01' \
  "sed -i \"s/@RequirePermission('integration.read') @Get('integrations\/satusehat\/summary')/@RequirePermission('billing.invoice.read') @Get('integrations\/satusehat\/summary')/\" $SSCTL && grep -q \"'billing.invoice.read') @Get('integrations\/satusehat\/summary\" $SSCTL" ""
mutate M175 "Encounter hilang tetap memakai ID lama saat dikirim ulang" 'O03' \
  "sed -i 's/last_error = .2, satusehat_id = null,/last_error = \$2,/' $SSREC && ! grep -q 'satusehat_id = null,' $SSREC" ""

mutate M176 "laporan kunjungan menghitung kunjungan batal" 'T01' \
  "sed -i \"s/^     where e.status <> 'CANCELLED'$/     where true/\" $RPTCLIN && grep -q '^     where true$' $RPTCLIN" ""
mutate M177 "tanggal kunjungan tidak memakai zona waktu cabang" 'T01' \
  "sed -i \"s/(coalesce(e.arrived_at, e.created_at) at time zone b.timezone)::date as d/(coalesce(e.arrived_at, e.created_at) at time zone 'UTC')::date as d/\" $RPTCLIN && grep -q \"at time zone 'UTC')::date as d\" $RPTCLIN" ""
mutate M178 "pasien baru tidak berdasarkan kunjungan pertama" 'T01' \
  "sed -i 's/order by e.patient_id, coalesce(e.arrived_at, e.created_at), e.id)/order by e.patient_id, coalesce(e.arrived_at, e.created_at) desc, e.id)/g' $RPTCLIN && grep -q 'created_at) desc, e.id)' $RPTCLIN" ""
mutate M179 "laporan mengabaikan cakupan cabang penugasan role" 'T03' \
  "sed -i 's/  const allowed = s?.all_branches ? null : (s?.ids ?? \[\]);/  const allowed = null as string[] | null;/' $RPTCOM && grep -q 'const allowed = null as' $RPTCOM" ""
mutate M180 "10 besar diagnosis memasukkan RM yang belum disahkan" 'T04' \
  "sed -i \"s/join clinical_note n on n.encounter_id = v.id and n.status = 'SIGNED'/join clinical_note n on n.encounter_id = v.id/\" $RPTCLIN && ! grep -q \"n.encounter_id = v.id and n.status = 'SIGNED'\" $RPTCLIN" ""
mutate M181 "10 besar diagnosis mengabaikan diagnosis pengganti dari addendum" 'T04' \
  "sed -i 's/           where not exists (select 1 from la where la.note_id = enc.note_id)),/           where true),/' $RPTCLIN && grep -q '^           where true),' $RPTCLIN" ""
mutate M182 "10 besar diagnosis bawaan tidak hanya diagnosis primer" 'T04' \
  "sed -i \"s/: sql\\\`rank = 'PRIMER'\\\`}/: sql\\\`true\\\`}/\" $RPTCLIN && ! grep -q \"sql\\\`rank = 'PRIMER'\\\`\" $RPTCLIN" ""
mutate M183 "batas rentang laporan 366 hari tidak berlaku" 'T03' \
  "sed -i 's/ > MAX_DAYS - 1) throw/ > 100000) throw/' $RPTCOM && grep -q '> 100000) throw' $RPTCOM" ""
mutate M184 "laporan kunjungan dapat dibaca tanpa izin laporan operasional" 'T03' \
  "sed -i \"s/@RequirePermission('report.operational.read') @Get('visits')/@RequirePermission('encounter.read') @Get('visits')/\" $RPTCLIN && grep -q \"'encounter.read') @Get('visits')\" $RPTCLIN" ""
mutate M185 "melihat laporan kunjungan tidak teraudit" 'T03' \
  "sed -i \"s/      await audit(tx, 'REPORT_VISITS_VIEWED'/      void (tx, 'REPORT_VISITS_VIEWED'/\" $RPTCLIN && grep -q \"void (tx, 'REPORT_VISITS_VIEWED'\" $RPTCLIN" ""

mutate M186 "pendapatan menghitung tagihan void" 'A01' \
  "sed -i \"s/i.status in ('ISSUED', 'PARTIALLY_PAID', 'PAID')/i.status <> 'DRAFT'/g\" $RPTFIN && ! grep -q \"i.status in ('ISSUED'\" $RPTFIN" ""
mutate M187 "tanggal pendapatan tidak memakai zona waktu cabang" 'A01' \
  "sed -i \"s/at time zone br.timezone)::date\\\`;/at time zone 'UTC')::date\\\`;/\" $RPTFIN && grep -q \"at time zone 'UTC')::date\" $RPTFIN" ""
mutate M188 "penerimaan kas tidak dikurangi refund" 'A02' \
  "sed -i 's/net: money(+x.payments + +x.settlements - +x.refunds)/net: money(+x.payments + +x.settlements - 0)/' $RPTFIN && grep -q 'settlements - 0)' $RPTFIN" ""
mutate M189 "penerimaan kas tanpa pelunasan piutang penjamin" 'A02' \
  "sed -i 's/where rp.paid_on between/where false and rp.paid_on between/' $RPTFIN && grep -q 'where false and rp.paid_on' $RPTFIN" ""
mutate M190 "refund yang belum disetujui mengurangi penerimaan kas" 'A02' \
  "sed -i \"s/where r.status = 'APPROVED' and/where true and/\" $RPTFIN && grep -q 'where true and' $RPTFIN" ""
mutate M191 "closing kasir: non-tunai ikut menghitung tunai" 'A03' \
  "sed -i \"s/p.shift_id = s.id and p.method <> 'TUNAI'/p.shift_id = s.id and true/\" $RPTFIN && grep -q 'p.shift_id = s.id and true' $RPTFIN" ""
mutate M192 "umur piutang mengurangi pelunasan sesudah tanggal posisi" 'A04' \
  "sed -i 's/rp.paid_on <= \${as_of}::date), 0)/rp.paid_on is not null), 0)/' $RPTFIN && grep -q 'rp.paid_on is not null), 0)' $RPTFIN" ""
mutate M193 "umur piutang dihitung dari tanggal terbit, bukan jatuh tempo" 'A04' \
  "sed -i 's/select rc.payer_id, rc.due_date,/select rc.payer_id, (i.issued_at at time zone br.timezone)::date as due_date,/' $RPTFIN && grep -q '::date as due_date,' $RPTFIN" ""
mutate M194 "umur piutang memasukkan tagihan yang terbit sesudah tanggal posisi" 'A04' \
  "sed -i 's/and (i.issued_at at time zone br.timezone)::date <= \${as_of}::date and/and/' $RPTFIN && ! grep -q 'date <= \${as_of}::date and' $RPTFIN" ""
mutate M195 "laporan pendapatan dapat dibaca tanpa izin laporan keuangan" 'A05' \
  "sed -i \"s/@RequirePermission('report.finance.read') @Get('revenue')/@RequirePermission('billing.invoice.read') @Get('revenue')/\" $RPTFIN && grep -q \"'billing.invoice.read') @Get('revenue')\" $RPTFIN" ""

# Mutasi UI: suite Playwright (U##) sebagai detektor
if [ "${MUTATION_E2E:-0}" = "1" ]; then
  restore
  sed -i 's/^  await headers();$//; /^import { headers } from/d; s/export default async function RootLayout/export default function RootLayout/' "$LAYOUT"
  if grep -q 'await headers()' "$LAYOUT"; then echo "M10: perintah mutasi gagal"; fail=1; else
    out=$(pnpm -s test:e2e --skip-nx-cache --output-style=static 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
    failed=$(echo "$out" | grep -E '^\s+✘' | sed -E 's/.* › (U[0-9]+) .*/\1/' | sort -u | tr '\n' ' ')
    if [ -n "$failed" ]; then echo "TERDETEKSI  M10  konsol dirender statis (nonce CSP hilang → script diblokir)  → gagal: ${failed}"
    else echo "LOLOS(!)    M10  konsol dirender statis — tidak ada uji E2E yang gagal"; fail=1; fi
  fi
fi
restore
exit $fail
