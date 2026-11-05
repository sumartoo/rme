import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { type AppConfig, BodySchema, CONFIG, RequirePermission, blindIndex, ctx, decrypt, encrypt, problem } from '@clinicrme/shared';
import { Db, type Tx, rows } from '@clinicrme/db';
import { Name, assertId, assertVersion, auditChange, ifMatchVersion, merge, optDate, optText } from './common';

export const PRACTITIONER_TYPES = ['DOKTER', 'DOKTER_GIGI', 'DOKTER_SPESIALIS', 'PERAWAT', 'BIDAN', 'APOTEKER', 'TTK', 'ANALIS', 'LAINNYA'] as const;
/** NIK 16 digit; dua digit pertama kode provinsi (11–96). Validasi struktur saja, bukan keabsahan kependudukan. */
const Nik = z.string().trim().regex(/^(1[1-9]|[2-9]\d)\d{14}$/, 'NIK harus 16 digit angka');
const Body_ = z.object({
  fullName: Name,
  nik: Nik.nullable().optional(),
  practitionerType: z.enum(PRACTITIONER_TYPES),
  specialty: optText(100),
  strNumber: optText(50),
  strValidUntil: optDate,
  sipNumber: optText(50),
  sipValidUntil: optDate,
  satusehatIhsId: optText(50),
  isActive: z.boolean().optional(),
}).strict();
export const PractitionerBody = Body_;
export const PractitionerPatch = Body_.partial().strict();
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(PRACTITIONER_TYPES).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
  unlinked: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});

interface Row { id: string; full_name: string; nik_encrypted: Buffer | null; practitioner_type: string; specialty: string | null;
  str_number: string | null; str_valid_until: string | null; sip_number: string | null; sip_valid_until: string | null;
  satusehat_ihs_id: string | null; is_active: boolean; version: number; linked_user_id: string | null }
const SELECT = sql`select p.id, p.full_name, p.nik_encrypted, p.practitioner_type, p.specialty, p.str_number,
                          to_char(p.str_valid_until, 'YYYY-MM-DD') as str_valid_until, p.sip_number,
                          to_char(p.sip_valid_until, 'YYYY-MM-DD') as sip_valid_until, p.satusehat_ihs_id, p.is_active, p.version,
                          (select u.id from app_user u where u.practitioner_id = p.id limit 1) as linked_user_id
                     from practitioner p`;

/** NIK tidak pernah dikembalikan utuh: 4 digit awal + 4 digit akhir. */
const maskNik = (nik: string | null) => (nik ? `${nik.slice(0, 4)}********${nik.slice(-4)}` : null);

/**
 * Tenaga kesehatan (MST-FR-002): nama, NIK, jenis, spesialisasi, STR/SIP & masa berlaku. NIK disimpan terenkripsi
 * (AES-256-GCM) + indeks buta HMAC untuk keunikan; tidak masuk audit maupun respons. Tidak dihapus — dinonaktifkan,
 * karena dirujuk rekam medis & tanda tangan klinis (IAM-FR-016, Stage 9).
 */
