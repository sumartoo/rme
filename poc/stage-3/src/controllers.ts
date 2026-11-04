import { Body, Controller, Get, HttpCode, HttpException, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, OIDC_COOKIE } from './auth.service';
import { ctx } from './context';
import { Db, audit, rows } from './db';
import { AllowWithoutMfa, Authenticated, Public, RequirePermission } from './decorators';
import { SessionService } from './session.service';

const problem = (status: number, code: string, title: string) => new HttpException({ type: 'about:blank', title, status, code }, status);
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpException({ type: 'about:blank', title: 'Input tidak valid', status: 400,
    errors: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }, 400);
  return r.data;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService, private readonly db: Db) {}

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), body);
    await this.auth.passwordLogin(ctx().hostTenantId!, b.email, b.password, res, req.headers['user-agent']);
    return { ok: true };
  }

  @Public() @Get('google')
  async google(@Res() res: Response) {
    res.redirect(302, await this.auth.googleStart(ctx().hostTenantId!, res));
  }

  @Public() @Get('google/callback')
  async googleCallback(@Query() q: { code?: string; state?: string }, @Req() req: Request, @Res() res: Response) {
    await this.auth.googleCallback(ctx().hostTenantId!, q, req.cookies?.[OIDC_COOKIE], res, req.headers['user-agent']);
    res.redirect(302, '/');
  }

  @Authenticated() @AllowWithoutMfa() @Post('mfa/enroll')
  enroll() { return this.auth.enrollMfa(); }

  @Authenticated() @AllowWithoutMfa() @Post('mfa/verify') @HttpCode(200)
  async verify(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    await this.auth.verifyMfa(parse(z.object({ code: z.string().min(6).max(20) }), body).code, res);
    return { ok: true };
  }

  @Authenticated() @AllowWithoutMfa() @Post('logout') @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response) {
    const c = ctx();
    await this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`update user_session set revoked_at = now(), revoke_reason = 'LOGOUT' where id = ${c.sessionId}`);
      await audit(tx, 'LOGOUT', 'app_user', c.userId!);
    });
    this.sessions.clearCookies(res);
  }
}

@Controller('api/v1')
export class AppController {
  constructor(private readonly db: Db, private readonly sessions: SessionService) {}

  @Authenticated() @Get('me')
  async me() {
    const c = ctx();
    const [u] = await this.db.withTenantTx((tx) => rows(tx, sql`select id, email, full_name as "fullName", status from app_user where id = ${c.userId}`));
    return { user: u, tenantId: c.tenantId, permissions: [...(c.permissions ?? [])].sort(), mfaVerified: c.mfaVerified };
  }

  @RequirePermission('patient.read') @Get('patients')
  async listPatients() {
    return { data: await this.db.withTenantTx((tx) => rows(tx, sql`select id, mrn, full_name as "fullName" from patient order by mrn limit 100`)) };
  }

  /** Resource tenant lain → 404, bukan 403 (SC-TEN-05). Akses baca dicatat di audit (AUD-FR-002). */
  @RequirePermission('patient.read') @Get('patients/:id')
  async getPatient(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenantTx(async (tx) => {
      const [p] = await rows(tx, sql`select id, mrn, full_name as "fullName", birth_date as "birthDate" from patient where id = ${id}`);
      if (!p) throw problem(404, 'PAT-404', 'Pasien tidak ditemukan');
      await audit(tx, 'READ', 'patient', id, id);
      return p;
    });
  }

  @RequirePermission('iam.user.manage') @Post('users/:id/disable') @HttpCode(200)
  async disableUser(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().min(3) }), body);
    return this.db.withTenantTx(async (tx) => {
      const r = await rows(tx, sql`update app_user set status = 'DISABLED' where id = ${id} returning id`);
      if (!r.length) throw problem(404, 'IAM-404', 'User tidak ditemukan');
      const revoked = await this.sessions.revokeAllForUser(tx, id, 'USER_DISABLED');
      await audit(tx, 'USER_DISABLED', 'app_user', id, null, { reason, sessionsRevoked: revoked });
      return { id, status: 'DISABLED', sessionsRevoked: revoked };
    });
  }
}
