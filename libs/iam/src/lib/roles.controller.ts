import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { BodySchema, RequirePermission, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { UUID_RE, assertNoEscalationPerms, pgArray } from './users.controller';

/** OD-080: role ini selalu wajib MFA, tidak dapat dimatikan tenant. */
export const MFA_LOCKED_ROLES = new Set(['TENANT_ADMIN', 'MANAJER']);
const PERM = z.string().regex(/^[a-z]+(\.[a-z_]+)+$/);
const CreateBody = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'Kode: huruf besar, angka, garis bawah (3–40)'),
  name: z.string().trim().min(2).max(100),
  requiresMfa: z.boolean().default(false),
  permissions: z.array(PERM).max(200),
}).strict();
const UpdateBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  requiresMfa: z.boolean().optional(),
  permissions: z.array(PERM).max(200).optional(),
}).strict();

interface RoleRow { id: string; code: string; name: string; is_template: boolean; requires_mfa: boolean; version: number; permissions: string[]; user_count: number }
const SELECT = sql`select r.id, r.code, r.name, r.is_template, r.requires_mfa, r.version,
                          array(select p.permission_code from role_permission p where p.role_id = r.id order by 1) as permissions,
                          (select count(distinct a.user_id)::int from user_role_assignment a where a.role_id = r.id and (a.valid_to is null or a.valid_to > now())) as user_count
                     from role r`;
const dto = (r: RoleRow) => ({ id: r.id, code: r.code, name: r.name, isTemplate: r.is_template, requiresMfa: r.requires_mfa,
  mfaLocked: MFA_LOCKED_ROLES.has(r.code), permissions: r.permissions, userCount: r.user_count, version: r.version });

async function assertPermissionsExist(tx: Tx, perms: string[]) {
  const found = await rows(tx, sql`select code from permission where code = any(${pgArray(perms, 'text')})`);
  if (found.length !== new Set(perms).size) throw problem(400, 'IAM-400-PERMISSION', 'Permission tidak dikenal');
}

/**
 * Role & permission (IAM-FR-007, 008, 005/OD-080). Role template: permission tetap (diperbarui lewat rilis),
 * hanya kewajiban MFA yang dapat diubah. Role custom: nama, permission, MFA. Tidak boleh memberi permission
 * yang tidak dimiliki pengubah (eskalasi). Perubahan berlaku pada request berikutnya untuk semua sesi.
 */
@Controller('api/v1')
export class RolesController {
  constructor(private readonly db: Db) {}

  @RequirePermission('iam.role.read') @Get('permissions')
  permissions() {
    return this.db.withTenantTx((tx) => rows(tx, sql`select code, module, description from permission order by module, code`));
  }

  @RequirePermission('iam.role.read') @Get('roles')
  async list() {
    const r = await this.db.withTenantTx((tx) => rows<RoleRow>(tx, sql`${SELECT} order by r.is_template desc, r.name`));
    return r.map(dto);
  }

  @RequirePermission('iam.role.manage') @BodySchema(CreateBody) @Post('roles') @HttpCode(201)
  async create(@Body() b: z.infer<typeof CreateBody>) {
    return this.db.withTenantTx(async (tx) => {
      await assertPermissionsExist(tx, b.permissions);
      assertNoEscalationPerms(b.permissions);
      const [dup] = await rows(tx, sql`select 1 from role where code = ${b.code}`);
      if (dup) throw problem(409, 'IAM-409-ROLE-CODE', 'Kode role sudah dipakai');
      const [r] = await rows<{ id: string }>(tx, sql`insert into role(tenant_id, code, name, is_template, requires_mfa)
                                                    values (app.current_tenant_id(), ${b.code}, ${b.name}, false, ${b.requiresMfa}) returning id`);
      for (const p of new Set(b.permissions)) {
        await tx.execute(sql`insert into role_permission(tenant_id, role_id, permission_code) values (app.current_tenant_id(), ${r.id}, ${p})`);
      }
      await audit(tx, 'ROLE_CREATED', 'role', r.id, null, { code: b.code, permissions: b.permissions.length, requiresMfa: b.requiresMfa });
      const [row] = await rows<RoleRow>(tx, sql`${SELECT} where r.id = ${r.id}`);
      return dto(row);
    });
  }

  /** Optimistic locking (GEN-FR-007): If-Match = versi role. */
  @RequirePermission('iam.role.manage') @BodySchema(UpdateBody) @Put('roles/:roleId')
  async update(@Param('roleId') id: string, @Body() b: z.infer<typeof UpdateBody>, @Headers('if-match') ifMatch: string | undefined,
               @Res({ passthrough: true }) res: Response) {
    if (!UUID_RE.test(id)) throw problem(404, 'IAM-404-ROLE', 'Role tidak ditemukan');
    const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(ifMatch ?? '');
    if (!m) throw problem(428, 'GEN-428-IF-MATCH', 'Header If-Match (versi role) wajib');
    const out = await this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<RoleRow>(tx, sql`${SELECT} where r.id = ${id} for update of r`);
      if (!cur) throw problem(404, 'IAM-404-ROLE', 'Role tidak ditemukan');
      if (cur.version !== Number(m[1])) throw problem(412, 'GEN-412-VERSION', 'Role sudah diubah orang lain. Muat ulang lalu coba lagi.');
      if (cur.is_template && (b.permissions !== undefined || b.name !== undefined)) {
        throw problem(409, 'IAM-409-TEMPLATE', 'Role bawaan hanya dapat diubah kewajiban MFA-nya. Buat role custom untuk izin lain.');
      }
      if (b.requiresMfa === false && MFA_LOCKED_ROLES.has(cur.code)) {
        throw problem(409, 'IAM-409-MFA-LOCKED', 'Role ini selalu wajib MFA');
      }
      if (b.permissions) {
        // Izin administratif yang tidak dimiliki pengubah tidak boleh ditambah maupun dicabut dari role
        assertNoEscalationPerms([...cur.permissions.filter((p) => !b.permissions!.includes(p)), ...b.permissions]);
        await assertPermissionsExist(tx, b.permissions);
        await tx.execute(sql`delete from role_permission where role_id = ${id}`);
        for (const p of new Set(b.permissions)) {
          await tx.execute(sql`insert into role_permission(tenant_id, role_id, permission_code) values (app.current_tenant_id(), ${id}, ${p})`);
        }
      }
      await tx.execute(sql`update role set name = coalesce(${b.name ?? null}, name), requires_mfa = coalesce(${b.requiresMfa ?? null}::boolean, requires_mfa)
                         where id = ${id}`);
      const added = (b.permissions ?? []).filter((p) => !cur.permissions.includes(p));
      const removed = b.permissions ? cur.permissions.filter((p) => !b.permissions!.includes(p)) : [];
      await audit(tx, 'ROLE_UPDATED', 'role', id, null, { code: cur.code, added, removed,
        ...(b.requiresMfa !== undefined && b.requiresMfa !== cur.requires_mfa ? { requiresMfa: b.requiresMfa } : {}) });
      const [row] = await rows<RoleRow>(tx, sql`${SELECT} where r.id = ${id}`);
      return dto(row);
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}