@Controller('api/v1/practitioners')
export class PractitionersController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  private nikHash(nik: string) { return blindIndex(this.cfg.encryptionKeyHex, 'practitioner-nik', nik); }

  private dto(r: Row) {
    const nik = r.nik_encrypted ? decrypt(this.cfg.encryptionKeyHex, r.nik_encrypted) : null;
    return { id: r.id, fullName: r.full_name, nikMasked: maskNik(nik), practitionerType: r.practitioner_type, specialty: r.specialty,
      strNumber: r.str_number, strValidUntil: r.str_valid_until, sipNumber: r.sip_number, sipValidUntil: r.sip_valid_until,
      satusehatIhsId: r.satusehat_ihs_id, isActive: r.is_active, linkedUserId: r.linked_user_id, version: r.version };
  }

  /** Nilai yang diaudit: NIK hanya sebagai penanda ada/berubah (hash), tidak pernah nilai aslinya. */
  private auditView(d: ReturnType<PractitionersController['dto']>, nikHash: string | null) {
    return { fullName: d.fullName, practitionerType: d.practitionerType, specialty: d.specialty, strNumber: d.strNumber,
      strValidUntil: d.strValidUntil, sipNumber: d.sipNumber, sipValidUntil: d.sipValidUntil, satusehatIhsId: d.satusehatIhsId,
      isActive: d.isActive, nik: nikHash };
  }

  private async assertNikFree(tx: Tx, hash: string, exceptId: string | null) {
    const [dup] = await rows(tx, sql`select 1 from practitioner where nik_hash = ${hash} and id is distinct from ${exceptId}::uuid`);
    if (dup) throw problem(409, 'MST-409-NIK', 'NIK ini sudah terdaftar untuk tenaga kesehatan lain');
  }

  @RequirePermission('master.practitioner.read') @Get()
  async list(@Query() query: Record<string, unknown>) {
    const p = ListQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { q, type, includeInactive, unlinked, limit, cursor } = p.data;
    const offset = Number(cursor ?? 0);
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const r = await this.db.withTenantTx((tx) => rows<Row>(tx, sql`${SELECT}
      where (${includeInactive === 'true'}::boolean or p.is_active)
        and (${like}::text is null or p.full_name ilike ${like} or p.sip_number ilike ${like} or p.str_number ilike ${like})
        and (${type ?? null}::text is null or p.practitioner_type = ${type ?? null})
        and (not ${unlinked === 'true'}::boolean or not exists(select 1 from app_user u where u.practitioner_id = p.id))
      order by lower(p.full_name), p.id limit ${limit + 1} offset ${offset}`));
    const data = r.slice(0, limit).map((x) => this.dto(x));
    return { data, page: { hasMore: r.length > limit, nextCursor: r.length > limit ? String(offset + limit) : null } };
  }

  @RequirePermission('master.practitioner.read') @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan');
    const [r] = await this.db.withTenantTx((tx) => rows<Row>(tx, sql`${SELECT} where p.id = ${id}`));
    if (!r) throw problem(404, 'MST-404-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan');
    res.setHeader('ETag', `"${r.version}"`);
    return this.dto(r);
  }

  @RequirePermission('master.practitioner.manage') @BodySchema(PractitionerBody) @Post() @HttpCode(201)
  async create(@Body() b: z.infer<typeof PractitionerBody>) {
    return this.db.withTenantTx(async (tx) => {
      const hash = b.nik ? this.nikHash(b.nik) : null;
      if (hash) await this.assertNikFree(tx, hash, null);
      const [{ id }] = await rows<{ id: string }>(tx, sql`
        insert into practitioner(tenant_id, full_name, nik_encrypted, nik_hash, practitioner_type, specialty, str_number, str_valid_until,
                                 sip_number, sip_valid_until, satusehat_ihs_id, is_active, updated_by)
        values (app.current_tenant_id(), ${b.fullName}, ${b.nik ? encrypt(this.cfg.encryptionKeyHex, b.nik) : null}, ${hash},
                ${b.practitionerType}, ${b.specialty ?? null}, ${b.strNumber ?? null}, ${b.strValidUntil ?? null}::date,
                ${b.sipNumber ?? null}, ${b.sipValidUntil ?? null}::date, ${b.satusehatIhsId ?? null}, ${b.isActive ?? true}, ${ctx().userId})
        returning id`);
      const [r] = await rows<Row>(tx, sql`${SELECT} where p.id = ${id}`);
      const d = this.dto(r);
      await auditChange(tx, 'PRACTITIONER_CREATED', 'practitioner', id, null, this.auditView(d, hash), ['nik']);
      return d;
    });
  }

  /** Ubah sebagian (field yang dikirim saja). `nik: null` menghapus NIK; tidak dikirim = tetap. */
  @RequirePermission('master.practitioner.manage') @BodySchema(PractitionerPatch) @Put(':id')
  async update(@Param('id') id: string, @Body() b: z.infer<typeof PractitionerPatch>,
               @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    assertId(id, 'MST-404-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan');
    const v = ifMatchVersion(ifMatch, 'tenaga kesehatan');
    const out = await this.db.withTenantTx(async (tx) => {
      const [lock] = await rows<{ nik_hash: string | null }>(tx, sql`select nik_hash from practitioner where id = ${id} for update`);
      const [row] = lock ? await rows<Row>(tx, sql`${SELECT} where p.id = ${id}`) : [];
      const cur = row ? { ...row, nik_hash: lock.nik_hash } : undefined;
      if (!cur) throw problem(404, 'MST-404-PRACTITIONER', 'Tenaga kesehatan tidak ditemukan');
      assertVersion(cur.version, v, 'Data tenaga kesehatan');
      const before = this.dto(cur);
      const { nik, ...fields } = b;
      const n = merge(before, fields);
      const hash = nik === undefined ? cur.nik_hash : nik === null ? null : this.nikHash(nik);
      if (hash && hash !== cur.nik_hash) await this.assertNikFree(tx, hash, id);
      const nikEnc = nik === undefined ? cur.nik_encrypted : nik === null ? null : encrypt(this.cfg.encryptionKeyHex, nik);
      // Nonaktif → tidak lagi dapat dipilih untuk tanda tangan; tautan akun tetap (dilepas manual di halaman pengguna)
      await tx.execute(sql`
        update practitioner set full_name = ${n.fullName}, nik_encrypted = ${nikEnc}, nik_hash = ${hash},
               practitioner_type = ${n.practitionerType}, specialty = ${n.specialty}, str_number = ${n.strNumber},
               str_valid_until = ${n.strValidUntil}::date, sip_number = ${n.sipNumber}, sip_valid_until = ${n.sipValidUntil}::date,
               satusehat_ihs_id = ${n.satusehatIhsId}, is_active = ${n.isActive}, updated_by = ${ctx().userId}
         where id = ${id}`);
      const [r] = await rows<Row>(tx, sql`${SELECT} where p.id = ${id}`);
      const after = this.dto(r);
      await auditChange(tx, 'PRACTITIONER_UPDATED', 'practitioner', id, this.auditView(before, cur.nik_hash), this.auditView(after, hash), ['nik']);
      return after;
    });
    res.setHeader('ETag', `"${out.version}"`);
    return out;
  }
}
