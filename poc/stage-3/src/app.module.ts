import { INestApplication, MiddlewareConsumer, Module, NestModule, DynamicModule, Type } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, DiscoveryService, MetadataScanner, NestFactory, Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppConfig, CONFIG } from './config';
import { Db } from './db';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { ContextMiddleware, SecurityGuard } from './guards';
import { AppController, AuthController } from './controllers';
import { AUTHENTICATED_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators';

@Module({})
export class AppModule implements NestModule {
  static forRoot(cfg: AppConfig, extraControllers: Type<unknown>[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [DiscoveryModule],
      controllers: [AuthController, AppController, ...extraControllers],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: Db, useFactory: () => new Db(cfg.db) },
        SessionService, AuthService, ContextMiddleware,
        { provide: APP_GUARD, useClass: SecurityGuard },
      ],
    };
  }
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}

/**
 * Startup check (SC-AUTHZ-01, AC-IAM-FR-011-2): setiap handler WAJIB mendeklarasikan
 * @Public, @Authenticated, atau @RequirePermission. Bila ada yang lupa, aplikasi menolak start.
 */
export function assertAllRoutesDeclareAccess(app: INestApplication) {
  const discovery = app.get(DiscoveryService), scanner = app.get(MetadataScanner), reflector = app.get(Reflector);
  const missing: string[] = [];
  for (const w of discovery.getControllers()) {
    const proto = w.metatype?.prototype;
    if (!proto) continue;
    for (const name of scanner.getAllMethodNames(proto)) {
      const h = proto[name];
      const targets = [h, w.metatype as Function];
      const declared = [PUBLIC_KEY, AUTHENTICATED_KEY, PERMISSION_KEY].some((k) => reflector.getAllAndOverride(k, targets));
      if (!declared) missing.push(`${w.name}.${name}`);
    }
  }
  if (missing.length) throw new Error(`Endpoint tanpa deklarasi akses: ${missing.join(', ')}`);
}

export async function createApp(cfg: AppConfig, extraControllers: Type<unknown>[] = []) {
  const app = await NestFactory.create(AppModule.forRoot(cfg, extraControllers), { logger: ['error', 'warn'] });
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.init();
  assertAllRoutesDeclareAccess(app);
  return app;
}
