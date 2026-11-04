import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, CONFIG } from '@clinicrme/shared';
import { Db, PlatformDb } from '@clinicrme/db';
import { STORAGE, createStorage } from '@clinicrme/storage';

/** Provider global: konfigurasi tervalidasi & pintu database (aplikasi klinik: Db; konsol platform: PlatformDb). */
@Global()
@Module({})
export class CoreModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: Db, useFactory: () => new Db(cfg.db) },
        { provide: PlatformDb, useFactory: () => new PlatformDb(cfg.platformDb) },
        { provide: STORAGE, useFactory: () => createStorage(cfg.storage) },
      ],
      exports: [CONFIG, Db, PlatformDb, STORAGE],
    };
  }
}
