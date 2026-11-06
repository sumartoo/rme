#!/usr/bin/env bash
# Uji mutasi kontrol keamanan (Stage 3 M1–M4 diulang di monorepo — RSK-020; M5 Stage 4; M6–M14 Stage 5; M15–M17 Stage 6; M18–M22 Stage 7; M23–M31 Stage 8).
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
FILES=("$AUTH" "$SESSION" "$MIG2" "$MIG3" "$GUARD" "$PGUARD" "$LAYOUT" "$EXPORT" "$MIG5" "$MIG6" "$TOTP" "$IAMUSERS" "$ACCOUNT" "$AUDITCHG" "$PRACT" "$MIG12" "$TERM" "$IMPORTS" "$PATIENT" "$MIG15" "$IDEM" "$MIG16" "$BOOK" "$SCHED" "$NOSHOW")
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
