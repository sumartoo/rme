#!/usr/bin/env python3
"""Membuat libs/iam/src/lib/common-passwords.generated.ts dari daftar SecLists (OD-079).
Pemakaian: python3 tools/gen_common_passwords.py 100k-most-used-passwords-NCSC.txt"""
import json, sys
src = open(sys.argv[1], encoding="utf-8", errors="ignore").read().replace("\r", "").split("\n")
words = sorted({w.strip().lower() for w in src if len(w.strip()) >= 10})
out = """// HASIL GENERATE — jangan diedit manual. Sumber: SecLists "100k-most-used-passwords-NCSC.txt" (lisensi MIT,
// © 2018 Daniel Miessler), hanya entri ≥ 10 karakter (yang lebih pendek sudah ditolak aturan panjang), huruf kecil.
// Dibuat ulang: python3 tools/gen_common_passwords.py <berkas-sumber>  (OD-079, AC-IAM-FR-003-1)
export const COMMON_PASSWORDS_SOURCE = 'SecLists 100k-most-used-passwords-NCSC (MIT)';   // pragma: allowlist secret — nama sumber, bukan rahasia
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(%s.split('\\n'));   // pragma: allowlist secret — daftar password umum publik untuk DITOLAK
""" % json.dumps("\n".join(words))
open("libs/iam/src/lib/common-passwords.generated.ts", "w").write(out)
print(len(words), "password")
