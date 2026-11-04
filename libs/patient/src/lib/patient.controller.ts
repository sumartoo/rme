import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { RequirePermission, problem } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';

/**
 * Pasien — baru endpoint baca minimal (fondasi Stage 3–4: isolasi tenant & audit baca).
 * Pendaftaran, pencarian, dan merge dibangun di Stage 8 (PAT-FR-*).
 */
@Controller('api/v1/patients')
export class PatientController {
  constructor(private readonly db: Db) {}

  @RequirePermission('patient.read') @Get()
  async list() {
    return { data: await this.db.withTenantTx((tx) => rows(tx, sql`select id, mrn, full_name as "fullName" from patient order by mrn limit 100`)) };
  }

  /** Resource tenant lain → 404, bukan 403 (SC-TEN-05). Akses baca dicatat di audit (AUD-FR-002). */
  @RequirePermission('patient.read') @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenantTx(async (tx) => {
      const [p] = await rows(tx, sql`select id, mrn, full_name as "fullName", birth_date as "birthDate" from patient where id = ${id}`);
      if (!p) throw problem(404, 'PAT-404', 'Pasien tidak ditemukan');
      await audit(tx, 'READ', 'patient', id, id);
      return p;
    });
  }
}
