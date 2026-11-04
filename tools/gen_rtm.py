import re,sys,pathlib,collections
req=pathlib.Path(sys.argv[1])
rows=[]
stage_of={"GEN":"Semua","PLT":"5","IAM":"3, 6","AUD":"3","MST":"7","TRM":"7","REG":"8","SCH":"8","CLN":"9","PHM":"10","BIL":"11","INT":"12","BPJ":"LJT","POR":"13","RPT":"14","DOC":"9","NTF":"8",
 "PERF":"15","AVL":"15","DR":"15","SEC":"3","PRV":"3","AUD_N":"3","RET":"3","UX":"Semua","CMP":"Semua","AND":"13","OPS":"15"}
wf={}
for line in (req/"WORKFLOWS.md").read_text().splitlines():
    pass
wftext=(req/"WORKFLOWS.md").read_text()
uc={}
for line in (req/"USE_CASES.md").read_text().splitlines():
    m=re.match(r'\|\s*(UC-[A-Z]{3}-\d\d)\s*\|',line)
    if m:
        for rid in re.findall(r'(?:[A-Z]{3}-FR|NFR-[A-Z]+)-\d{3}',line): uc.setdefault(rid,[]).append(m.group(1))
ac=collections.defaultdict(list)
for line in (req/"ACCEPTANCE_CRITERIA.md").read_text().splitlines():
    m=re.match(r'\|\s*AC-((?:[A-Z]{3}-FR)-\d{3})-(\d+)\s*\|',line)
    if m: ac[m.group(1)].append(m.group(2))
root=req.parent.parent
def expand(tok):
    m=re.match(r'([A-Z]{3}-FR-)(\d{3})((?:/\d{3})*)(?:\.\.(\d{3}))?',tok)
    pre,first,rest,rng=m.groups(); nums=[int(first)]+[int(x) for x in rest.split('/') if x]
    if rng: nums=list(range(int(first),int(rng)+1))
    return [f"{pre}{n:03d}" for n in nums]
tables=collections.defaultdict(set)
for sf in sorted((root/"db"/"schema").glob("*.sql")):
    for m in re.finditer(r"COMMENT ON (?:TABLE (\w+)|COLUMN (\w+)\.\w+) IS '([^']*)'",sf.read_text()):
        tname=m.group(1) or m.group(2)
        for tok in re.findall(r'[A-Z]{3}-FR-\d{3}(?:/\d{3})*(?:\.\.\d{3})?',m.group(3)):
            for rid in expand(tok): tables[rid].add(tname)
mapf=root/"db"/"schema"/"requirement_table_map.yaml"
if mapf.exists():
    for line in mapf.read_text().splitlines():
        mm=re.match(r'([A-Z]{3}-FR-\d{3}):\s*\[(.*)\]',line)
        if mm:
            for t in mm.group(2).split(','): tables[mm.group(1)].add(t.strip())
apis=collections.defaultdict(list)
oa=root/"api"/"openapi.yaml"
if oa.exists():
    cur=None
    for line in oa.read_text().splitlines():
        mo=re.match(r'\s+operationId: (\w+)',line)
        if mo: cur=mo.group(1); continue
        mr=re.match(r'\s+- ((?:[A-Z]{3}-FR)-\d{3})$',line)
        if mr and cur: apis[mr.group(1)].append(cur)
