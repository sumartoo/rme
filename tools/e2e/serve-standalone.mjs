// Menjalankan build standalone Next.js seperti di image produksi (docker/web.Dockerfile):
// salin .next/static & public ke folder standalone, lalu jalankan server.js. Lintas OS (tanpa cp/shell).
// Pemakaian: node tools/e2e/serve-standalone.mjs <app>   (PORT dari env)
import { cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.argv[2];
if (!/^[a-z-]+$/.test(app ?? '')) throw new Error('nama app tidak valid');
const root = resolve(import.meta.dirname, '..', '..');
const src = join(root, 'apps', app);
const out = join(src, '.next', 'standalone', 'apps', app);
if (!existsSync(join(out, 'server.js'))) throw new Error(`build standalone ${app} belum ada — jalankan nx build @clinicrme/${app}`);
cpSync(join(src, '.next', 'static'), join(out, '.next', 'static'), { recursive: true });
if (existsSync(join(src, 'public'))) cpSync(join(src, 'public'), join(out, 'public'), { recursive: true });
process.chdir(out);
await import(pathToFileURL(join(out, 'server.js')).href);
