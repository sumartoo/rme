import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { BodySchema, NoBody, Public, RequirePermission, Uuid, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { QueueEvents } from './queue-events';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_MS = 20_000;
const RECHECK_MS = 60_000;

/** "Siti Rahmawati" → "S. R." — hanya bila klinik mengaktifkan `queueDisplayInitials` (OD-088). */
const initials = (name: string) => name.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).slice(0, 3).map((w) => `${w.replace(/[^A-Za-z]/g, '')[0]?.toUpperCase()}.`).join(' ');

/**
 * Data layar antrean satu cabang hari ini (hari lokal cabang): per poli nomor yang sedang dipanggil, jumlah menunggu,
 * dan beberapa nomor berikutnya; plus riwayat panggilan terakhir. Tidak pernah memuat nama, MRN, atau data pasien
 * lain — paling jauh inisial bila klinik memilihnya (OD-088).
 */
export async function buildBoard(tx: Tx, branchId: string) {
  const [b] = await rows<{ name: string; initials: boolean }>(tx, sql`
    select b.name, coalesce((t.settings->>'queueDisplayInitials')::boolean, false) as initials
      from branch b join tenant t on t.id = b.tenant_id where b.id = ${branchId}`);
  if (!b) throw problem(404, 'QUE-404-DISPLAY', 'Layar antrean tidak ditemukan');
  const units = await rows<{ id: string; name: string }>(tx, sql`
    select id, name from service_unit where branch_id = ${branchId} and is_active and unit_type not in ('FARMASI', 'KASIR') order by name`);
  const tickets = await rows<{ unit_id: string; display_code: string; status: string; called_at: string | null; call_count: number;
                                practitioner_name: string | null; patient_name: string | null }>(tx, sql`
    select q.unit_id, q.display_code, q.status, q.called_at, q.call_count, pr.full_name as practitioner_name,
           ${b.initials ? sql`p.full_name` : sql`null::text`} as patient_name
      from queue_ticket q
      join branch br on br.id = q.branch_id
      join encounter e on e.id = q.encounter_id
      join patient p on p.id = e.patient_id
      left join practitioner pr on pr.id = q.practitioner_id
     where q.branch_id = ${branchId} and q.queue_date = (now() at time zone br.timezone)::date and q.status in ('WAITING', 'CALLED')
     order by q.sort_key, q.queue_number`);
  const recent = await rows<{ display_code: string; unit_name: string; called_at: string }>(tx, sql`
    select q.display_code, u.name as unit_name, q.called_at
      from queue_ticket q join branch br on br.id = q.branch_id join service_unit u on u.id = q.unit_id
     where q.branch_id = ${branchId} and q.queue_date = (now() at time zone br.timezone)::date and q.called_at is not null
       and q.status <> 'CANCELLED'
     order by q.called_at desc limit 8`);
  return {
    branch: { id: branchId, name: b.name }, generatedAt: new Date().toISOString(),
    units: units.map((u) => {
      const mine = tickets.filter((t) => t.unit_id === u.id);
      return {
        unitId: u.id, unitName: u.name,
        calling: mine.filter((t) => t.status === 'CALLED').sort((x, y) => String(y.called_at).localeCompare(String(x.called_at))).slice(0, 2)
          .map((t) => ({ displayCode: t.display_code, practitionerName: t.practitioner_name, calledAt: t.called_at, callCount: t.call_count,
            ...(t.patient_name ? { initials: initials(t.patient_name) } : {}) })),
        waiting: mine.filter((t) => t.status === 'WAITING').length,
        next: mine.filter((t) => t.status === 'WAITING').slice(0, 5).map((t) => t.display_code),
      };
    }),
    recentlyCalled: recent.map((r) => ({ displayCode: r.display_code, unitName: r.unit_name, calledAt: r.called_at })),
  };
}

interface LinkRow { id: string; branch_id: string; branch_name: string; label: string; created_at: string; revoked_at: string | null; last_seen_at: string | null }
const linkDto = (r: LinkRow) => ({ id: r.id, branchId: r.branch_id, branchName: r.branch_name, label: r.label, createdAt: r.created_at,
  revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at });
const LINK_SELECT = sql`select l.id, l.branch_id, b.name as branch_name, l.label, l.created_at, l.revoked_at, l.last_seen_at
  from queue_display_link l join branch b on b.id = l.branch_id`;

/** Admin klinik mengelola tautan layar TV (OD-088). Token hanya ditampilkan sekali saat dibuat. */
@Controller('api/v1/queue-displays')
export class QueueDisplaysController {
  constructor(private readonly db: Db) {}

  @RequirePermission('tenant.profile.manage') @Get()
  async list() {
    return (await this.db.withTenantTx((tx) => rows<LinkRow>(tx, sql`${LINK_SELECT} order by l.revoked_at nulls first, l.created_at desc`))).map(linkDto);
  }

