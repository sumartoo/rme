import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, RequirePermission, Uuid, assertId, assertVersion, ctx, ifMatchVersion, problem } from '@clinicrme/shared';
import { Db, auditChange, rows } from '@clinicrme/db';

const LocationBody = z.object({ branchId: Uuid, name: z.string().trim().min(2).max(100), isActive: z.boolean().optional() }).strict();
interface Row { id: string; branch_id: string; branch_name: string; name: string; is_default: boolean; is_active: boolean; version: number }
const dto = (r: Row) => ({ id: r.id, branchId: r.branch_id, branchName: r.branch_name, name: r.name, isDefault: r.is_default, isActive: r.is_active, version: r.version });
const SEL = sql`select l.id, l.branch_id, b.name as branch_name, l.name, l.is_default, l.is_active, l.version
                  from stock_location l join branch b on b.id = l.branch_id`;

/** Lokasi stok per cabang (OD-097): "Apotek" bawaan dibuat otomatis per cabang; lokasi lain (mis. gudang) dapat ditambah. */
@Controller('api/v1')
export class LocationsController {
  constructor(private readonly db: Db) {}

  @RequirePermission('master.facility.read') @Get('stock-locations')
  async list(@Query('branchId') branchId?: string) {
    if (branchId) assertId(branchId, 'MST-404-BRANCH', 'Cabang tidak ditemukan');
    return this.db.withTenantTx(async (tx) => (await rows<Row>(tx, sql`${SEL}
      where (${branchId ?? null}::uuid is null or l.branch_id = ${branchId ?? null}::uuid)
      order by b.name, l.is_default desc, lower(l.name)`)).map(dto));
  }

  @RequirePermission('master.facility.manage') @BodySchema(LocationBody) @Post('stock-locations') @HttpCode(201)
  async create(@Body() b: z.infer<typeof LocationBody>) {
    return this.db.withTenantTx(async (tx) => {
      const [br] = await rows(tx, sql`select 1 from branch where id = ${b.branchId}`);
      if (!br) throw problem(400, 'MST-400-BRANCH', 'Cabang tidak ditemukan');
      const [dup] = await rows(tx, sql`select 1 from stock_location where branch_id = ${b.branchId} and lower(name) = lower(${b.name})`);
      if (dup) throw problem(409, 'PHM-409-LOCATION', 'Nama lokasi sudah dipakai di cabang ini');
      const [{ id }] = await rows<{ id: string }>(tx, sql`insert into stock_location(tenant_id, branch_id, name, is_active, updated_by)
        values (app.current_tenant_id(), ${b.branchId}, ${b.name}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      const [r] = await rows<Row>(tx, sql`${SEL} where l.id = ${id}`);
      await auditChange(tx, 'STOCK_LOCATION_CREATED', 'stock_location', id, null, dto(r));
      return dto(r);
    });
  }

  @RequirePermission('master.facility.manage') @BodySchema(LocationBody.omit({ branchId: true }).partial().strict()) @Put('stock-locations/:id')
  async update(@Param('id') id: string, @Body() b: { name?: string; isActive?: boolean }, @Headers('if-match') ifMatch: string | undefined) {
    assertId(id, 'PHM-404-LOCATION', 'Lokasi tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'lokasi');
    return this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<Row>(tx, sql`${SEL} where l.id = ${id} for update of l`);
      if (!cur) throw problem(404, 'PHM-404-LOCATION', 'Lokasi tidak ditemukan');
      assertVersion(cur.version, v, 'Lokasi');
      if (cur.is_default && b.isActive === false) throw problem(409, 'PHM-409-DEFAULT', 'Lokasi bawaan cabang tidak dapat dinonaktifkan');
      if (b.isActive === false) {
        const [has] = await rows(tx, sql`select 1 from stock_balance where location_id = ${id} and qty_on_hand > 0 limit 1`);
        if (has) throw problem(409, 'PHM-409-HAS-STOCK', 'Lokasi masih memiliki stok');
      }
      await tx.execute(sql`update stock_location set name = ${b.name ?? cur.name}, is_active = ${b.isActive ?? cur.is_active}, updated_by = ${ctx().userId} where id = ${id}`);
      const [r] = await rows<Row>(tx, sql`${SEL} where l.id = ${id}`);
      await auditChange(tx, 'STOCK_LOCATION_UPDATED', 'stock_location', id, dto(cur), dto(r));
      return dto(r);
    });
  }
}
