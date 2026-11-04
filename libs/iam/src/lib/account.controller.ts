import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowWithoutMfa, Authenticated, BodySchema, NoBody, Public, ctx, problem, sha256Hex } from '@clinicrme/shared';
import { Db, audit, rows } from '@clinicrme/db';
import { AuthService } from './auth.service';
import { passwordProblem } from './password-policy';
import { SessionService } from './session.service';
import { assignInvitationRoles } from './assign-roles';

const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AcceptBody = z.object({ fullName: z.string().trim().min(2).max(200), password: z.string().min(1).max(200) }).strict();
const ResetRequestBody = z.object({ email: z.string().trim().email().max(254) }).strict();
const ResetConfirmBody = z.object({ token: z.string().regex(TOKEN), password: z.string().min(1).max(200) }).strict();
const BranchBody = z.object({ branchId: z.string().regex(UUID) }).strict();
const badInvite = () => problem(404, 'IAM-404-INVITATION', 'Undangan tidak ditemukan, sudah dipakai, atau kedaluwarsa');
const weak = (msg: string) => problem(400, 'IAM-400-PASSWORD', msg);

export interface MenuNode { code: string; label: string; route?: string; icon?: string; children: MenuNode[] }
interface InvRow { id: string; email: string; expires_at: Date; role_ids: string[]; branch_ids: string[]; tenant_name: string; roles: string[] }

/**
 * Akun & sesi pengguna klinik (Stage 6): undangan (IAM-FR-001, OD-078), reset password (IAM-FR-004),
 * menu dinamis (IAM-FR-010), cabang aktif (IAM-FR-009), sesi saya (IAM-FR-013).
 */
@Controller('api/v1')
export class AccountController {
  constructor(private readonly db: Db, private readonly sessions: SessionService) {}

  private async invitation(token: string): Promise<InvRow> {
    if (!TOKEN.test(token)) throw badInvite();
    const [inv] = await this.db.withTenant(ctx().hostTenantId!, (tx) => rows<InvRow>(tx, sql`
      select i.id, i.email, i.expires_at, i.role_ids, i.branch_ids, t.display_name as tenant_name,
             array(select r.name from role r where r.id = any(i.role_ids) order by r.name) as roles
        from user_invitation i join tenant t on t.id = i.tenant_id
       where i.token_hash = ${sha256Hex(token)} and i.accepted_at is null and i.expires_at > now()`));
    if (!inv) throw badInvite();
    return inv;
  }

  /** Detail undangan sebelum login — tanpa data selain milik penerima undangan. */
  @Public() @Get('invitations/:token')
  async getInvitation(@Param('token') token: string) {
    const i = await this.invitation(token);
    return { id: i.id, email: i.email, expiresAt: new Date(i.expires_at).toISOString(), acceptedAt: null, clinicName: i.tenant_name, roles: i.roles };
  }

  /** OD-078: terima undangan dengan membuat password (alternatif "Masuk dengan Google"). Login sesudahnya seperti biasa. */
  @Public() @BodySchema(AcceptBody) @Post('invitations/:token/accept') @HttpCode(201)
  async accept(@Param('token') token: string, @Body() b: z.infer<typeof AcceptBody>) {
    const i = await this.invitation(token);
    const msg = passwordProblem(b.password, i.email);
    if (msg) throw weak(msg);
    const passwordHash = await AuthService.hashPassword(b.password);
    await this.db.withTenant(ctx().hostTenantId!, async (tx) => {
      // Kunci baris undangan: dua permintaan bersamaan tidak boleh sama-sama berhasil
      const [locked] = await rows(tx, sql`select id from user_invitation where id = ${i.id} and accepted_at is null for update`);
      if (!locked) throw badInvite();
      const [existing] = await rows<{ id: string; has_password: boolean }>(tx, sql`
        select u.id, exists(select 1 from user_credential c where c.user_id = u.id) as has_password
          from app_user u where lower(u.email) = lower(${i.email})`);
      if (existing?.has_password) throw problem(409, 'IAM-409-USER-EXISTS', 'Akun dengan email ini sudah ada. Silakan masuk.');
      const userId = existing?.id ?? (await rows<{ id: string }>(tx, sql`
        insert into app_user(tenant_id, email, full_name) values (app.current_tenant_id(), lower(${i.email}), ${b.fullName}) returning id`))[0].id;
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await tx.execute(sql`insert into user_credential(tenant_id, user_id, password_hash) values (app.current_tenant_id(), ${userId}, ${passwordHash})`);
      await assignInvitationRoles(tx, userId, i.role_ids, i.branch_ids);
      await tx.execute(sql`update user_invitation set accepted_at = now(), accepted_user_id = ${userId} where id = ${i.id}`);
      await audit(tx, 'INVITATION_ACCEPTED', 'app_user', userId, null, { method: 'password' });
    });
    return { ok: true };
  }

