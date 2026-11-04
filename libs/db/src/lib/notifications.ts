import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Pengirim notifikasi email dari outbox (ADR-0004, OD-076). Dipanggil worker (job `notify.outbox.dispatch`),
 * diuji langsung oleh suite integrasi dengan pengirim tiruan.
 * - Event hanya membawa ID; penerima & isi diambil saat kirim sebagai clinicrme_app + tenant context (RLS berlaku).
 * - Satu email per penerima (alamat penerima lain tidak terlihat).
 * - Gagal kirim → PENDING lagi sampai MAX_ATTEMPTS, lalu FAILED (alert di Stage 15).
 */
export interface Mail { to: string; subject: string; text: string }
export type SendMail = (m: Mail) => Promise<void>;
export interface NotifyOptions { clinicUrlTemplate: string; consoleName?: string }

export const NOTIFICATION_EVENTS = ['INVITATION_CREATED', 'PASSWORD_RESET_REQUESTED', 'SUPPORT_ACCESS_GRANTED', 'SUPPORT_ACCESS_REVOKED'] as const;
export const MAX_ATTEMPTS = 5;

interface Event { id: string; tenant_id: string; event_type: string; aggregate_id: string; attempts: number }

const fmt = (d: Date | string | null) => d ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(d)) + ' WIB' : '-';

/** Memproses hingga `limit` event notifikasi PENDING. Mengembalikan jumlah event per hasil. */
export async function dispatchNotifications(pool: Pool, send: SendMail, opts: NotifyOptions, limit = 20) {
  const c = await pool.connect();
  // noRecipient: event selesai tanpa satu pun penerima (mis. tenant tanpa admin aktif) — dilaporkan worker sebagai peringatan
  const result = { done: 0, retry: 0, failed: 0, noRecipient: 0 };
  try {
    const { rows: events } = await c.query<Event>(`
      update app.outbox_event set status = 'DISPATCHED', attempts = attempts + 1, dispatched_at = now()
       where id in (select id from app.outbox_event
                     where status = 'PENDING' and event_type = any($1::text[])
                     order by created_at for update skip locked limit $2)
      returning id, tenant_id, event_type, aggregate_id, attempts`, [NOTIFICATION_EVENTS, limit]);
    for (const e of events) {
      try {
        const mails = await asTenant(c, e.tenant_id, () => render(c, e, opts));
        for (const m of mails) await send(m);
        if (mails.length === 0) result.noRecipient++;
        await c.query(`update app.outbox_event set status = 'DONE' where id = $1`, [e.id]);
        result.done++;
      } catch {
        const final = e.attempts >= MAX_ATTEMPTS;
        await c.query(`update app.outbox_event set status = $2 where id = $1`, [e.id, final ? 'FAILED' : 'PENDING']);
        if (final) result.failed++; else result.retry++;
      }
    }
    return result;
  } finally {
    c.release();
  }
}

