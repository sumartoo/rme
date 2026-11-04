// `pnpm dev:env` — membuat .env dari .env.example dengan secret acak.
// .env yang sudah ada TIDAK ditimpa: hanya kunci yang belum ada yang ditambahkan di akhir file
// (mis. PLATFORM_DATABASE_URL dari Stage 5). Nilai lama tidak pernah dicetak.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const parse = (text) => Object.fromEntries(text.split('\n').map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const exists = existsSync('.env');
const vars = exists ? parse(readFileSync('.env', 'utf8')) : {};
const added = [];
const out = readFileSync('.env.example', 'utf8').split('\n').map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) return line;
  if (m[1] in vars && exists) return null;
  const v = m[2]
    .replace('__RANDOM_HEX32__', () => randomBytes(32).toString('hex'))
    .replace('__RANDOM__', () => randomBytes(18).toString('base64url'))
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => vars[k] ?? '');
  vars[m[1]] = v;
  added.push(m[1]);
  return `${m[1]}=${v}`;
});

if (!exists) {
  writeFileSync('.env', out.join('\n'), { mode: 0o600 });
  console.log('.env dibuat dengan secret acak (jangan di-commit).');
} else if (added.length) {
  const lines = out.filter((l) => l !== null && added.includes(l.split('=')[0]));
  appendFileSync('.env', `\n# Ditambahkan oleh pnpm dev:env (${new Date().toISOString().slice(0, 10)})\n${lines.join('\n')}\n`);
  console.log(`.env sudah ada — ditambahkan kunci baru: ${added.join(', ')}`);
} else {
  console.log('.env sudah ada dan lengkap — tidak diubah.');
}
