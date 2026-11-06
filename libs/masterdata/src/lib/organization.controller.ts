import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, rows } from '@clinicrme/db';
import { Code, Name, Uuid, assertId, assertVersion, auditChange, ifMatchVersion, merge, optText } from './common';

// ---------------------------------------------------------------------------------------------- Fasilitas
const FacilityBody = z.object({
  name: Name,
  facilityType: z.enum(['KLINIK_UTAMA', 'KLINIK_PRATAMA', 'PRAKTIK_MANDIRI']),
  licenseNumber: optText(100),
  isActive: z.boolean().optional(),
}).strict();
interface FacilityRow { id: string; name: string; facility_type: string; license_number: string | null; is_active: boolean; version: number }
const facilityDto = (r: FacilityRow) => ({ id: r.id, name: r.name, facilityType: r.facility_type, licenseNumber: r.license_number,
  isActive: r.is_active, version: r.version });
const FACILITY = sql`select id, name, facility_type, license_number, is_active, version from facility`;

// ---------------------------------------------------------------------------------------------- Cabang
const TZ = z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']);
const BranchBody = z.object({
  facilityId: Uuid,
  code: Code,
  name: Name,
  address: optText(500),
  regionCode: z.string().regex(/^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/).nullable().optional(),
  phone: optText(30),
  timezone: TZ.optional(),   // tanpa .default: pada PUT parsial nilai lama harus tetap
  isActive: z.boolean().optional(),
}).strict();
interface BranchRow { id: string; facility_id: string; code: string; name: string; address: string | null; region_code: string | null;
  phone: string | null; timezone: string; is_active: boolean; version: number }
const branchDto = (r: BranchRow) => ({ id: r.id, facilityId: r.facility_id, code: r.code, name: r.name, address: r.address,
  regionCode: r.region_code, phone: r.phone, timezone: r.timezone, isActive: r.is_active, version: r.version });
const BRANCH = sql`select id, facility_id, code, name, address, region_code, phone, timezone, is_active, version from branch`;

// ---------------------------------------------------------------------------------------------- Poli / unit
export const UnitBody = z.object({
  branchId: Uuid,
  code: Code,
  name: Name,
  unitType: z.enum(['POLI', 'RUANG', 'FARMASI', 'KASIR', 'LAB', 'LAINNYA']),
  specialty: optText(100),
  queuePrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/, 'Awalan antrean 1–3 huruf').nullable().optional(),   // OD-086
  isActive: z.boolean().optional(),
}).strict();
interface UnitRow { id: string; branch_id: string; code: string; name: string; unit_type: string; specialty: string | null; queue_prefix: string | null; is_active: boolean; version: number }
const unitDto = (r: UnitRow) => ({ id: r.id, branchId: r.branch_id, code: r.code, name: r.name, unitType: r.unit_type,
  specialty: r.specialty, queuePrefix: r.queue_prefix, isActive: r.is_active, version: r.version });
const UNIT = sql`select id, branch_id, code, name, unit_type, specialty, queue_prefix, is_active, version from service_unit`;

const ListQuery = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
  branchId: Uuid.optional(),
});
function listQuery(q: Record<string, unknown>) {
  const p = ListQuery.safeParse(q);
  if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
  return { all: p.data.includeInactive === 'true', branchId: p.data.branchId ?? null };
}

async function assertFacility(tx: Tx, id: string) {
  const [f] = await rows(tx, sql`select 1 from facility where id = ${id}`);
  if (!f) throw problem(400, 'MST-400-FACILITY', 'Fasilitas tidak ditemukan');
}
async function assertBranch(tx: Tx, id: string) {
  const [b] = await rows(tx, sql`select 1 from branch where id = ${id}`);
  if (!b) throw problem(400, 'MST-400-BRANCH', 'Cabang tidak ditemukan');
}
async function assertRegion(tx: Tx, code: string | null | undefined) {
  if (!code) return;
  const [r] = await rows(tx, sql`select 1 from region where code = ${code}`);
  if (!r) throw problem(400, 'MST-400-REGION', 'Kode wilayah tidak dikenal');
}

