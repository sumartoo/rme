"""Bangkitkan PERMISSION_MATRIX.md dan seed SQL permission/role dari:
  - api/openapi.yaml (x-permission per operasi)
  - db/seed/role_templates.yaml
Pemeriksaan: permission di template harus ada di API; tidak ada endpoint ber-permission
yang tidak dimiliki role mana pun; aturan segregation of duties dipatuhi.
Pemakaian: python3 tools/gen_permission_matrix.py [--seed]   (dari root repo; butuh pyyaml)
Sejak Stage 4 db/seed dibekukan bersama db/schema (OD-071, ADR-0009): seed SQL hanya ditulis dengan --seed;
permission baru masuk lewat migrasi (mis. platform.tenant.read di 0003).
Exit code 1 bila pemeriksaan gagal.
"""
import yaml, re, sys, fnmatch, collections, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
api = yaml.safe_load(open(root / "api/openapi.yaml"))
tpl = yaml.safe_load(open(root / "db/seed/role_templates.yaml"))

ops_by_perm = collections.defaultdict(list)
for path, item in api["paths"].items():
    for method, op in item.items():
        p = op.get("x-permission")
        if p: ops_by_perm[p].append((method.upper(), path, op["operationId"]))
perms = sorted(ops_by_perm)

def expand(patterns):
    out = set()
    for pat in patterns:
        rx = "^" + re.escape(pat).replace(r"\*", r"[a-z_]+") + "$"
        hit = {p for p in perms if re.match(rx, p)}
        if not hit: errors.append(f"pola '{pat}' tidak cocok dengan permission apa pun")
        out |= hit
    return out

errors = []
roles = {code: {**r, "set": expand(r["permissions"])} for code, r in tpl["roles"].items()}
proles = {code: {**r, "set": expand(r["permissions"])} for code, r in tpl["platform_roles"].items()}
owned = set().union(*(r["set"] for r in roles.values()), *(r["set"] for r in proles.values()))
for p in perms:
    if p not in owned: errors.append(f"permission {p} tidak dimiliki role template mana pun")
for a, b in tpl["segregation_of_duties"]:
    for code, r in roles.items():
        if a in r["set"] and b in r["set"]:
            errors.append(f"SoD dilanggar: role {code} memiliki {a} dan {b}")

def module(p): return p.split(".")[0]
desc = {p: "; ".join(sorted({o[2] for o in ops_by_perm[p]})) for p in perms}

# ---- Markdown
cols = list(roles)
L = ["# Permission Matrix — ClinicRME SaaS", "",
     "> Dibangkitkan oleh `tools/gen_permission_matrix.py` dari `api/openapi.yaml` (x-permission) dan `db/seed/role_templates.yaml`. Jangan diedit manual.", "",
     f"**{len(perms)} permission** · {len(roles)} role template tenant · {len(proles)} role platform · "
     f"pemeriksaan: {'✅ lulus' if not errors else '❌ ' + str(len(errors)) + ' masalah'}", "",
     "## Prinsip", "",
     "- Format `<modul>.<resource>.<aksi>`; diperiksa di backend pada setiap endpoint (deny by default, AC-IAM-FR-011-2).",
     "- Permission efektif = gabungan role user **di cabang aktif** (`user_role_assignment.branch_id`, NULL = semua cabang).",
     "- Role template hanya titik awal; tenant admin dapat membuat role custom (IAM-FR-008).",
     "- Segregation of duties (maker–checker) ditegakkan pada template **dan** di database (`approved_by <> requested_by`).", "",
     "## Role Template", "", "| Kode | Nama | MFA wajib | Jumlah permission | Catatan |", "|---|---|---|---|---|"]
for c, r in {**roles, **proles}.items():
    L.append(f"| `{c}` | {r['name']} | {'✓' if r.get('requires_mfa') else ''} | {len(r['set'])} | {r.get('note','')} |")
L += ["", "## Segregation of Duties", "", "| Pengaju | Penyetuju |", "|---|---|"]
L += [f"| `{a}` | `{b}` |" for a, b in tpl["segregation_of_duties"]]
L += ["", "## Matriks", "", "| Permission | " + " | ".join(cols) + " | Operasi API |", "|---|" + "---|" * len(cols) + "---|"]
cur = None
for p in perms:
    if p.startswith("platform."): continue
    if module(p) != cur:
        cur = module(p); L.append(f"| **{cur}** |" + " |" * len(cols) + " |")
    L.append(f"| `{p}` | " + " | ".join("✓" if p in roles[c]["set"] else "" for c in cols) + f" | {desc[p]} |")
L += ["", "## Permission Platform", "", "| Permission | " + " | ".join(proles) + " | Operasi API |", "|---|" + "---|" * len(proles) + "---|"]
for p in perms:
    if p.startswith("platform."):
        L.append(f"| `{p}` | " + " | ".join("✓" if p in proles[c]["set"] else "" for c in proles) + f" | {desc[p]} |")
if errors:
    L += ["", "## Masalah", ""] + [f"- {e}" for e in errors]
(root / "docs/03-security").mkdir(parents=True, exist_ok=True)
(root / "docs/03-security/PERMISSION_MATRIX.md").write_text("\n".join(L) + "\n")

# ---- Seed SQL
q = lambda s: "'" + s.replace("'", "''") + "'"
S = ["-- Dibangkitkan oleh tools/gen_permission_matrix.py — jangan diedit manual.",
     "SET search_path = app, public;", "",
     "INSERT INTO permission(code, module, description) VALUES"]
S.append(",\n".join(f"  ({q(p)}, {q(module(p))}, {q(desc[p])})" for p in perms))
S.append("ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;")
S += ["", "-- Membuat role template untuk tenant aktif (dipanggil saat onboarding tenant, PLT-FR-001)",
      "CREATE OR REPLACE FUNCTION app.create_template_roles() RETURNS void",
      "LANGUAGE plpgsql SET search_path = app, public AS $$", "DECLARE v_role uuid;", "BEGIN"]
for c, r in roles.items():
    S.append(f"  INSERT INTO role(tenant_id, code, name, is_template, requires_mfa) VALUES (app.current_tenant_id(), {q(c)}, {q(r['name'])}, true, {str(bool(r.get('requires_mfa'))).lower()})")
    S.append(f"    ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id INTO v_role;")
    S.append(f"  IF v_role IS NOT NULL THEN")
    S.append(f"    INSERT INTO role_permission(tenant_id, role_id, permission_code) SELECT app.current_tenant_id(), v_role, unnest(ARRAY[{', '.join(q(p) for p in sorted(r['set']))}]);")
    S.append(f"  END IF;")
S += ["END $$;", "GRANT EXECUTE ON FUNCTION app.create_template_roles() TO clinicrme_app;"]
if "--seed" in sys.argv:
    (root / "db/seed").mkdir(parents=True, exist_ok=True)
    (root / "db/seed/010_permissions_roles.sql").write_text("\n".join(S) + "\n")

print(f"{len(perms)} permission, {len(roles)} role tenant, {len(proles)} role platform")
for e in errors: print("ERROR:", e)
sys.exit(1 if errors else 0)
