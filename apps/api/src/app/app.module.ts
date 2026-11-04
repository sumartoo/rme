import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppConfig, BodyValidationInterceptor, ProblemFilter, REDACT_CENSOR, REDACT_PATHS, RequestContext } from '@clinicrme/shared';
import { IamModule } from '@clinicrme/iam';
import { PatientModule } from '@clinicrme/patient';
import { PlatformModule } from '@clinicrme/platform';
import { TenantModule } from '@clinicrme/tenant';
import { CoreModule } from './core.module';
import { HealthController } from './health.controller';

/** Tambahan untuk uji: controller ekstra & tujuan log (default stdout). */
export interface AppExtras { controllers?: Type<unknown>[]; logStream?: NodeJS.WritableStream }

type Req = IncomingMessage & { id?: string; crme?: RequestContext; originalUrl?: string };
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;   // mencegah injeksi ke log

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, extra: AppExtras = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DiscoveryModule,
        CoreModule.forRoot(cfg),
        LoggerModule.forRoot({
          pinoHttp: [{
            level: cfg.logLevel,
            redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
            // request id dari header hanya bila formatnya aman; selain itu dibuat baru
            genReqId: (req) => {
              const h = req.headers['x-request-id'];
              return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
            },
            // URL tanpa query string (query OAuth membawa code/state) — SC-LOG-01
            serializers: {
              req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, path: r.url.split('?')[0] }),
            },
            customProps: (req) => {
              const c = (req as Req).crme;
              return { request_id: (req as Req).id, tenant_id: c?.tenantId ?? c?.hostTenantId, user_id: c?.userId };
            },
            autoLogging: { ignore: (req) => ['/healthz', '/readyz'].includes((req.url ?? '').split('?')[0]) },
          }, extra.logStream ?? process.stdout],
        }),
        IamModule,
        PlatformModule,
        TenantModule,
        PatientModule,
      ],
      controllers: [HealthController, ...(extra.controllers ?? [])],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: BodyValidationInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}
