import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, pgError, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { ConsentDocumentBody } from './patient.schemas';

interface Row { id: string; consent_type: string; version: string; title: string | null; content: string; effective_at: string }
const dto = (r: Row) => ({ id: r.id, consentType: r.consent_type, version: r.version, title: r.title, content: r.content, effectiveAt: r.effective_at });

/**
 * Teks consent berversi (REG-FR-008 `[REVIEW-MEDIS]`). Teks yang sudah terbit tidak dapat diubah (UPDATE/DELETE dicabut
 * di database) — perubahan = versi baru, sehingga setiap consent pasien selalu merujuk teks yang benar-benar ditandatangani.
 */
@Controller('api/v1/consent-documents')
export class ConsentDocumentsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('patient.read') @Get()
  async list() {
    return (await this.db.withTenantTx((tx) => rows<Row>(tx, sql`
      select id, consent_type, version, title, content, effective_at from consent_document
       order by consent_type, effective_at desc, version desc`))).map(dto);
  }

  @RequirePermission('tenant.profile.manage') @BodySchema(ConsentDocumentBody) @Post() @HttpCode(201)
  async create(@Body() b: z.infer<typeof ConsentDocumentBody>) {
    try {
      return await this.db.withTenantTx(async (tx) => {
        const [r] = await rows<Row>(tx, sql`
          insert into consent_document(tenant_id, consent_type, version, title, content, created_by)
          values (app.current_tenant_id(), ${b.consentType}, ${b.version}, ${b.title}, ${b.content}, ${ctx().userId})
          returning id, consent_type, version, title, content, effective_at`);
        await audit(tx, 'CONSENT_DOCUMENT_CREATED', 'consent_document', r.id, null, { consentType: b.consentType, version: b.version, title: b.title });
        return dto(r);
      });
    } catch (e) {
      if (pgError(e)?.code === '23505') throw problem(409, 'PAT-409-CONSENT-VERSION', 'Versi ini sudah ada untuk jenis consent tersebut');
      throw e;
    }
  }
}
