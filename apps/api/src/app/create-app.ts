import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppConfig, assertRouteDeclarations } from '@clinicrme/shared';
import { AppExtras, AppModule } from './app.module';

/** Merakit aplikasi API — dipakai main.ts dan uji integrasi agar konfigurasi keamanannya identik. */
export async function createApp(cfg: AppConfig, extra: AppExtras = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg, extra), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.useBodyParser('json', { limit: cfg.bodyLimit });           // SC-WEB-05
  // Impor master data (MST-FR-008, OD-083): berkas CSV/XLSX mentah, maks 5 MB; tipe lain tetap ditolak body parser JSON
  // + unggah hasil lab PDF (CLN-FR-015); isi diperiksa (magic %PDF) di controller
  app.useBodyParser('raw', { type: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'], limit: '5mb' });
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } })); // SC-WEB-01 (API)
  app.use(cookieParser());
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                                      // satu hop: load balancer Cloud Run
  app.enableShutdownHooks();
  await app.init();
  assertRouteDeclarations(app);                                   // SC-AUTHZ-01, SC-WEB-05
  return app;
}