async function asTenant<T>(c: PoolClient, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('begin');
  try {
    await c.query('set local role clinicrme_app');
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true)`, [tenantId]);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  }
}

async function render(c: PoolClient, e: Event, opts: NotifyOptions): Promise<Mail[]> {
  const { rows: [t] } = await c.query<{ code: string; display_name: string }>(
    `select code, display_name from app.tenant where id = app.current_tenant_id()`);
  const url = opts.clinicUrlTemplate.replace('{code}', t.code);
  if (e.event_type === 'INVITATION_CREATED') {
    const { rows: [inv] } = await c.query<{ email: string; expires_at: Date; accepted_at: Date | null }>(
      `select email, expires_at, accepted_at from app.user_invitation where id = $1`, [e.aggregate_id]);
    if (!inv || inv.accepted_at || new Date(inv.expires_at) <= new Date()) return [];
    // Token tautan dibuat SAAT KIRIM; database hanya menyimpan hash-nya (token lama, bila ada, tidak berlaku lagi)
    const token = randomBytes(32).toString('base64url');
    await c.query(`update app.user_invitation set token_hash = $2, token_sent_at = now() where id = $1`, [e.aggregate_id, sha256(token)]);
    return [{
      to: inv.email,
      subject: `Undangan ClinicRME — ${t.display_name}`,
      text: [
        `Anda diundang memakai ClinicRME di ${t.display_name}.`, '',
        `Terima undangan: ${url}/invitation/${token}`,
        `Pilih "Masuk dengan Google" memakai alamat email ini (${inv.email}), atau buat password.`,
        `Undangan berlaku sampai ${fmt(inv.expires_at)}.`, '',
        'Bila Anda tidak merasa terkait dengan klinik ini, abaikan email ini.',
      ].join('\n'),
    }];
  }
  if (e.event_type === 'PASSWORD_RESET_REQUESTED') {
    const { rows: [r] } = await c.query<{ email: string; expires_at: Date; used_at: Date | null }>(
      `select u.email, r.expires_at, r.used_at from app.password_reset_request r join app.app_user u on u.id = r.user_id
        where r.id = $1 and u.status = 'ACTIVE'`, [e.aggregate_id]);
    if (!r || r.used_at || new Date(r.expires_at) <= new Date()) return [];
    const token = randomBytes(32).toString('base64url');
    await c.query(`update app.password_reset_request set token_hash = $2 where id = $1`, [e.aggregate_id, sha256(token)]);
    return [{
      to: r.email,
      subject: `Reset password ClinicRME — ${t.display_name}`,
      text: [
        `Ada permintaan reset password untuk akun ${r.email} di ${t.display_name}.`, '',
        `Buat password baru: ${url}/reset-password/${token}`,
        `Tautan sekali pakai, berlaku sampai ${fmt(r.expires_at)}.`, '',
        'Bila Anda tidak meminta reset, abaikan email ini — password Anda tidak berubah.',
      ].join('\n'),
    }];
  }
  // Break-glass: kabari SEMUA tenant admin aktif (OD-076)
  const { rows: [g] } = await c.query<{ reason: string; starts_at: Date; expires_at: Date; revoked_at: Date | null; support_name: string }>(
    `select * from app.support_grant_for_notification($1)`, [e.aggregate_id]);
  if (!g) return [];
  const { rows: admins } = await c.query<{ email: string }>(`
    select distinct u.email from app.app_user u
      join app.user_role_assignment a on a.user_id = u.id and (a.valid_to is null or a.valid_to > now())
      join app.role r on r.id = a.role_id and r.code = 'TENANT_ADMIN'
     where u.status = 'ACTIVE' order by u.email`);
  const granted = e.event_type === 'SUPPORT_ACCESS_GRANTED';
  const subject = granted ? `[ClinicRME] Akses dukungan dibuka untuk ${t.display_name}` : `[ClinicRME] Akses dukungan ditutup untuk ${t.display_name}`;
  const text = granted ? [
    `Staf dukungan ClinicRME (${g.support_name}) mendapat akses sementara ke ${t.display_name}.`, '',
    `Alasan: ${g.reason}`,
    `Berlaku: ${fmt(g.starts_at)} s.d. ${fmt(g.expires_at)}`,
    'Cakupan: hanya MEMBACA daftar pengguna/role dan log audit. Data pasien & rekam medis TIDAK dapat dibuka.',
    'Setiap akses tercatat di log audit klinik Anda.', '',
    `Bila tidak sesuai permintaan klinik, hubungi ClinicRME segera. Log audit: ${url}`,
  ] : [
    `Akses dukungan ClinicRME (${g.support_name}) untuk ${t.display_name} telah ditutup pada ${fmt(g.revoked_at)}.`,
    `Alasan awal: ${g.reason}`, '', `Riwayat akses tercatat di log audit klinik: ${url}`,
  ];
  return admins.map((a) => ({ to: a.email, subject, text: text.join('\n') }));
}
