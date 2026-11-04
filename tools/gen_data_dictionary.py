"""Bangkitkan DATA_DICTIONARY.md dari skema PostgreSQL yang sudah dimuat.
Pemakaian: PGHOST=.. PGPORT=.. PGUSER=.. python3 tools/gen_data_dictionary.py <database> <output.md>
"""
import subprocess, sys, json, collections, re
db, out = sys.argv[1], sys.argv[2]
def q(sql):
    r = subprocess.run(["psql", "-X", "-At", "-d", db, "-c", sql], capture_output=True, text=True, check=True)
    return json.loads(r.stdout or "[]")

tables = q("""select coalesce(json_agg(t order by t.name),'[]') from (
  select c.relname name, obj_description(c.oid,'pg_class') descr, c.relrowsecurity rls,
         exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id') tenant
    from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='app'
   where c.relkind in ('r','p') and not c.relispartition) t""")
cols = q("""select coalesce(json_agg(x),'[]') from (
  select c.relname tbl, a.attnum num, a.attname col, format_type(a.atttypid,a.atttypmod) typ,
         a.attnotnull nn, pg_get_expr(d.adbin,d.adrelid) def, col_description(c.oid,a.attnum) descr
    from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='app'
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
   where c.relkind in ('r','p') and not c.relispartition) x""")
fks = q("""select coalesce(json_agg(x),'[]') from (
  select c.conrelid::regclass::text tbl, c.confrelid::regclass::text ref,
         array(select attname from pg_attribute where attrelid=c.conrelid and attnum = any(c.conkey)) cols
    from pg_constraint c join pg_namespace n on n.oid=c.connamespace and n.nspname='app' where c.contype='f') x""")
trg = q("""select coalesce(json_agg(x),'[]') from (
  select c.relname tbl, t.tgname name from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace and n.nspname='app' where not t.tgisinternal) x""")

C = collections.defaultdict(list)
for c in sorted(cols, key=lambda x: (x["tbl"], x["num"])): C[c["tbl"]].append(c)
F = collections.defaultdict(list)
for f in fks:
    t = f["tbl"].split(".")[-1]; ref = f["ref"].split(".")[-1]
    keycols = [c for c in f["cols"] if c != "tenant_id"] or f["cols"]
    F[t].append((", ".join(keycols), ref))
T = collections.defaultdict(list)
for t in trg: T[t["tbl"]].append(t["name"])

lines = ["# Data Dictionary — ClinicRME SaaS", "",
         "> Dibangkitkan otomatis dari `db/schema/*.sql` oleh `tools/gen_data_dictionary.py`. Jangan diedit manual — ubah komentar di DDL lalu bangkitkan ulang.", "",
         f"**{len(tables)} tabel** · {sum(1 for t in tables if t['tenant'])} tabel ber-`tenant_id` · {sum(1 for t in tables if t['rls'])} tabel dengan RLS.", "",
         "## Indeks Tabel", "", "| Tabel | Tenant | RLS | Deskripsi |", "|---|---|---|---|"]
for t in tables:
    lines.append(f"| [`{t['name']}`](#{t['name'].replace('_','-')}) | {'✓' if t['tenant'] else 'global'} | {'✓' if t['rls'] else '—'} | {(t['descr'] or '').replace('|','/')} |")
for t in tables:
    lines += ["", f"## {t['name']}", "", (t["descr"] or "_(belum ada deskripsi)_"), "",
              "| Kolom | Tipe | Wajib | Default | Keterangan |", "|---|---|---|---|---|"]
    for c in C[t["name"]]:
        d = (c["def"] or "").replace("|", "/")
        if len(d) > 40: d = d[:37] + "..."
        lines.append(f"| `{c['col']}` | {c['typ']} | {'✓' if c['nn'] else ''} | {('`'+d+'`') if d else ''} | {(c['descr'] or '').replace('|','/')} |")
    if F[t["name"]]:
        lines += ["", "**Relasi:** " + "; ".join(f"`{a}` → `{b}`" for a, b in sorted(set(F[t['name']])))]
    if T[t["name"]]:
        lines += ["", "**Trigger:** " + ", ".join(f"`{x}`" for x in sorted(T[t['name']]))]
open(out, "w").write("\n".join(lines) + "\n")
print(len(tables), "tabel")
