import { loadConfig } from '@clinicrme/shared';
import { createApp } from './app/create-app';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.port, '0.0.0.0');
}

bootstrap().catch((e) => {
  // Tanpa detail konfigurasi bernilai rahasia: loadConfig hanya menyebut nama variabel.
  console.error(`API gagal start: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
