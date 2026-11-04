import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ZodType } from 'zod';
import { BODY_SCHEMA_KEY, NO_BODY_KEY } from './decorators';
import { Problem } from './problem';

/**
 * Validasi body global (SC-WEB-05). Berjalan setelah guard keamanan, sehingga request tanpa hak akses
 * tidak pernah sampai ke validasi (tidak membocorkan bentuk input). Body yang lolos diganti hasil parse Zod:
 * field yang tidak dideklarasikan dibuang.
 */
@Injectable()
export class BodyValidationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ec: ExecutionContext, next: CallHandler) {
    if (ec.getType() !== 'http') return next.handle();
    const req = ec.switchToHttp().getRequest<Request>();
    const targets = [ec.getHandler(), ec.getClass()];
    const schema = this.reflector.getAllAndOverride<ZodType | undefined>(BODY_SCHEMA_KEY, targets);
    if (schema) {
      const r = schema.safeParse(req.body ?? {});
      if (!r.success) {
        throw new Problem(400, 'GEN-400-VALIDATION', 'Input tidak valid',
          r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
      }
      req.body = r.data;
    } else if (this.reflector.getAllAndOverride<boolean>(NO_BODY_KEY, targets) && hasBody(req.body)) {
      throw new Problem(400, 'GEN-400-UNEXPECTED-BODY', 'Endpoint ini tidak menerima body');
    }
    return next.handle();
  }
}

const hasBody = (b: unknown) => b != null && (typeof b !== 'object' || Object.keys(b as object).length > 0);
