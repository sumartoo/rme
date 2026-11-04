import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSecurityGuard } from './platform-security.guard';
import { PlatformSessionService } from './platform-session.service';
import { SupportAccessController, SupportAccessService } from './support-access';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

/**
 * Konsol platform (Stage 5, CR-0001): login pengguna platform + MFA wajib, tenant, paket, status, feature flag.
 * Membutuhkan CONFIG & PlatformDb (global) dan ContextMiddleware (libs/iam) yang menandai host admin.<domain>.
 * PlatformSecurityGuard terdaftar bersama controller-nya: route @Platform* tidak pernah ada tanpa guard ini.
 */
@Module({
  controllers: [PlatformAuthController, TenantsController, SupportAccessController],
  providers: [PlatformSessionService, PlatformAuthService, TenantsService, SupportAccessService, { provide: APP_GUARD, useClass: PlatformSecurityGuard }],
  exports: [PlatformAuthService],
})
export class PlatformModule {}
