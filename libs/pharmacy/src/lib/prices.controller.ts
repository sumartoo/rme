import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodySchema, IsoDate, RequirePermission, Uuid, assertId, ctx, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';

const Money = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'Nominal tidak valid'));
export const PriceBody = z.object({
  branchId: Uuid.nullable().optional(), payerType: z.enum(['UMUM', 'ASURANSI', 'PERUSAHAAN', 'BPJS']).nullable().optional(),
  hna: Money.nullable().optional(), het: Money.nullable().optional(), sellPrice: Money, validFrom: IsoDate, validTo: IsoDate.nullable().optional(),
}).strict();
const EndBody = z.object({ validTo: IsoDate }).strict();
interface Row { id: string; branch_id: string | null; branch_name: string | null; payer_type: string | null; hna: string | null; het: string | null;
  sell_price: string; valid_from: string; valid_to: string | null; created_at: string }
const dto = (r: Row) => ({ id: r.id, branchId: r.branch_id, branchName: r.branch_name, payerType: r.payer_type, hna: r.hna, het: r.het,
  sellPrice: r.sell_price, validFrom: r.valid_from, validTo: r.valid_to, createdAt: r.created_at });
const SEL = sql`select p.id, p.branch_id, b.name as branch_name, p.payer_type, p.hna::text, p.het::text, p.sell_price::text,
                       to_char(p.valid_from, 'YYYY-MM-DD') as valid_from, to_char(p.valid_to, 'YYYY-MM-DD') as valid_to, p.created_at
                  from drug_price p left join branch b on b.id = p.branch_id`;

async function drugExists(tx: Tx, id: string) {
  const [d] = await rows(tx, sql`select 1 from drug_item where id = ${id}`);
  if (!d) throw problem(404, 'MST-404-DRUG', 'Obat tidak ditemukan');
}
/** Pelanggaran exclusion constraint (periode tumpang tindih untuk cabang & penjamin yang sama). */
const overlap = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.code === '23P01' || (e as { cause?: { code?: string } })?.cause?.code === '23P01';

/**
 * Harga jual obat per penjamin/cabang dengan periode berlaku (PHM-FR-002). Riwayat harga tidak dihapus: harga lama
 * ditutup dengan mengisi tanggal akhir, lalu harga baru ditambahkan. Harga jual tidak boleh melebihi HET bila diisi.
 */
@Controller('api/v1')
export class PricesController {
  constructor(private readonly db: Db) {}

  @RequirePermission('pharmacy.drug.read') @Get('drugs/:id/prices')
  async list(@Param('id') id: string) {
    assertId(id, 'MST-404-DRUG', 'Obat tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      await drugExists(tx, id);
      return (await rows<Row>(tx, sql`${SEL} where p.drug_item_id = ${id} order by p.valid_from desc, b.name nulls first, p.payer_type nulls first`)).map(dto);
    });
  }

  @RequirePermission('pharmacy.drug.manage') @BodySchema(PriceBody) @Post('drugs/:id/prices') @HttpCode(201)
  async create(@Param('id') id: string, @Body() b: z.infer<typeof PriceBody>) {
    assertId(id, 'MST-404-DRUG', 'Obat tidak ditemukan');
    if (b.validTo && b.validTo < b.validFrom) throw problem(400, 'PHM-400-PERIOD', 'Tanggal akhir sebelum tanggal mulai');
    if (b.het && Number(b.sellPrice) > Number(b.het)) throw problem(400, 'PHM-400-HET', 'Harga jual melebihi HET');
    try {
      return await this.db.withTenantTx(async (tx) => {
        await drugExists(tx, id);
        if (b.branchId) {
          const [br] = await rows(tx, sql`select 1 from branch where id = ${b.branchId}`);
          if (!br) throw problem(400, 'MST-400-BRANCH', 'Cabang tidak ditemukan');
        }
        const [{ id: pid }] = await rows<{ id: string }>(tx, sql`
          insert into drug_price(tenant_id, drug_item_id, branch_id, payer_type, hna, het, sell_price, valid_from, valid_to, created_by)
          values (app.current_tenant_id(), ${id}, ${b.branchId ?? null}, ${b.payerType ?? null}, ${b.hna ?? null}::numeric, ${b.het ?? null}::numeric,
                  ${b.sellPrice}::numeric, ${b.validFrom}::date, ${b.validTo ?? null}::date, ${ctx().userId}) returning id`);
        const [r] = await rows<Row>(tx, sql`${SEL} where p.id = ${pid}`);
        await audit(tx, 'DRUG_PRICE_CREATED', 'drug_price', pid, null, { drugItemId: id, ...dto(r) });
        return dto(r);
      });
    } catch (e) {
      if (overlap(e)) throw problem(409, 'PHM-409-PRICE-OVERLAP', 'Periode harga tumpang tindih dengan harga lain untuk cabang & penjamin yang sama. Tutup harga lama lebih dulu.');
      throw e;
    }
  }

  /** Menutup periode harga (hanya memajukan tanggal akhir lebih awal / mengisi yang kosong). */
  @RequirePermission('pharmacy.drug.manage') @BodySchema(EndBody) @Post('drugs/:id/prices/:priceId/end') @HttpCode(200)
  async end(@Param('id') id: string, @Param('priceId') priceId: string, @Body() b: z.infer<typeof EndBody>) {
    assertId(id, 'MST-404-DRUG', 'Obat tidak ditemukan');
    assertId(priceId, 'PHM-404-PRICE', 'Harga tidak ditemukan');
    return this.db.withTenantTx(async (tx) => {
      const [cur] = await rows<Row>(tx, sql`${SEL} where p.id = ${priceId} and p.drug_item_id = ${id} for update of p`);
      if (!cur) throw problem(404, 'PHM-404-PRICE', 'Harga tidak ditemukan');
      if (b.validTo < cur.valid_from) throw problem(400, 'PHM-400-PERIOD', 'Tanggal akhir sebelum tanggal mulai');
      if (cur.valid_to && b.validTo > cur.valid_to) throw problem(400, 'PHM-400-PERIOD', 'Periode hanya dapat dipersingkat');
      await tx.execute(sql`update drug_price set valid_to = ${b.validTo}::date where id = ${priceId}`);
      const [r] = await rows<Row>(tx, sql`${SEL} where p.id = ${priceId}`);
      await audit(tx, 'DRUG_PRICE_ENDED', 'drug_price', priceId, null, { drugItemId: id, before: cur.valid_to, after: b.validTo });
      return dto(r);
    });
  }
}
