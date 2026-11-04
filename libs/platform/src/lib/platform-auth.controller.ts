import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowWithoutMfa, BodySchema, NoBody, PlatformAuthenticated, PlatformPublic, ctx } from '@clinicrme/shared';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessionService, PLATFORM_SESSION_COOKIE } from './platform-session.service';

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
const MfaBody = z.object({ code: z.string().min(6).max(20) });

@Controller('api/platform/v1')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService, private readonly sessions: PlatformSessionService) {}

  @PlatformPublic() @BodySchema(LoginBody) @Post('auth/login') @HttpCode(200)
  login(@Body() b: z.infer<typeof LoginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(b.email, b.password, res, req.headers['user-agent']);
  }

  @PlatformAuthenticated() @AllowWithoutMfa() @NoBody() @Post('auth/mfa/enroll') @HttpCode(200)
  enroll() { return this.auth.enrollMfa(); }

  @PlatformAuthenticated() @AllowWithoutMfa() @BodySchema(MfaBody) @Post('auth/mfa/verify') @HttpCode(204)
  async verify(@Body() b: z.infer<typeof MfaBody>, @Res({ passthrough: true }) res: Response) {
    await this.auth.verifyMfa(b.code, res);
  }

  @PlatformAuthenticated() @AllowWithoutMfa() @NoBody() @Post('auth/logout') @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response) {
    await this.auth.logout(res);
  }

  /** Boleh sebelum MFA agar UI tahu langkah berikutnya (daftar / verifikasi TOTP). */
  @PlatformAuthenticated() @AllowWithoutMfa() @Get('me')
  async me(@Req() req: Request) {
    const c = ctx();
    const s = (await this.sessions.resolve(req.cookies?.[PLATFORM_SESSION_COOKIE]))!;
    return { id: s.user_id, email: s.email, fullName: s.full_name, roles: s.roles, permissions: [...(c.permissions ?? [])].sort(),
             mfaVerified: s.mfa_verified, mfaEnrolled: s.mfa_enrolled };
  }
}
