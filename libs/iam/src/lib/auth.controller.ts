import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowWithoutMfa, Authenticated, BodySchema, NoBody, Public, ctx } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { AuthService, OIDC_COOKIE } from './auth.service';
import { SessionService } from './session.service';

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
const MfaBody = z.object({ code: z.string().min(6).max(20) });

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService, private readonly db: Db) {}

  /** IAM-FR-003 */
  @Public() @BodySchema(LoginBody) @Post('login') @HttpCode(200)
  async login(@Body() b: z.infer<typeof LoginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.passwordLogin(ctx().hostTenantId!, b.email, b.password, res, req.headers['user-agent']);
    return { ok: true };
  }

  /** IAM-FR-002 */
  @Public() @Get('google')
  async google(@Res() res: Response) {
    res.redirect(302, await this.auth.googleStart(ctx().hostTenantId!, res));
  }

  @Public() @Get('google/callback')
  async googleCallback(@Query() q: { code?: string; state?: string }, @Req() req: Request, @Res() res: Response) {
    await this.auth.googleCallback(ctx().hostTenantId!, q, req.cookies?.[OIDC_COOKIE], res, req.headers['user-agent']);
    res.redirect(302, '/');
  }

  /** IAM-FR-005 */
  @Authenticated() @AllowWithoutMfa() @NoBody() @Post('mfa/enroll') @HttpCode(200)
  enroll() { return this.auth.enrollMfa(); }

  @Authenticated() @AllowWithoutMfa() @BodySchema(MfaBody) @Post('mfa/verify') @HttpCode(200)
  async verify(@Body() b: z.infer<typeof MfaBody>, @Res({ passthrough: true }) res: Response) {
    await this.auth.verifyMfa(b.code, res);
    return { ok: true };
  }

  /**
   * Status sesi untuk UI klinik — boleh dipanggil sebelum MFA (halaman login/MFA perlu tahu langkah berikutnya).
   * Tidak memuat permission atau data selain milik user sendiri; endpoint lain tetap terkunci sampai MFA (E07).
   */
  @Authenticated() @AllowWithoutMfa() @Get('session')
  async session() {
    const c = ctx();
    const [s] = await this.db.withTenantTx((tx) => rows<{ email: string; fullName: string; mfaEnrolled: boolean; code: string; name: string }>(tx, sql`
      select u.email, u.full_name as "fullName", exists(select 1 from user_mfa m where m.user_id = u.id) as "mfaEnrolled",
             t.code, t.display_name as name
        from app_user u join tenant t on t.id = u.tenant_id where u.id = ${c.userId}`));
    return { email: s.email, fullName: s.fullName, tenant: { code: s.code, name: s.name },
             mfaRequired: c.mfaRequired ?? false, mfaEnrolled: s.mfaEnrolled, mfaVerified: !!c.mfaVerified };
  }

  @Authenticated() @AllowWithoutMfa() @NoBody() @Post('logout') @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response) {
    const c = ctx();
    await this.db.withTenantTx(async (tx) => {
      await tx.execute(sql`update user_session set revoked_at = now(), revoke_reason = 'LOGOUT' where id = ${c.sessionId}`);
      await audit(tx, 'LOGOUT', 'app_user', c.userId!);
    });
    this.sessions.clearCookies(res);
  }
}
