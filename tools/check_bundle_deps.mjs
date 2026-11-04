// Memastikan setiap modul eksternal yang di-require bundle webpack tersedia di node_modules hasil `pnpm deploy`
// (isi image produksi). Pemakaian: node tools/check_bundle_deps.mjs <folder-deploy> <bundle.js...>
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const [dir, ...bundles] = process.argv.slice(2);
if (!dir || !bundles.length) { console.error('Pemakaian: check_bundle_deps.mjs <deploy-dir> <bundle.js...>'); process.exit(2); }
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const missing = new Set(); let total = 0;
for (const b of bundles) {
  const src = readFileSync(b, 'utf8');
  for (const [, req] of src.matchAll(/require\("([^"./][^"]*)"\)/g)) {
    if (builtins.has(req) || builtins.has(req.split('/')[0])) continue;
    total++;
    const pkg = req.startsWith('@') ? req.split('/').slice(0, 2).join('/') : req.split('/')[0];
    if (!existsSync(join(dir, 'node_modules', pkg, 'package.json'))) missing.add(`${pkg} (dari ${b})`);
  }
}
if (missing.size) { console.error(`GAGAL — paket tidak ada di image:\n  ${[...missing].join('\n  ')}`); process.exit(1); }
console.log(`OK — ${total} require eksternal di ${bundles.length} bundle tersedia di ${dir}/node_modules`);