/**
 * Struktur organisasi klinik (MST-FR-001): fasilitas → cabang → poli/ruang/unit. Ubah memakai If-Match (GEN-FR-007);
 * setiap perubahan teraudit sebelum/sesudah (MST-FR-009). Cabang tidak dihapus — dinonaktifkan; mengaktifkan
 * kembali / menambah cabang aktif dicek kuota paket oleh trigger database (PLT-FR-004).
 */
@Controller('api/v1')
export class OrganizationController {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------------------------------------ fasilitas
  @RequirePermission('master.facility.read') @Get('facilities')
  async facilities(@Query() q: Record<string, unknown>) {
    const { all } = listQuery(q);
    const r = await this.db.withTenantTx((tx) => rows<FacilityRow>(tx, sql`${FACILITY} where ${all}::boolean or is_active order by name`));
    return r.map(facilityDto);
  }

  @RequirePermission('master.facility.manage') @BodySchema(FacilityBody) @Post('facilities') @HttpCode(201)
  async createFacility(@Body() b: z.infer<typeof FacilityBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [r] = await rows<FacilityRow>(tx, sql`
        insert into facility(tenant_id, name, facility_type, license_number, is_active, updated_by)
        values (app.current_tenant_id(), ${b.name}, ${b.facilityType}, ${b.licenseNumber ?? null}, ${b.isActive ?? true}, ${ctx().userId})
        returning id, name, facility_type, license_number, is_active, version`);
      const d = facilityDto(r);
      await auditChange(tx, 'FACILITY_CREATED', 'facility', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.facility.manage') @BodySchema(FacilityBody.partial().strict()) @Put('facilities/:id')
  async updateFacility(@Param('id') id: string, @Body() b: Partial<z.infer<typeof FacilityBody>>,
                       @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-FACILITY', 'Fasilitas tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'fasilitas');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<FacilityRow>(tx, sql`${FACILITY} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-FACILITY', 'Fasilitas tidak ditemukan');
      assertVersion(cur.version, v, 'Fasilitas');
      const before = facilityDto(cur);
      const n = merge(before, b);
      const [r] = await rows<FacilityRow>(tx, sql`
        update facility set name = ${n.name}, facility_type = ${n.facilityType}, license_number = ${n.licenseNumber},
               is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id} returning id, name, facility_type, license_number, is_active, version`);
      const after = facilityDto(r);
      await auditChange(tx, 'FACILITY_UPDATED', 'facility', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  // ------------------------------------------------------------------------------------------ cabang
  @RequirePermission('master.facility.read') @Get('branches')
  async branches(@Query() q: Record<string, unknown>) {
    const { all } = listQuery(q);
    const r = await this.db.withTenantTx((tx) => rows<BranchRow>(tx, sql`${BRANCH} where ${all}::boolean or is_active order by name`));
    return r.map(branchDto);
  }

  @RequirePermission('master.facility.manage') @BodySchema(BranchBody) @Post('branches') @HttpCode(201)
  async createBranch(@Body() b: z.infer<typeof BranchBody>) {
    return this.db.withTenantTx(async (tx) => {
      await assertFacility(tx, b.facilityId);
      await assertRegion(tx, b.regionCode);
      const [dup] = await rows(tx, sql`select 1 from branch where code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode cabang sudah dipakai');
      const [r] = await rows<BranchRow>(tx, sql`
        insert into branch(tenant_id, facility_id, code, name, address, region_code, phone, timezone, is_active, updated_by)
        values (app.current_tenant_id(), ${b.facilityId}, ${b.code}, ${b.name}, ${b.address ?? null}, ${b.regionCode ?? null},
                ${b.phone ?? null}, ${b.timezone ?? 'Asia/Jakarta'}, ${b.isActive ?? true}, ${ctx().userId})
        returning id, facility_id, code, name, address, region_code, phone, timezone, is_active, version`);
      const d = branchDto(r);
      await auditChange(tx, 'BRANCH_CREATED', 'branch', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.facility.manage') @BodySchema(BranchBody.partial().strict()) @Put('branches/:id')
  async updateBranch(@Param('id') id: string, @Body() b: Partial<z.infer<typeof BranchBody>>,
                     @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'cabang');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<BranchRow>(tx, sql`${BRANCH} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
      assertVersion(cur.version, v, 'Cabang');
      const before = branchDto(cur);
      const n = merge(before, b);
      if (n.facilityId !== cur.facility_id) await assertFacility(tx, n.facilityId);
      if (n.regionCode !== cur.region_code) await assertRegion(tx, n.regionCode);
      if (n.code !== cur.code) {
        const [dup] = await rows(tx, sql`select 1 from branch where code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode cabang sudah dipakai');
      }
      const [r] = await rows<BranchRow>(tx, sql`
        update branch set facility_id = ${n.facilityId}, code = ${n.code}, name = ${n.name}, address = ${n.address},
               region_code = ${n.regionCode}, phone = ${n.phone}, timezone = ${n.timezone}, is_active = ${n.isActive},
               updated_by = ${ctx().userId}
         where id = ${id} returning id, facility_id, code, name, address, region_code, phone, timezone, is_active, version`);
      const after = branchDto(r);
      await auditChange(tx, 'BRANCH_UPDATED', 'branch', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }

  // ------------------------------------------------------------------------------------------ poli / unit
  @RequirePermission('master.facility.read') @Get('service-units')
  async units(@Query() q: Record<string, unknown>) {
    const { all, branchId } = listQuery(q);
    const r = await this.db.withTenantTx((tx) => rows<UnitRow>(tx, sql`${UNIT}
      where (${all}::boolean or is_active) and (${branchId}::uuid is null or branch_id = ${branchId}::uuid) order by name`));
    return r.map(unitDto);
  }

  @RequirePermission('master.facility.manage') @BodySchema(UnitBody) @Post('service-units') @HttpCode(201)
  async createUnit(@Body() b: z.infer<typeof UnitBody>) {
    return this.db.withTenantTx(async (tx) => {
      await assertBranch(tx, b.branchId);
      const [dup] = await rows(tx, sql`select 1 from service_unit where branch_id = ${b.branchId} and code = ${b.code}`);
      if (dup) throw problem(409, 'MST-409-CODE', 'Kode unit sudah dipakai di cabang ini');
      const [r] = await rows<UnitRow>(tx, sql`
        insert into service_unit(tenant_id, branch_id, code, name, unit_type, specialty, queue_prefix, is_active, updated_by)
        values (app.current_tenant_id(), ${b.branchId}, ${b.code}, ${b.name}, ${b.unitType}, ${b.specialty ?? null},
                ${b.queuePrefix ?? null}, ${b.isActive ?? true}, ${ctx().userId})
        returning id, branch_id, code, name, unit_type, specialty, queue_prefix, is_active, version`);
      const d = unitDto(r);
      await auditChange(tx, 'SERVICE_UNIT_CREATED', 'service_unit', r.id, null, d);
      return d;
    });
  }

  @RequirePermission('master.facility.manage') @BodySchema(UnitBody.partial().strict()) @Put('service-units/:id')
  async updateUnit(@Param('id') id: string, @Body() b: Partial<z.infer<typeof UnitBody>>,
                   @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-UNIT', 'Unit tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'unit');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<UnitRow>(tx, sql`${UNIT} where id = ${id} for update`);
      if (!cur) throw problem(404, 'MST-404-UNIT', 'Unit tidak ditemukan');
      assertVersion(cur.version, v, 'Unit');
      const before = unitDto(cur);
      const n = merge(before, b);
      if (n.branchId !== cur.branch_id) await assertBranch(tx, n.branchId);
      if (n.code !== cur.code || n.branchId !== cur.branch_id) {
        const [dup] = await rows(tx, sql`select 1 from service_unit where branch_id = ${n.branchId} and code = ${n.code} and id <> ${id}`);
        if (dup) throw problem(409, 'MST-409-CODE', 'Kode unit sudah dipakai di cabang ini');
      }
      const [r] = await rows<UnitRow>(tx, sql`
        update service_unit set branch_id = ${n.branchId}, code = ${n.code}, name = ${n.name}, unit_type = ${n.unitType},
               specialty = ${n.specialty}, queue_prefix = ${n.queuePrefix}, is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id} returning id, branch_id, code, name, unit_type, specialty, queue_prefix, is_active, version`);
      const after = unitDto(r);
      await auditChange(tx, 'SERVICE_UNIT_UPDATED', 'service_unit', id, before, after);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}
