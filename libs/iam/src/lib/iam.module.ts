import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { RolesController } from './roles.controller';
import { AuthService } from './auth.service';
import { ContextMiddleware } from './context.middleware';
import { SecurityGuard } from './security.guard';
import { SessionService } from './session.service';
import { UsersController } from './users.controller';

/**
 * IAM: autentikasi, sesi, tenant context & otorisasi global.
 * Membutuhkan provider CONFIG dan Db dari modul root (global).
 */
@Module({
  controllers: [AuthController, UsersController, AccountController, RolesController],
  providers: [SessionService, AuthService, ContextMiddleware, { provide: APP_GUARD, useClass: SecurityGuard }],
  exports: [SessionService, AuthService],
})
export class IamModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