special={"AUD-FR-003":"DB: trigger + app.write_audit()","SCH-FR-011":"Job worker (no-show)","GEN-FR-001":"Semua (RLS)","GEN-FR-002":"Semua (audit)","GEN-FR-003":"Semua (trigger immutability)","GEN-FR-004":"Semua endpoint daftar","GEN-FR-005":"Semua","GEN-FR-006":"app.next_document_number()","GEN-FR-007":"Semua (If-Match)"}
for f in ["SRS.md","NFR.md"]:
    for line in (req/f).read_text().splitlines():
        m=re.match(r'\|\s*((?:[A-Z]{3}-FR|NFR-[A-Z]+)-\d{3})\s*\|(.*)',line)
        if not m: continue
        rid=m.group(1); cells=[c.strip() for c in m.group(2).split('|')]
        text=cells[0]
        prio=next((c for c in cells if c in("MVP","LJT")),None)
        if not prio:
            pm=re.search(r'`(MVP|LJT)`',text); prio=pm.group(1) if pm else "-"
            text=re.sub(r'\s*`(MVP|LJT)`','',text)
        if rid.startswith("NFR"):
            kat=rid.split('-')[1]; st=stage_of.get("AUD_N" if kat=="AUD" else kat,"-")
        else: st=stage_of.get(rid[:3],"-")
        med="Ya" if "REVIEW-MEDIS" in line else ""
        wfs=sorted({s[:5] for s in wftext.split("\n## ") if s.startswith("WF-") and rid in s})
        short=text if len(text)<=90 else text[:87]+"..."
        ucs=", ".join(uc.get(rid,[]))
        acs=(f"AC-{rid}-1..{len(ac[rid])}" if len(ac[rid])>1 else (f"AC-{rid}-1" if ac[rid] else ("Target NFR" if rid.startswith("NFR") else "")))
        tb=", ".join(sorted(tables.get(rid,[])))
        ap=special.get(rid) or ", ".join(dict.fromkeys(apis.get(rid,[])))
        rows.append((rid,short,prio,st,", ".join(wfs),med,ucs,acs,tb,ap))
c=collections.Counter(r[2] for r in rows)
nmvp=sum(1 for r in rows if r[2]=="MVP"); nac=sum(1 for r in rows if r[2]=="MVP" and r[7])
fr_mvp=[r for r in rows if r[2]=="MVP" and "-FR-" in r[0]]
napi=sum(1 for r in fr_mvp if r[9]); ntb=sum(1 for r in fr_mvp if r[8])
out=["# Requirement Traceability Matrix — ClinicRME SaaS","",
"| | |","|---|---|","| Versi | 0.1 — dibangkitkan dari SRS.md & NFR.md |","| Tanggal | 3 November 2026 |","",
"> Dibangkitkan oleh `tools/gen_rtm.py` dari SRS, NFR, WORKFLOWS, USE_CASES, ACCEPTANCE_CRITERIA, komentar tabel di `db/schema/*.sql`, dan `x-requirements` di `api/openapi.yaml`. Kolom Test Case & Status Test diisi mulai Stage 4. Jangan edit file ini manual.","",
f"**Ringkasan:** {len(rows)} requirement — MVP {c['MVP']}, Lanjutan {c['LJT']}, perlu review medis {sum(1 for r in rows if r[5])}. Requirement MVP dengan acceptance criteria: {nac}/{nmvp}. Requirement fungsional MVP dengan API/mekanisme: {napi}/{len(fr_mvp)}; dengan tabel tertaut: {ntb}/{len(fr_mvp)}.","",
"| Req ID | Ringkasan | Prioritas | Stage | Workflow | Review Medis | Use Case | Acceptance Criteria | Tabel | API / Mekanisme | Test Case | Status Test |",
"|---|---|---|---|---|---|---|---|---|---|---|---|"]
for r in rows: out.append(f"| {r[0]} | {r[1].replace('|','/')} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[7]} | {r[8]} | {r[9]} | | |")
(req/"REQUIREMENT_TRACEABILITY_MATRIX.md").write_text("\n".join(out)+"\n")
print(len(rows),dict(c),sum(1 for r in rows if r[5]))
miss_ac=[r[0] for r in rows if r[2]=="MVP" and not r[7]]; print("MVP tanpa AC:",miss_ac)
miss_uc=[r[0] for r in rows if r[2]=="MVP" and not r[6] and not r[0].startswith(("NFR","GEN"))]; print("MVP FR tanpa UC:",miss_uc)
known={r[0] for r in rows}
print("MVP FR tanpa API/mekanisme:",[r[0] for r in rows if r[2]=="MVP" and "-FR-" in r[0] and not r[9]])
print("MVP FR tanpa tabel:",[r[0] for r in rows if r[2]=="MVP" and "-FR-" in r[0] and not r[8]])
print("UC ref tak dikenal:",[k for k in uc if k not in known]); print("AC ref tak dikenal:",[k for k in ac if k not in known])
dups=[k for k,v in collections.Counter(r[0] for r in rows).items() if v>1]; print("dups",dups)
