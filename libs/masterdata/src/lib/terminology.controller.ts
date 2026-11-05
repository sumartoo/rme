import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Authenticated, BodySchema, NoBody, RequirePermission, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, rows } from '@clinicrme/db';
import { assertId, auditChange } from './common';

const SYSTEMS = ['ICD10', 'ICD9CM'] as const;
const SearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  system: z.enum(SYSTEMS).default('ICD10'),
  /** `all` = semua favorit klinik; `validated` = hanya yang sudah divalidasi (untuk pilihan klinis, OD-084). */
  favorites: z.enum(['all', 'validated']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const FavoriteBody = z.object({
  specialty: z.string().trim().max(100).nullable().optional(),
  validated: z.boolean().optional(),
}).strict();
const RegionQuery = z.object({
  parent: z.string().regex(/^\d{2}(\.\d{2}(\.\d{2})?)?$/).optional(),
  q: z.string().trim().max(100).optional(),
});

interface ConceptRow { id: string; system: string; code: string; display_id: string; display_en: string | null; synonyms: string[];
  fav: boolean; specialty: string | null; validated_at: Date | null; validated_by_name: string | null }
const dto = (r: ConceptRow) => ({ id: r.id, system: r.system, code: r.code, display: r.display_id, displayEn: r.display_en, synonyms: r.synonyms,
  isFavorite: r.fav, favorite: r.fav ? { specialty: r.specialty, validated: !!r.validated_at,
    validatedAt: r.validated_at ? new Date(r.validated_at).toISOString() : null, validatedBy: r.validated_by_name } : null });
const VALIDATOR_TYPES = ['DOKTER', 'DOKTER_GIGI', 'DOKTER_SPESIALIS'];

/**
 * Terminologi (TRM-FR-001–004): pencarian ICD-10 / ICD-9-CM versi berlaku (kode asli, tidak diubah) berdasarkan
 * kode, kata kunci, atau sinonim; favorit per klinik yang wajib divalidasi tenaga medis (TRM-FR-003, OD-084) —
 * validator = user yang tertaut ke dokter/dokter gigi/spesialis dengan SIP masih berlaku. Wilayah (MST-FR-011).
 */
@Controller('api/v1')
export class TerminologyController {
  constructor(private readonly db: Db) {}

  @Authenticated() @Get('terminology/concepts')
  async search(@Query() query: Record<string, unknown>) {
    const p = SearchQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const { q, system, favorites, limit } = p.data;
    const term = q ?? '';
    const codeLike = `${term.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const r = await this.db.withTenantTx((tx) => rows<ConceptRow>(tx, sql`
      select c.id, s.code as system, c.code, c.display_id, c.display_en, c.synonyms,
             (f.concept_id is not null) as fav, f.specialty, f.validated_at, u.full_name as validated_by_name
        from concept c
        join code_system s on s.id = c.system_id and s.is_current and s.code = ${system}
        left join tenant_concept_favorite f on f.concept_id = c.id
        left join app_user u on u.id = f.validated_by
       where c.is_active
         and (${favorites ?? null}::text is null or (f.concept_id is not null and (${favorites ?? null} = 'all' or f.validated_at is not null)))
         and (${term} = '' or c.code ilike ${codeLike} or c.display_id ilike ${like} or c.display_en ilike ${like}
              or exists(select 1 from unnest(c.synonyms) syn where syn ilike ${like}))
       order by (upper(c.code) = upper(${term})) desc, (c.code ilike ${codeLike}) desc, (f.concept_id is not null) desc,
                similarity(c.display_id, ${term}) desc, c.code
       limit ${limit}`));
    return r.map(dto);
  }

  @Authenticated() @Get('terminology/code-systems')
  async codeSystems() {
    return this.db.withTenantTx((tx) => rows(tx, sql`
      select s.code, s.version, s.source, to_char(s.effective_date, 'YYYY-MM-DD') as "effectiveDate", s.is_current as "isCurrent",
             (select count(*)::int from concept c where c.system_id = s.id and c.is_active) as "conceptCount",
             (s.source ilike 'CONTOH%') as "isSample"
        from code_system s order by s.code, s.is_current desc, s.version desc`));
  }

  /** Tandai favorit (atau ubah spesialisasi). `validated: true` hanya oleh validator OD-084; perubahan lain menghapus validasi. */
  @RequirePermission('terminology.favorite.manage') @BodySchema(FavoriteBody) @Put('terminology/favorites/:conceptId') @HttpCode(204)
  async favorite(@Param('conceptId') conceptId: string, @Body() b: z.infer<typeof FavoriteBody>) {
    assertId(conceptId, 'TRM-404-CONCEPT', 'Kode tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const [c] = await rows<{ code: string; system: string }>(tx, sql`
        select c.code, s.code as system from concept c join code_system s on s.id = c.system_id where c.id = ${conceptId} and c.is_active and s.is_current`);
      if (!c) throw problem(404, 'TRM-404-CONCEPT', 'Kode tidak ditemukan');
      if (b.validated) await this.assertValidator(tx);
      const [cur] = await rows<{ specialty: string | null; validated_by: string | null; validated_at: Date | null }>(tx, sql`
        select specialty, validated_by, validated_at from tenant_concept_favorite where concept_id = ${conceptId} for update`);
      const specialty = b.specialty === undefined ? cur?.specialty ?? null : b.specialty || null;
      const uid = ctx().userId!;
      // Validasi berlaku untuk isi favorit saat itu: ubah spesialisasi tanpa validasi ulang → kembali belum divalidasi
      const keep = b.validated === undefined && cur?.validated_at != null && specialty === (cur?.specialty ?? null);
      const by = b.validated === true ? uid : keep ? cur!.validated_by : null;
      const at = b.validated === true ? new Date() : keep ? cur!.validated_at : null;
      const validated = by !== null;
      await tx.execute(sql`
        insert into tenant_concept_favorite(tenant_id, concept_id, specialty, validated_by, validated_at, created_by)
        values (app.current_tenant_id(), ${conceptId}, ${specialty}, ${by}::uuid, ${at ? new Date(at).toISOString() : null}::timestamptz, ${uid})
        on conflict (tenant_id, concept_id) do update
          set specialty = excluded.specialty, validated_by = excluded.validated_by, validated_at = excluded.validated_at`);
      await auditChange(tx, cur ? 'TERMINOLOGY_FAVORITE_UPDATED' : 'TERMINOLOGY_FAVORITE_ADDED', 'concept', conceptId,
        cur ? { code: `${c.system}:${c.code}`, specialty: cur.specialty, validated: cur.validated_at != null } : null,
        { code: `${c.system}:${c.code}`, specialty, validated });
    });
  }

  @RequirePermission('terminology.favorite.manage') @NoBody() @Delete('terminology/favorites/:conceptId') @HttpCode(204)
  async unfavorite(@Param('conceptId') conceptId: string) {
    assertId(conceptId, 'TRM-404-CONCEPT', 'Favorit tidak ditemukan');
    await this.db.withTenantTx(async (tx) => {
      const [old] = await rows<{ specialty: string | null; validated_at: Date | null; code: string; system: string }>(tx, sql`
        delete from tenant_concept_favorite f using concept c join code_system s on s.id = c.system_id
         where f.concept_id = ${conceptId} and c.id = f.concept_id
        returning f.specialty, f.validated_at, c.code, s.code as system`);
      if (!old) throw problem(404, 'TRM-404-CONCEPT', 'Favorit tidak ditemukan');
      await auditChange(tx, 'TERMINOLOGY_FAVORITE_REMOVED', 'concept', conceptId,
        { code: `${old.system}:${old.code}`, specialty: old.specialty, validated: old.validated_at != null }, { code: `${old.system}:${old.code}`, specialty: null, validated: false });
    });
  }

  /** OD-084: hanya dokter/dokter gigi/spesialis (akun tertaut tenaga kesehatan aktif) dengan SIP berlaku. */
  private async assertValidator(tx: Tx) {
    const [p] = await rows<{ practitioner_type: string; sip_valid_until: string | null; is_active: boolean }>(tx, sql`
      select p.practitioner_type, to_char(p.sip_valid_until, 'YYYY-MM-DD') as sip_valid_until, p.is_active
        from app_user u join practitioner p on p.id = u.practitioner_id where u.id = ${ctx().userId}`);
    if (!p || !p.is_active || !VALIDATOR_TYPES.includes(p.practitioner_type)) {
      throw problem(403, 'TRM-403-VALIDATOR', 'Validasi favorit hanya oleh dokter yang akunnya tertaut ke data tenaga kesehatan');
    }
    const [{ ok }] = await rows<{ ok: boolean }>(tx, sql`select (${p.sip_valid_until}::date >= (now() at time zone 'Asia/Jakarta')::date) is true as ok`);
    if (!ok) throw problem(403, 'TRM-403-SIP', 'SIP dokter belum diisi atau sudah tidak berlaku');
  }

  // ------------------------------------------------------------------------------------------ wilayah
  /** Wilayah berjenjang (MST-FR-011): tanpa `parent` = provinsi; `parent` = anak langsung kode itu. */
  @Authenticated() @Get('regions')
  async regions(@Query() query: Record<string, unknown>) {
    const p = RegionQuery.safeParse(query);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const like = p.data.q ? `%${p.data.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return this.db.withTenantTx((tx) => rows(tx, sql`
      select code, name, level from region
       where parent_code is not distinct from ${p.data.parent ?? null}::text and (${like}::text is null or name ilike ${like})
       order by code limit 500`));
  }
}
