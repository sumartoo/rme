import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Infra } from '@clinicrme/shared';
import { Db } from '@clinicrme/db';

/** Probe Cloud Run / Compose. Tidak membaca data tenant. */
@Controller()
export class HealthController {
  constructor(private readonly db: Db) {}

  @Infra() @Get('healthz') @HttpCode(200)
  live() { return { status: 'ok' }; }

  @Infra() @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response) {
    const db = await this.db.ping();
    res.status(db ? 200 : 503);
    return { status: db ? 'ok' : 'unavailable', checks: { database: db ? 'ok' : 'down' } };
  }
}