  @RequirePermission('tenant.profile.manage')
  @BodySchema(z.object({ branchId: Uuid, label: z.string().trim().min(2).max(100) }).strict()) @Post() @HttpCode(201)
  async create(@Body() b: { branchId: string; label: string }) {
    const token = randomBytes(32).toString('base64url');
    return this.db.withTenantTx(async (tx) => {
      const [br] = await rows<{ is_active: boolean }>(tx, sql`select is_active from branch where id = ${b.branchId}`);
      if (!br?.is_active) throw problem(400, 'QUE-400-BRANCH', 'Cabang tidak ditemukan atau tidak aktif');
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into queue_display_link(tenant_id, branch_id, label, token_hash, created_by)
        values (app.current_tenant_id(), ${b.branchId}, ${b.label}, ${sha256(token)}, ${ctx().userId}) returning id`);
      await audit(tx, 'QUEUE_DISPLAY_CREATED', 'queue_display_link', id, null, { branchId: b.branchId, label: b.label });
      const [r] = await rows<LinkRow>(tx, sql`${LINK_SELECT} where l.id = ${id}`);
      return { ...linkDto(r), token, path: `/display/${token}` };
    });
  }

  @RequirePermission('tenant.profile.manage') @NoBody() @Post(':id/revoke') @HttpCode(200)
  async revoke(@Param('id') id: string) {
    assertId(id, 'QUE-404-DISPLAY', 'Layar antrean tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [r] = await rows<{ id: string }>(tx, sql`
        update queue_display_link set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, ${ctx().userId}::uuid)
         where id = ${id} returning id`);
      if (!r) throw problem(404, 'QUE-404-DISPLAY', 'Layar antrean tidak ditemukan');
      await audit(tx, 'QUEUE_DISPLAY_REVOKED', 'queue_display_link', id, null, null);
      const [l] = await rows<LinkRow>(tx, sql`${LINK_SELECT} where l.id = ${id}`);
      return linkDto(l);
    });
  }
}

/**
 * Layar TV (OD-088/089): tanpa login, diakses dengan token pada subdomain klinik. `GET` = data sekali ambil;
 * `GET …/stream` = Server-Sent Events — data dikirim saat terhubung, lalu setiap ada NOTIFY antrean cabang itu,
 * dengan heartbeat 20 detik. Token yang dicabut memutus stream paling lama 60 detik kemudian.
 */
@Controller('api/v1/public/queue-display')
export class PublicQueueDisplayController {
  constructor(private readonly db: Db, private readonly events: QueueEvents) {}

  private async resolve(token: string) {
    const tenantId = ctx().hostTenantId;
    if (!tenantId || !TOKEN_RE.test(token)) throw problem(404, 'QUE-404-DISPLAY', 'Layar antrean tidak ditemukan');
    const [l] = await this.db.withTenant(tenantId, (tx) => rows<{ id: string; branch_id: string }>(tx, sql`
      update queue_display_link set last_seen_at = now()
       where token_hash = ${sha256(token)} and revoked_at is null
      returning id, branch_id`));
    if (!l) throw problem(404, 'QUE-404-DISPLAY', 'Layar antrean tidak ditemukan atau sudah dicabut');
    return { tenantId, branchId: l.branch_id };
  }

  @Public() @Get(':token')
  async board(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const { tenantId, branchId } = await this.resolve(token);
    res.setHeader('Cache-Control', 'no-store');
    return this.db.withTenant(tenantId, (tx) => buildBoard(tx, branchId));
  }

  @Public() @Get(':token/stream')
  async stream(@Param('token') token: string, @Query() _q: unknown, @Req() req: Request, @Res() res: Response) {
    const { tenantId, branchId } = await this.resolve(token);
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let closed = false, sending = false, again = false;
    let debounce: NodeJS.Timeout | undefined;
    const send = async () => {
      if (closed) return;
      if (sending) { again = true; return; }
      sending = true;
      try {
        const b = await this.db.withTenant(tenantId, (tx) => buildBoard(tx, branchId));
        if (!closed) res.write(`event: board\ndata: ${JSON.stringify(b)}\n\n`);
      } catch { close(); } finally {
        sending = false;
        if (again) { again = false; void send(); }
      }
    };
    const unsubscribe = await this.events.subscribe(`${tenantId}:${branchId}`, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void send(), 200);
    });
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, HEARTBEAT_MS);
    const recheck = setInterval(() => {
      void this.db.withTenant(tenantId, (tx) => rows(tx, sql`select 1 from queue_display_link where token_hash = ${sha256(token)} and revoked_at is null`))
        .then((r) => { if (r.length === 0) { res.write('event: revoked\ndata: {}\n\n'); close(); } }).catch(() => undefined);
    }, RECHECK_MS);
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(ping); clearInterval(recheck); clearTimeout(debounce);
      unsubscribe();
      res.end();
    }
    req.on('close', close);
    await send();
  }
}
