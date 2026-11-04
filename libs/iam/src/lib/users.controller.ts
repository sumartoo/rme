import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Authenticated, BodySchema, NoBody, RequirePermission, ctx, problem, randomToken, sha256Hex } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { SessionService } from './session.service';

/** Array JS → array PostgreSQL. Drizzle memecah array menjadi daftar parameter, jadi dikirim sebagai satu JSON (tanpa sql.raw). */
export const pgArray = (xs: readonly string[], type: 'uuid' | 'text') => type === 'uuid'
  ? sql`(array(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb)))::uuid[]`
  : sql`array(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = z.string().regex(UUID_RE);
const DisableBody = z.object({ reason: z.string().trim().min(3).max(500) });
const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(2).max(200).optional(),
  roleIds: z.array(UUID).min(1).max(10),
  branchIds: z.array(UUID).max(50).optional(),
}).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional() });

interface UserRow { id: string; email: string; full_name: string; status: string; last_login_at: Date | null; roles: string[]; mfa_enrolled: boolean }
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * Cegah eskalasi hak (SC-AUTHZ): izin administratif (kelola user/role, data & profil klinik, audit, integrasi)
 * hanya dapat diberikan oleh yang memilikinya. Izin klinis/operasional boleh diberikan admin — admin klinik memang
 * mengundang dokter/kasir tanpa ikut memegang izin klinis mereka.
 */
const ADMIN_PERMISSION = /^(iam|tenant|audit|integration)\./;
export function assertNoEscalationPerms(perms: Iterable<string>) {
  const mine = ctx().permissions ?? new Set<string>();
  if ([...perms].some((p) => ADMIN_PERMISSION.test(p) && !mine.has(p))) {
    throw problem(403, 'IAM-403-ESCALATION', 'Tidak dapat memberikan izin administratif yang tidak Anda miliki');
  }
}
export async function assertNoEscalation(tx: Tx, roleIds: string[]) {
  const wanted = await rows<{ permission_code: string }>(tx, sql`
    select distinct permission_code from role_permission where role_id = any(${pgArray(roleIds, 'uuid')})`);
  assertNoEscalationPerms(wanted.map((w) => w.permission_code));
}

/** Pengguna klinik (IAM-FR-001, 013, 014). Semua aksi teraudit. */
@Controller('api/v1')
export class UsersController {
  constructor(private readonly db: Db, private readonly sessions: SessionService) {}

  @Authenticated() @Get('me')
  async me() {
    const c = ctx();
    const { u, branches } = await this.db.withTenantTx(async (tx) => ({
      u: (await rows(tx, sql`select id, email, full_name as "fullName", status from app_user where id = ${c.userId}`))[0],
      // Cabang yang dapat dipilih (IAM-FR-009): penugasan tanpa cabang = semua cabang aktif
      branches: await rows<{ id: string; code: string; name: string }>(tx, sql`
        select br.id, br.code, br.name from branch br
         where br.is_active and exists(select 1 from user_role_assignment a where a.user_id = ${c.userId}
                 and (a.valid_to is null or a.valid_to > now()) and (a.branch_id is null or a.branch_id = br.id))
         order by br.name`),
    }));
    return { user: u, tenantId: c.tenantId, permissions: [...(c.permissions ?? [])].sort(), mfaVerified: c.mfaVerified,
             branches, activeBranchId: c.branchId ?? null };
  }

  @RequirePermission('iam.user.read') @Get('users')
  async list(@Query() q: Record<string, unknown>) {
    const p = ListQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { limit, cursor } = p.data;
    const r = await this.db.withTenantTx((tx) => rows<UserRow>(tx, sql`
      select u.id, u.email, u.full_name, u.status, u.last_login_at,
             exists(select 1 from user_mfa m where m.user_id = u.id) as mfa_enrolled,
             array(select distinct r.code from user_role_assignment a join role r on r.id = a.role_id
                    where a.user_id = u.id and (a.valid_to is null or a.valid_to > now()) order by r.code) as roles
        from app_user u
       where (${cursor ?? null}::text is null or lower(u.email) > ${cursor ?? ''})
       order by lower(u.email) limit ${limit + 1}`));
    const data = r.slice(0, limit).map((u) => ({ id: u.id, email: u.email, fullName: u.full_name, status: u.status,
      lastLoginAt: iso(u.last_login_at), roles: u.roles, mfaEnrolled: u.mfa_enrolled }));
    return { data, page: { hasMore: r.length > limit, nextCursor: r.length > limit ? data[data.length - 1].email.toLowerCase() : null } };
  }

  /** Undangan aktif yang belum diterima (untuk halaman Pengguna). */
  @RequirePermission('iam.user.read') @Get('users/invitations')
  async invitations() {
    const r = await this.db.withTenantTx((tx) => rows<{ id: string; email: string; expires_at: Date; created_at: Date; roles: string[] }>(tx, sql`
      select i.id, i.email, i.expires_at, i.created_at, array(select r.name from role r where r.id = any(i.role_ids) order by r.name) as roles
        from user_invitation i where i.accepted_at is null and i.expires_at > now() order by i.created_at desc limit 200`));
    return r.map((i) => ({ id: i.id, email: i.email, expiresAt: iso(i.expires_at), createdAt: iso(i.created_at), acceptedAt: null, roles: i.roles }));
  }

  /** IAM-FR-001: undangan berlaku 7 hari; email (berisi tautan) dikirim worker lewat outbox. */
  @RequirePermission('iam.user.manage') @BodySchema(InviteBody) @Post('users/invitations') @HttpCode(201)
  async invite(@Body() b: z.infer<typeof InviteBody>) {
    return this.db.withTenantTx(async (tx) => {
      const roles = await rows(tx, sql`select id from role where id = any(${pgArray(b.roleIds, 'uuid')})`);
      if (roles.length !== new Set(b.roleIds).size) throw problem(400, 'IAM-400-ROLE', 'Role tidak ditemukan');
      if (b.branchIds?.length) {
        const br = await rows(tx, sql`select id from branch where id = any(${pgArray(b.branchIds, 'uuid')}) and is_active`);
        if (br.length !== new Set(b.branchIds).size) throw problem(400, 'IAM-400-BRANCH', 'Cabang tidak ditemukan');
      }
      await assertNoEscalation(tx, b.roleIds);
      const [u] = await rows(tx, sql`select 1 from app_user where lower(email) = ${b.email}`);
      if (u) throw problem(409, 'IAM-409-USER-EXISTS', 'Pengguna dengan email ini sudah ada');
      const [pending] = await rows(tx, sql`select 1 from user_invitation where lower(email) = ${b.email} and accepted_at is null and expires_at > now()`);
      if (pending) throw problem(409, 'IAM-409-INVITED', 'Email ini sudah punya undangan aktif');
      // Token sementara (tidak pernah dikirim); worker membuat token baru saat email dikirim (OD-078)
      const [inv] = await rows<{ id: string; email: string; expires_at: Date }>(tx, sql`
        insert into user_invitation(tenant_id, email, role_ids, branch_ids, token_hash, invited_by, expires_at)
        values (app.current_tenant_id(), ${b.email}, ${pgArray(b.roleIds, 'uuid')}, ${pgArray(b.branchIds ?? [], 'uuid')}, ${sha256Hex(randomToken())},
                ${ctx().userId}, now() + interval '7 days')
        returning id, email, expires_at`);
      await audit(tx, 'USER_INVITED', 'user_invitation', inv.id, null, { roleIds: b.roleIds, branchCount: b.branchIds?.length ?? 0 });
      return { id: inv.id, email: inv.email, expiresAt: iso(inv.expires_at), acceptedAt: null };
    });
  }

  /** IAM-FR-014: menonaktifkan user mencabut seluruh sesinya. */
  @RequirePermission('iam.user.manage') @BodySchema(DisableBody) @Post('users/:id/disable') @HttpCode(200)
  async disableUser(@Param('id', new ParseUUIDPipe()) id: string, @Body() { reason }: z.infer<typeof DisableBody>) {
    if (id === ctx().userId) throw problem(409, 'IAM-409-SELF', 'Anda tidak dapat menonaktifkan akun sendiri');
    return this.db.withTenantTx(async (tx) => {
      const r = await rows(tx, sql`update app_user set status = 'DISABLED' where id = ${id} returning id`);
      if (!r.length) throw problem(404, 'IAM-404', 'User tidak ditemukan');
      const revoked = await this.sessions.revokeAllForUser(tx, id, 'USER_DISABLED');
      await audit(tx, 'USER_DISABLED', 'app_user', id, null, { reason, sessionsRevoked: revoked });
      return { id, status: 'DISABLED', sessionsRevoked: revoked };
    });
  }

  /** Aktifkan kembali (kuota paket berlaku — trigger database, PLT-FR-004). */
  @RequirePermission('iam.user.manage') @NoBody() @Post('users/:id/enable') @HttpCode(200)
  async enableUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.db.withTenantTx(async (tx) => {
      const r = await rows(tx, sql`update app_user set status = 'ACTIVE' where id = ${id} and status = 'DISABLED' returning id`);
      if (!r.length) throw problem(404, 'IAM-404', 'User nonaktif tidak ditemukan');
      await audit(tx, 'USER_ENABLED', 'app_user', id);
      return { id, status: 'ACTIVE' };
    });
  }

  /**
   * Reset MFA (perangkat authenticator hilang, SC-AUTH-07): hapus TOTP & recovery code, cabut semua sesi;
   * pengguna mendaftar ulang saat login berikutnya. Tidak boleh untuk diri sendiri, dan hanya bila pengubah
   * memiliki izin administratif yang dimiliki target (cegah eskalasi: admin tidak dapat "diambil alih").
   */
  @RequirePermission('iam.user.manage') @NoBody() @Delete('users/:id/mfa') @HttpCode(204)
  async resetMfa(@Param('id', new ParseUUIDPipe()) id: string) {
    if (id === ctx().userId) throw problem(409, 'IAM-409-SELF', 'Gunakan halaman Sesi & perangkat untuk akun sendiri');
    await this.db.withTenantTx(async (tx) => {
      const [u] = await rows(tx, sql`select 1 from app_user where id = ${id}`);
      if (!u) throw problem(404, 'IAM-404', 'User tidak ditemukan');
      const roleIds = (await rows<{ role_id: string }>(tx, sql`select role_id from user_role_assignment
                                                              where user_id = ${id} and (valid_to is null or valid_to > now())`)).map((r) => r.role_id);
      if (roleIds.length) await assertNoEscalation(tx, roleIds);
      const removed = await rows(tx, sql`delete from user_mfa where user_id = ${id} returning user_id`);
      if (!removed.length) throw problem(409, 'IAM-409-MFA-NOT-ENROLLED', 'Pengguna ini belum mendaftarkan MFA');
      const n = await this.sessions.revokeAllForUser(tx, id, 'MFA_RESET');
      await audit(tx, 'MFA_RESET', 'app_user', id, null, { sessionsRevoked: n });
    });
  }

  /** IAM-FR-013: admin mencabut semua sesi user lain (mis. perangkat hilang). */
  @RequirePermission('iam.user.manage') @NoBody() @Delete('users/:id/sessions') @HttpCode(204)
  async revokeAll(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.db.withTenantTx(async (tx) => {
      const [u] = await rows(tx, sql`select 1 from app_user where id = ${id}`);
      if (!u) throw problem(404, 'IAM-404', 'User tidak ditemukan');
      const n = await this.sessions.revokeAllForUser(tx, id, 'ADMIN_REVOKED');
      await audit(tx, 'SESSIONS_REVOKED', 'app_user', id, null, { sessionsRevoked: n });
    });
  }
}

export { UUID_RE };
