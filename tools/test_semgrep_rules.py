"""Uji aturan .semgrep/clinicrme.yml terhadap file anotasi .semgrep/clinicrme.ts(x).

Baris setelah komentar `// ruleid: <id>` wajib memicu aturan itu; baris setelah `// ok: <id>` tidak boleh.
(Pengganti `semgrep --test`, yang gagal pada tata letak ini.) Keluar 1 bila ada selisih.
"""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
fixtures = [p for p in (root / '.semgrep').iterdir() if p.suffix in ('.ts', '.tsx')]
out = subprocess.run(['semgrep', 'scan', '--config', str(root / '.semgrep/clinicrme.yml'), '--metrics=off', '--json',
                      '--no-git-ignore', *map(str, fixtures)], capture_output=True, text=True)
data = json.loads(out.stdout)
if data.get('errors'):
    print('Semgrep error:', data['errors'][:3]); sys.exit(1)
found = {(pathlib.Path(r['path']).name, r['start']['line'], r['check_id'].split('.')[-1]) for r in data['results']}

expected, forbidden = set(), set()
for f in fixtures:
    lines = f.read_text().splitlines()
    for i, line in enumerate(lines, start=1):
        m = re.search(r'//\s*(ruleid|ok):\s*([\w-]+)', line)
        if m:
            (expected if m.group(1) == 'ruleid' else forbidden).add((f.name, i + 1, m.group(2)))

missing = expected - found
false_pos = forbidden & found
for f, l, r in sorted(missing): print(f'GAGAL  {r} tidak terpicu di {f}:{l}')
for f, l, r in sorted(false_pos): print(f'GAGAL  {r} salah terpicu di {f}:{l}')
rules = sorted({r for _, _, r in expected})
print(f'{len(expected) - len(missing)}/{len(expected)} kasus positif terdeteksi, {len(forbidden) - len(false_pos)}/{len(forbidden)} kasus negatif bersih, '
      f'{len(rules)} aturan: {", ".join(rules)}')
sys.exit(1 if missing or false_pos else 0)
