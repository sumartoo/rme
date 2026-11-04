#!/usr/bin/env bash
# Uji mutasi kontrol keamanan (Stage 3 M1–M4 diulang di monorepo — RSK-020; M5 Stage 4; M6–M14 Stage 5; M15–M17 Stage 6).
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
FILES=("$AUTH" "$SESSION" "$MIG2" "$MIG3" "$GUARD" "$PGUARD" "$LAYOUT" "$EXPORT" "$MIG5" "$MIG6" "$TOTP" "$IAMUSERS" "$ACCOUNT")
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