  /** AC-IAM-FR-004-1: respons selalu sama (202) untuk email terdaftar maupun tidak; email dikirim worker. */
  @Public() @BodySchema(ResetRequestBody) @Post('auth/password-reset') @HttpCode(202)
  async requestReset(@Body() b: z.infer<typeof ResetRequestBody>) {
    await this.db.withTenant(ctx().hostTenantId!, async (tx) => {
      const [u] = await rows<{ id: string; recent: number }>(tx, sql`
        select u.id, (select count(*)::int from password_reset_request r where r.user_id = u.id and r.created_at > now() - interval '1 hour') as recent
          from app_user u join user_credential c on c.user_id = u.id
         where lower(u.email) = lower(${b.email}) and u.status = 'ACTIVE'`);
      if (!u || u.recent >= 3) return;                     // batas 3 permintaan/jam per akun, diam-diam
      await tx.execute(sql`insert into password_reset_request(tenant_id, user_id) values (app.current_tenant_id(), ${u.id})`);
      await tx.execute(sql`select set_config('app.user_id', ${u.id}, true)`);
      await audit(tx, 'PASSWORD_RESET_REQUESTED', 'app_user', u.id);
    });
    return { accepted: true };
  }

  /** Token sekali pakai 30 menit; password baru mengikuti kebijakan; semua sesi dicabut & kunci akun dibuka (SC-AUTH-07). */
  @Public() @BodySchema(ResetConfirmBody) @Post('auth/password-reset/confirm') @HttpCode(204)
  async confirmReset(@Body() b: z.infer<typeof ResetConfirmBody>) {
    const invalid = () => problem(400, 'IAM-400-RESET-TOKEN', 'Tautan reset tidak berlaku. Minta tautan baru.');
    const tenantId = ctx().hostTenantId!;
    const [r] = await this.db.withTenant(tenantId, (tx) => rows<{ id: string; user_id: string; email: string }>(tx, sql`
      select r.id, r.user_id, u.email from password_reset_request r join app_user u on u.id = r.user_id
       where r.token_hash = ${sha256Hex(b.token)} and r.used_at is null and r.expires_at > now() and u.status = 'ACTIVE'`));
    if (!r) throw invalid();
    const msg = passwordProblem(b.password, r.email);
    if (msg) throw weak(msg);
    const passwordHash = await AuthService.hashPassword(b.password);
    await this.db.withTenant(tenantId, async (tx) => {
      const [used] = await rows(tx, sql`update password_reset_request set used_at = now() where id = ${r.id} and used_at is null returning id`);
      if (!used) throw invalid();
      await tx.execute(sql`select set_config('app.user_id', ${r.user_id}, true)`);
      await tx.execute(sql`update user_credential set password_hash = ${passwordHash}, password_changed_at = now(), failed_attempts = 0, locked_until = null
                           where user_id = ${r.user_id}`);
      await tx.execute(sql`update password_reset_request set used_at = now() where user_id = ${r.user_id} and used_at is null`);
      const revoked = await this.sessions.revokeAllForUser(tx, r.user_id, 'PASSWORD_RESET');
      await audit(tx, 'PASSWORD_RESET', 'app_user', r.user_id, null, { sessionsRevoked: revoked });
    });
  }

