"""Membangkitkan db/migrations/0000_baseline.sql dari db/schema/*.sql (dijalankan SEKALI di Stage 4).

Setelah migrasi diterapkan di lingkungan mana pun, file ini tidak boleh dijalankan ulang untuk
menimpa 0000 — perubahan skema berikutnya dibuat sebagai migrasi baru. Kesetaraan struktur
baseline vs db/schema diperiksa oleh tools/check_schema_parity.sh (ADR-0009).
"""
import glob
import os

out = ['-- ClinicRME — migrasi 0000: baseline skema Stage 2–3.',
       '-- Dibangkitkan SEKALI dari db/schema/*.sql (tools/build_baseline_migration.py). Jangan diedit: migrasi yang sudah',
       '-- diterapkan bersifat immutable; perubahan skema selanjutnya = migrasi baru (CODING_STANDARDS §Database).', '']
for f in sorted(glob.glob('db/schema/*.sql')):
    out.append(f'-- ===== {os.path.basename(f)} =====')
    out.append(open(f, encoding='utf-8').read().rstrip())
    out.append('')
open('db/migrations/0000_baseline.sql', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('db/migrations/0000_baseline.sql')