  /** IAM-FR-010: pohon menu yang permission-nya dimiliki user di cabang aktif. Menu bukan kontrol akses (IAM-FR-011). */
  @Authenticated() @Get('me/menu')
  async menu(): Promise<MenuNode[]> {
    const perms = ctx().permissions ?? new Set<string>();
    const items = await this.db.withTenantTx((tx) => rows<{ code: string; parent_code: string | null; label: string; route: string | null; icon: string | null; required_permission: string | null }>(
      tx, sql`select code, parent_code, label, route, icon, required_permission from menu_item order by sort_order, code`));
    const visible = items.filter((i) => !i.required_permission || perms.has(i.required_permission));
    const node = (i: (typeof items)[number]): MenuNode => ({ code: i.code, label: i.label, ...(i.route ? { route: i.route } : {}), ...(i.icon ? { icon: i.icon } : {}),
      children: visible.filter((c) => c.parent_code === i.code).map(node) });
    // Grup tanpa rute hanya tampil bila punya anak yang terlihat
    return visible.filter((i) => !i.parent_code).map(node).filter((n) => n.route || n.children.length);
  }

  /** IAM-FR-009: pilih cabang aktif — hanya cabang aktif yang ditugaskan (atau semua bila penugasan tanpa cabang). */
  @Authenticated() @BodySchema(BranchBody) @Post('me/branch') @HttpCode(200)
  async selectBranch(@Body() b: z.infer<typeof BranchBody>) {
    const c = ctx();
    await this.db.withTenantTx(async (tx) => {
      const [ok] = await rows(tx, sql`
        select 1 from branch br
         where br.id = ${b.branchId} and br.is_active
           and exists(select 1 from user_role_assignment a where a.user_id = ${c.userId}
                        and (a.valid_to is null or a.valid_to > now()) and (a.branch_id is null or a.branch_id = br.id))`);
      if (!ok) throw problem(403, 'IAM-403-BRANCH', 'Anda tidak ditugaskan di cabang ini');
      await tx.execute(sql`update user_session set branch_id = ${b.branchId} where id = ${c.sessionId}`);
      await audit(tx, 'BRANCH_SELECTED', 'branch', b.branchId);
    });
    return { branchId: b.branchId };
  }

  /** IAM-FR-013: sesi aktif saya (perangkat, IP, waktu). */
  @Authenticated() @AllowWithoutMfa() @Get('me/sessions')
  async mySessions() {
    const c = ctx();
    const r = await this.db.withTenantTx((tx) => rows<{ id: string; user_agent: string | null; ip: string | null; created_at: Date; last_seen_at: Date }>(tx, sql`
      select id, user_agent, host(ip) as ip, created_at, last_seen_at from user_session
       where user_id = ${c.userId} and revoked_at is null and expires_at > now() order by last_seen_at desc`));
    return r.map((s) => ({ id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: new Date(s.created_at).toISOString(),
                           lastSeenAt: new Date(s.last_seen_at).toISOString(), current: s.id === c.sessionId }));
  }

  @Authenticated() @AllowWithoutMfa() @NoBody() @Delete('me/sessions/:sessionId') @HttpCode(204)
  async revokeMine(@Param('sessionId') id: string, @Res({ passthrough: true }) res: Response) {
    const c = ctx();
    if (!UUID.test(id)) throw problem(404, 'IAM-404-SESSION', 'Sesi tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const [s] = await rows(tx, sql`update user_session set revoked_at = now(), revoke_reason = 'USER_REVOKED'
                                     where id = ${id} and user_id = ${c.userId} and revoked_at is null returning id`);
      if (!s) throw problem(404, 'IAM-404-SESSION', 'Sesi tidak ditemukan');
      await audit(tx, 'SESSION_REVOKED', 'user_session', id, null, { self: id === c.sessionId });
    });
    if (id === c.sessionId) this.sessions.clearCookies(res);
  }
}

