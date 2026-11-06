import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z, type ZodType } from 'zod';
import { type AppConfig, BodySchema, CONFIG, Problem, RequirePermission, blindIndex, ctx, encrypt, problem } from '@clinicrme/shared';
import { Db, type Tx, audit, rows } from '@clinicrme/db';
import { auditChange } from './common';
import { DRUG, DrugBody, type DrugRow, drugDto } from './drugs.controller';
import { PayerBody } from './payers.controller';
import { PractitionerBody } from './practitioners.controller';
import { ServiceBody, TariffBody } from './services.controller';
import { SupplierBody, UomBody } from './supplies.controller';
import { UnitBody } from './organization.controller';
import { CSV_TYPE, XLSX_TYPE, parseBool, readSheet, toCsv, toXlsx } from './transfer';

type Values = Record<string, string>;
class RowError extends Error { constructor(readonly field: string, message: string) { super(message); } }
interface Spec {
  label: string;
  columns: string[];
  /** Kolom kunci untuk mendeteksi baris ganda dalam satu berkas. */
  key: (v: Values) => string | null;
  exportRows: (tx: Tx) => Promise<Record<string, unknown>[]>;
  importRow: (tx: Tx, v: Values, cfg: AppConfig) => Promise<'created' | 'updated'>;
}

const blank = (s: string | undefined) => (s === undefined || s.trim() === '' ? undefined : s.trim());
const orNull = (s: string | undefined) => blank(s) ?? null;
function bool(v: Values, k: string) {
  try { return parseBool(v[k] ?? ''); } catch (e) { throw new RowError(k, (e as Error).message); }
}
function num(v: Values, k: string) {
  const s = blank(v[k]);
  if (s === undefined) return undefined;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) throw new RowError(k, 'Harus angka');
  return n;
}
/** Validasi memakai skema body API yang sama (aturan identik dengan form). */
function parse<T>(schema: ZodType<T>, input: Record<string, unknown>): T {
  const r = schema.safeParse(Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)));
  if (!r.success) {
    const i = r.error.issues[0];
    throw new RowError(String(i.path[0] ?? ''), i.message);
  }
  return r.data;
}
async function idByCode(tx: Tx, table: 'branch' | 'service_item' | 'payer', code: string | undefined, field: string, label: string) {
  if (!code) return null;
  const found = table === 'branch' ? await rows<{ id: string }>(tx, sql`select id from branch where code = ${code.toUpperCase()}`)
    : table === 'service_item' ? await rows<{ id: string }>(tx, sql`select id from service_item where code = ${code.toUpperCase()}`)
    : await rows<{ id: string }>(tx, sql`select id from payer where code = ${code.toUpperCase()}`);
  if (!found[0]) throw new RowError(field, `${label} dengan kode ${code} tidak ditemukan`);
  return found[0].id;
}

const SPECS: Record<string, Spec> = {
  'service-items': {
    label: 'Layanan', columns: ['code', 'name', 'serviceType', 'icd9cmCode', 'isActive'],
    key: (v) => blank(v.code)?.toUpperCase() ?? null,
    exportRows: (tx) => rows(tx, sql`select code, name, service_type as "serviceType", icd9cm_code as "icd9cmCode",
                                            case when is_active then 'ya' else 'tidak' end as "isActive" from service_item order by code`),
    async importRow(tx, v) {
      const b = parse(ServiceBody, { code: blank(v.code), name: blank(v.name), serviceType: blank(v.serviceType)?.toUpperCase(),
        icd9cmCode: orNull(v.icd9cmCode), isActive: bool(v, 'isActive') });
      const [cur] = await rows<Record<string, unknown> & { id: string }>(tx, sql`select id, code, name, service_type as "serviceType",
        icd9cm_code as "icd9cmCode", is_active as "isActive" from service_item where code = ${b.code} for update`);
      if (cur) {
        const after = { code: b.code, name: b.name, serviceType: b.serviceType, icd9cmCode: b.icd9cmCode ?? null, isActive: b.isActive ?? cur.isActive };
        await tx.execute(sql`update service_item set name = ${after.name}, service_type = ${after.serviceType}, icd9cm_code = ${after.icd9cmCode},
                               is_active = ${after.isActive as boolean}, updated_by = ${ctx().userId} where id = ${cur.id}`);
        await auditChange(tx, 'SERVICE_ITEM_UPDATED', 'service_item', cur.id, cur, after);
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into service_item(tenant_id, code, name, service_type, icd9cm_code, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.serviceType}, ${b.icd9cmCode ?? null}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'SERVICE_ITEM_CREATED', 'service_item', r.id, null, b);
      return 'created';
    },
  },
  payers: {
    label: 'Penjamin', columns: ['code', 'name', 'payerType', 'isActive', 'contractNumber', 'validUntil', 'plafon', 'copayPercent', 'paymentTermDays'],
    key: (v) => blank(v.code)?.toUpperCase() ?? null,
    exportRows: (tx) => rows(tx, sql`select code, name, payer_type as "payerType", case when is_active then 'ya' else 'tidak' end as "isActive",
      contract->>'contractNumber' as "contractNumber", contract->>'validUntil' as "validUntil", contract->>'plafon' as plafon,
      contract->>'copayPercent' as "copayPercent", contract->>'paymentTermDays' as "paymentTermDays" from payer order by code`),
    async importRow(tx, v) {
      const contract = Object.fromEntries(Object.entries({ contractNumber: blank(v.contractNumber), validUntil: blank(v.validUntil), plafon: blank(v.plafon),
        copayPercent: num(v, 'copayPercent'), paymentTermDays: num(v, 'paymentTermDays') }).filter(([, x]) => x !== undefined));
      const b = parse(PayerBody, { code: blank(v.code), name: blank(v.name), payerType: blank(v.payerType)?.toUpperCase(),
        contract: Object.keys(contract).length ? contract : null, isActive: bool(v, 'isActive') });
      const [cur] = await rows<Record<string, unknown> & { id: string; payerType: string }>(tx, sql`select id, code, name, payer_type as "payerType",
        contract, is_active as "isActive" from payer where code = ${b.code} for update`);
      const contractJson = b.contract ? JSON.stringify(b.contract) : null;
      if (cur) {
        if (cur.payerType !== b.payerType) {
          const [used] = await rows(tx, sql`select 1 from tariff where payer_id = ${cur.id} limit 1`);
          if (used) throw new RowError('payerType', 'Kategori penjamin tidak dapat diubah karena sudah dipakai di tarif');
        }
        const after = { code: b.code, name: b.name, payerType: b.payerType, contract: b.contract ?? null, isActive: b.isActive ?? cur.isActive };
        await tx.execute(sql`update payer set name = ${b.name}, payer_type = ${b.payerType}, contract = ${contractJson}::jsonb,
                               is_active = ${after.isActive as boolean}, updated_by = ${ctx().userId} where id = ${cur.id}`);
        const [fresh] = await rows<{ contract: unknown }>(tx, sql`select contract from payer where id = ${cur.id}`);
        await auditChange(tx, 'PAYER_UPDATED', 'payer', cur.id, cur, { ...after, contract: fresh.contract });
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into payer(tenant_id, code, name, payer_type, contract, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.payerType}, ${contractJson}::jsonb, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'PAYER_CREATED', 'payer', r.id, null, b);
      return 'created';
    },
  },
  suppliers: {
    label: 'Supplier', columns: ['code', 'name', 'contactPerson', 'phone', 'email', 'address', 'npwp', 'isActive'],
    key: (v) => blank(v.code)?.toUpperCase() ?? null,
    exportRows: (tx) => rows(tx, sql`select code, name, contact_person as "contactPerson", phone, email, address, npwp,
                                            case when is_active then 'ya' else 'tidak' end as "isActive" from supplier order by lower(name)`),
    async importRow(tx, v) {
      const b = parse(SupplierBody, { code: orNull(v.code), name: blank(v.name), contactPerson: orNull(v.contactPerson), phone: orNull(v.phone),
        email: orNull(v.email), address: orNull(v.address), npwp: orNull(v.npwp), isActive: bool(v, 'isActive') });
      const [cur] = b.code ? await rows<Record<string, unknown> & { id: string }>(tx, sql`select id, code, name, contact_person as "contactPerson",
        phone, email, address, npwp, is_active as "isActive" from supplier where code = ${b.code} for update`) : [];
      if (cur) {
        const after = { ...b, isActive: b.isActive ?? cur.isActive };
        await tx.execute(sql`update supplier set name = ${b.name}, contact_person = ${b.contactPerson ?? null}, phone = ${b.phone ?? null},
          email = ${b.email ?? null}, address = ${b.address ?? null}, npwp = ${b.npwp ?? null}, is_active = ${after.isActive as boolean},
          updated_by = ${ctx().userId} where id = ${cur.id}`);
        await auditChange(tx, 'SUPPLIER_UPDATED', 'supplier', cur.id, cur, after);
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into supplier(tenant_id, code, name, contact_person, phone, email, address, npwp, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code ?? null}, ${b.name}, ${b.contactPerson ?? null}, ${b.phone ?? null}, ${b.email ?? null},
                ${b.address ?? null}, ${b.npwp ?? null}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'SUPPLIER_CREATED', 'supplier', r.id, null, b);
      return 'created';
    },
  },
  drugs: {
    label: 'Obat', columns: ['code', 'genericName', 'brandName', 'dosageForm', 'strength', 'uomCode', 'drugClass', 'ingredients', 'maxDoseQty', 'maxDailyQty', 'isActive'],
    key: (v) => blank(v.code)?.toUpperCase() ?? null,
    exportRows: (tx) => rows(tx, sql`select d.code, d.generic_name as "genericName", d.brand_name as "brandName", d.dosage_form as "dosageForm",
      d.strength, u.code as "uomCode", d.drug_class as "drugClass", array_to_string(d.ingredients, '|') as ingredients,
      trim_scale(d.max_dose_qty)::text as "maxDoseQty", trim_scale(d.max_daily_qty)::text as "maxDailyQty",
      case when d.is_active then 'ya' else 'tidak' end as "isActive" from drug_item d join uom u on u.id = d.base_uom_id order by d.code`),
    async importRow(tx, v) {
      const uom = blank(v.uomCode);
      const [u] = uom ? await rows<{ id: string }>(tx, sql`select id from uom where code = ${uom.toUpperCase()} and is_active`) : [];
      if (!u) throw new RowError('uomCode', uom ? `Satuan dengan kode ${uom} tidak ditemukan` : 'Wajib diisi');
      const b = parse(DrugBody, { code: blank(v.code), genericName: blank(v.genericName), brandName: orNull(v.brandName), dosageForm: blank(v.dosageForm),
        strength: orNull(v.strength), baseUomId: u.id, drugClass: blank(v.drugClass)?.toUpperCase(),
        ingredients: (blank(v.ingredients) ?? '').split(/[|;]/).map((x) => x.trim()).filter(Boolean),
        maxDoseQty: orNull(v.maxDoseQty), maxDailyQty: orNull(v.maxDailyQty), isActive: bool(v, 'isActive') });
      if (b.maxDoseQty && b.maxDailyQty && Number(b.maxDailyQty) < Number(b.maxDoseQty)) throw new RowError('maxDailyQty', 'Lebih kecil dari batas per pemberian');
      const arr = `{${b.ingredients.map((i) => JSON.stringify(i)).join(',')}}`;
      const [cur] = await rows<DrugRow>(tx, sql`${DRUG} where d.code = ${b.code} for update of d`);
      if (cur) {
        await tx.execute(sql`update drug_item set generic_name = ${b.genericName}, brand_name = ${b.brandName ?? null}, dosage_form = ${b.dosageForm},
          strength = ${b.strength ?? null}, base_uom_id = ${b.baseUomId}, drug_class = ${b.drugClass}, ingredients = ${arr}::text[],
          max_dose_qty = ${b.maxDoseQty ?? null}::numeric, max_daily_qty = ${b.maxDailyQty ?? null}::numeric,
          is_active = ${b.isActive ?? cur.is_active}, updated_by = ${ctx().userId} where id = ${cur.id}`);
        const [r] = await rows<DrugRow>(tx, sql`${DRUG} where d.id = ${cur.id}`);
        await auditChange(tx, 'DRUG_UPDATED', 'drug_item', cur.id, drugDto(cur), drugDto(r));
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into drug_item(tenant_id, code, generic_name, brand_name, dosage_form, strength, base_uom_id,
          drug_class, ingredients, max_dose_qty, max_daily_qty, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.genericName}, ${b.brandName ?? null}, ${b.dosageForm}, ${b.strength ?? null}, ${b.baseUomId},
                ${b.drugClass}, ${arr}::text[], ${b.maxDoseQty ?? null}::numeric, ${b.maxDailyQty ?? null}::numeric, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'DRUG_CREATED', 'drug_item', r.id, null, b);
      return 'created';
    },
  },
  uoms: {
    label: 'Satuan', columns: ['code', 'name', 'isActive'],
    key: (v) => blank(v.code)?.toUpperCase() ?? null,
    exportRows: (tx) => rows(tx, sql`select code, name, case when is_active then 'ya' else 'tidak' end as "isActive" from uom order by code`),
    async importRow(tx, v) {
      const b = parse(UomBody, { code: blank(v.code), name: blank(v.name), isActive: bool(v, 'isActive') });
      const [cur] = await rows<Record<string, unknown> & { id: string }>(tx, sql`select id, code, name, is_active as "isActive" from uom where code = ${b.code} for update`);
      if (cur) {
        const after = { code: b.code, name: b.name, isActive: b.isActive ?? cur.isActive };
        await tx.execute(sql`update uom set name = ${b.name}, is_active = ${after.isActive as boolean}, updated_by = ${ctx().userId} where id = ${cur.id}`);
        await auditChange(tx, 'UOM_UPDATED', 'uom', cur.id, cur, after);
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into uom(tenant_id, code, name, is_active, updated_by)
        values (app.current_tenant_id(), ${b.code}, ${b.name}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'UOM_CREATED', 'uom', r.id, null, b);
      return 'created';
    },
  },
  'service-units': {
    label: 'Poli/unit', columns: ['branchCode', 'code', 'name', 'unitType', 'specialty', 'isActive'],
    key: (v) => (blank(v.code) ? `${(v.branchCode ?? '').toUpperCase()}/${v.code.toUpperCase()}` : null),
    exportRows: (tx) => rows(tx, sql`select b.code as "branchCode", u.code, u.name, u.unit_type as "unitType", u.specialty,
      case when u.is_active then 'ya' else 'tidak' end as "isActive" from service_unit u join branch b on b.id = u.branch_id order by b.code, u.code`),
    async importRow(tx, v) {
      const branchId = await idByCode(tx, 'branch', blank(v.branchCode), 'branchCode', 'Cabang');
      if (!branchId) throw new RowError('branchCode', 'Kode cabang wajib diisi');
      const b = parse(UnitBody, { branchId, code: blank(v.code), name: blank(v.name), unitType: blank(v.unitType)?.toUpperCase(),
        specialty: orNull(v.specialty), isActive: bool(v, 'isActive') });
      const [cur] = await rows<Record<string, unknown> & { id: string }>(tx, sql`select id, branch_id as "branchId", code, name, unit_type as "unitType",
        specialty, is_active as "isActive" from service_unit where branch_id = ${branchId} and code = ${b.code} for update`);
      if (cur) {
        const after = { branchId, code: b.code, name: b.name, unitType: b.unitType, specialty: b.specialty ?? null, isActive: b.isActive ?? cur.isActive };
        await tx.execute(sql`update service_unit set name = ${b.name}, unit_type = ${b.unitType}, specialty = ${after.specialty},
                               is_active = ${after.isActive as boolean}, updated_by = ${ctx().userId} where id = ${cur.id}`);
        await auditChange(tx, 'SERVICE_UNIT_UPDATED', 'service_unit', cur.id, cur, after);
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into service_unit(tenant_id, branch_id, code, name, unit_type, specialty, is_active, updated_by)
        values (app.current_tenant_id(), ${branchId}, ${b.code}, ${b.name}, ${b.unitType}, ${b.specialty ?? null}, ${b.isActive ?? true}, ${ctx().userId}) returning id`);
      await auditChange(tx, 'SERVICE_UNIT_CREATED', 'service_unit', r.id, null, b);
      return 'created';
    },
  },
  practitioners: {
    label: 'Tenaga kesehatan',
    // NIK hanya dapat diimpor, tidak pernah diekspor (kolom kosong saat ekspor)
    columns: ['id', 'fullName', 'practitionerType', 'specialty', 'nik', 'strNumber', 'strValidUntil', 'sipNumber', 'sipValidUntil', 'isActive'],
    key: (v) => blank(v.id) ?? null,
    exportRows: (tx) => rows(tx, sql`select id, full_name as "fullName", practitioner_type as "practitionerType", specialty, '' as nik,
      str_number as "strNumber", to_char(str_valid_until, 'YYYY-MM-DD') as "strValidUntil", sip_number as "sipNumber",
      to_char(sip_valid_until, 'YYYY-MM-DD') as "sipValidUntil", case when is_active then 'ya' else 'tidak' end as "isActive"
      from practitioner order by lower(full_name), id`),
    async importRow(tx, v, cfg) {
      const b = parse(PractitionerBody, { fullName: blank(v.fullName), practitionerType: blank(v.practitionerType)?.toUpperCase(),
        specialty: orNull(v.specialty), nik: blank(v.nik), strNumber: orNull(v.strNumber), strValidUntil: orNull(v.strValidUntil),
        sipNumber: orNull(v.sipNumber), sipValidUntil: orNull(v.sipValidUntil), isActive: bool(v, 'isActive') });
      const id = blank(v.id);
      if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new RowError('id', 'ID tidak valid (kosongkan untuk data baru)');
      const hash = b.nik ? blindIndex(cfg.encryptionKeyHex, 'practitioner-nik', b.nik) : null;
      if (hash) {
        const [dup] = await rows(tx, sql`select 1 from practitioner where nik_hash = ${hash} and id is distinct from ${id ?? null}::uuid`);
        if (dup) throw new RowError('nik', 'NIK ini sudah terdaftar untuk tenaga kesehatan lain');
      }
      const view = { fullName: b.fullName, practitionerType: b.practitionerType, specialty: b.specialty ?? null, strNumber: b.strNumber ?? null,
        strValidUntil: b.strValidUntil ?? null, sipNumber: b.sipNumber ?? null, sipValidUntil: b.sipValidUntil ?? null, isActive: b.isActive ?? true };
      if (id) {
        const [cur] = await rows<Record<string, unknown> & { nik_hash: string | null }>(tx, sql`select full_name as "fullName", practitioner_type as "practitionerType",
          specialty, str_number as "strNumber", to_char(str_valid_until, 'YYYY-MM-DD') as "strValidUntil", sip_number as "sipNumber",
          to_char(sip_valid_until, 'YYYY-MM-DD') as "sipValidUntil", is_active as "isActive", nik_hash from practitioner where id = ${id} for update`);
        if (!cur) throw new RowError('id', 'Tenaga kesehatan dengan ID ini tidak ditemukan');
        const nikHash = hash ?? cur.nik_hash;                     // NIK kosong di berkas = tetap
        await tx.execute(sql`update practitioner set full_name = ${view.fullName}, practitioner_type = ${view.practitionerType}, specialty = ${view.specialty},
          str_number = ${view.strNumber}, str_valid_until = ${view.strValidUntil}::date, sip_number = ${view.sipNumber},
          sip_valid_until = ${view.sipValidUntil}::date, is_active = ${view.isActive},
          nik_encrypted = ${b.nik ? encrypt(cfg.encryptionKeyHex, b.nik) : sql`nik_encrypted`}, nik_hash = ${nikHash}, updated_by = ${ctx().userId}
          where id = ${id}`);
        const { nik_hash: before, ...curView } = cur;
        await auditChange(tx, 'PRACTITIONER_UPDATED', 'practitioner', id, { ...curView, nik: before }, { ...view, nik: nikHash }, ['nik']);
        return 'updated';
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into practitioner(tenant_id, full_name, nik_encrypted, nik_hash, practitioner_type, specialty,
          str_number, str_valid_until, sip_number, sip_valid_until, is_active, updated_by)
        values (app.current_tenant_id(), ${view.fullName}, ${b.nik ? encrypt(cfg.encryptionKeyHex, b.nik) : null}, ${hash}, ${view.practitionerType},
                ${view.specialty}, ${view.strNumber}, ${view.strValidUntil}::date, ${view.sipNumber}, ${view.sipValidUntil}::date, ${view.isActive}, ${ctx().userId})
        returning id`);
      await auditChange(tx, 'PRACTITIONER_CREATED', 'practitioner', r.id, null, { ...view, nik: hash }, ['nik']);
      return 'created';
    },
  },
  tariffs: {
    label: 'Tarif',
    // Impor tarif hanya MENAMBAH periode baru (tarif tidak pernah ditimpa, MST-FR-005)
    columns: ['serviceCode', 'branchCode', 'payerType', 'payerCode', 'price', 'validFrom', 'validTo', 'closePrevious'],
    key: () => null,
    exportRows: (tx) => rows(tx, sql`select s.code as "serviceCode", b.code as "branchCode", t.payer_type as "payerType", p.code as "payerCode",
      trim_scale(t.price)::text as price, to_char(t.valid_from, 'YYYY-MM-DD') as "validFrom", to_char(t.valid_to, 'YYYY-MM-DD') as "validTo", '' as "closePrevious"
      from tariff t join service_item s on s.id = t.service_item_id left join branch b on b.id = t.branch_id left join payer p on p.id = t.payer_id
      order by s.code, b.code nulls first, t.payer_type nulls first, p.code nulls first, t.valid_from`),
    async importRow(tx, v) {
      const serviceItemId = await idByCode(tx, 'service_item', blank(v.serviceCode), 'serviceCode', 'Layanan');
      if (!serviceItemId) throw new RowError('serviceCode', 'Kode layanan wajib diisi');
      const branchId = await idByCode(tx, 'branch', blank(v.branchCode), 'branchCode', 'Cabang');
      const payerId = await idByCode(tx, 'payer', blank(v.payerCode), 'payerCode', 'Penjamin');
      const b = parse(TariffBody, { serviceItemId, branchId, payerType: orNull(v.payerType)?.toUpperCase() ?? null, payerId,
        price: blank(v.price)?.replace(/\./g, '') ?? '', validFrom: blank(v.validFrom), validTo: orNull(v.validTo), closePrevious: bool(v, 'closePrevious') });
      let payerType: string | null = b.payerType ?? null;
      if (payerId) {
        const [p] = await rows<{ payer_type: string }>(tx, sql`select payer_type from payer where id = ${payerId}`);
        if (payerType && payerType !== p.payer_type) throw new RowError('payerType', 'Kategori tidak sesuai dengan penjamin');
        payerType = p.payer_type;
      }
      const key = sql`service_item_id = ${serviceItemId} and branch_id is not distinct from ${branchId}::uuid
        and payer_type is not distinct from ${payerType}::text and payer_id is not distinct from ${payerId}::uuid`;
      if (b.closePrevious) {
        const prev = await rows<{ id: string; valid_to: string | null }>(tx, sql`select id, to_char(valid_to, 'YYYY-MM-DD') as valid_to from tariff
          where ${key} and valid_from < ${b.validFrom}::date and (valid_to is null or valid_to >= ${b.validFrom}::date) for update`);
        for (const t of prev) {
          const [{ d }] = await rows<{ d: string }>(tx, sql`update tariff set valid_to = ${b.validFrom}::date - 1 where id = ${t.id}
            returning to_char(valid_to, 'YYYY-MM-DD') as d`);
          await auditChange(tx, 'TARIFF_ENDED', 'tariff', t.id, { validTo: t.valid_to }, { validTo: d });
        }
      }
      const [r] = await rows<{ id: string }>(tx, sql`insert into tariff(tenant_id, service_item_id, branch_id, payer_type, payer_id, price, valid_from, valid_to, created_by)
        values (app.current_tenant_id(), ${serviceItemId}, ${branchId}::uuid, ${payerType}, ${payerId}::uuid, ${b.price}::numeric, ${b.validFrom}::date,
                ${b.validTo ?? null}::date, ${ctx().userId}) returning id`);
      await auditChange(tx, 'TARIFF_CREATED', 'tariff', r.id, null, { serviceItemId, branchId, payerType, payerId, price: b.price, validFrom: b.validFrom, validTo: b.validTo ?? null });
      return 'created';
    },
  },
};

const ENTITY = z.enum(Object.keys(SPECS) as [string, ...string[]]);
const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).default('true') });
const ExportQuery = z.object({ format: z.enum(['csv', 'xlsx']).default('csv'), template: z.enum(['true', 'false']).optional() });
/** Badan impor: berkas mentah (CSV/XLSX). Batas 5 MB oleh body parser raw (create-app). */
const FileBody = z.custom<Buffer>((b) => Buffer.isBuffer(b) && b.length > 0, 'Kirim berkas CSV atau Excel sebagai body (Content-Type text/csv atau .xlsx)');
const ROLE_BY_ENTITY: Record<string, string> = {
  'service-items': 'master.service.manage', tariffs: 'master.tariff.manage', payers: 'master.payer.manage', suppliers: 'master.supplier.manage',
  uoms: 'master.uom.manage', 'service-units': 'master.facility.manage', practitioners: 'master.practitioner.manage', drugs: 'pharmacy.drug.manage',
};

/**
 * Impor/ekspor master data (MST-FR-008, OD-083). Impor: unggah → validasi setiap baris dengan aturan yang sama dengan
 * form (skema API + pemeriksaan database) → laporan error per baris. `dryRun=true` (bawaan) tidak menyimpan apa pun;
 * `dryRun=false` menyimpan SEMUA baris dalam satu transaksi hanya bila tidak ada error (tidak pernah sebagian).
 * Setiap baris yang tersimpan teraudit sebelum/sesudah; impor & ekspor juga dicatat sebagai satu entri audit.
 * Selain `master.import`, pengimpor wajib memegang izin kelola entitas itu.
 */
@Controller('api/v1')
export class ImportsController {
  constructor(private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @RequirePermission('master.import') @BodySchema(FileBody) @Post('imports/:entity') @HttpCode(200)
  async import(@Param('entity') entity: string, @Query() q: Record<string, unknown>, @Body() body: Buffer,
               @Headers('content-type') contentType: string | undefined) {
    const e = ENTITY.safeParse(entity);
    if (!e.success) throw problem(404, 'MST-404-ENTITY', 'Jenis data tidak dikenal');
    const p = ImportQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    if (!ctx().permissions?.has(ROLE_BY_ENTITY[e.data])) throw problem(403, 'IAM-403-FORBIDDEN', 'Tidak memiliki izin mengelola data ini');
    const spec = SPECS[e.data];
    const dryRun = p.data.dryRun === 'true';
    const sheet = await readSheet(body, (contentType ?? '').toLowerCase());
    const unknown = sheet.header.filter((h) => h && !spec.columns.includes(h));
    if (unknown.length) throw problem(400, 'MST-400-HEADER', `Kolom tidak dikenal: ${unknown.join(', ')}. Pakai template ${spec.label}.`);

    const errors: { row: number; field: string; message: string }[] = [];
    let created = 0, updated = 0;
    const rollback = new Error('rollback');
    try {
      await this.db.withTenantTx(async (tx) => {
        const seen = new Map<string, number>();
        for (const r of sheet.rows) {
          const k = spec.key(r.values);
          if (k && seen.has(k)) { errors.push({ row: r.row, field: '', message: `Duplikat dengan baris ${seen.get(k)}` }); continue; }
          if (k) seen.set(k, r.row);
          // Savepoint per baris: error database (mis. periode tumpang tindih) tidak menghentikan validasi baris berikutnya
          await tx.execute(sql`savepoint import_row`);
          try {
            if ((await spec.importRow(tx, r.values, this.cfg)) === 'created') created++;
            else updated++;
            await tx.execute(sql`release savepoint import_row`);
          } catch (err) {
            await tx.execute(sql`rollback to savepoint import_row`);
            errors.push({ row: r.row, ...rowError(err) });
          }
        }
        if (dryRun || errors.length) throw rollback;
        await audit(tx, 'MASTER_IMPORTED', 'master_import', null, null, { entity: e.data, rows: sheet.rows.length, created, updated });
      });
    } catch (err) { if (err !== rollback) throw err; }
    const status = errors.length ? 'FAILED' : dryRun ? 'VALIDATED' : 'COMMITTED';
    return { entity: e.data, status, dryRun, rowCount: sheet.rows.length, created, updated, errors: errors.slice(0, 500) };
  }

  @RequirePermission('master.export') @Get('exports/:entity')
  async export(@Param('entity') entity: string, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const e = ENTITY.safeParse(entity);
    if (!e.success) throw problem(404, 'MST-404-ENTITY', 'Jenis data tidak dikenal');
    const p = ExportQuery.safeParse(q);
    if (!p.success) throw problem(400, 'GEN-400-QUERY', 'Parameter tidak valid');
    const spec = SPECS[e.data];
    const template = p.data.template === 'true';
    const data = template ? [] : await this.db.withTenantTx(async (tx) => {
      const r = await spec.exportRows(tx);
      await audit(tx, 'MASTER_EXPORTED', 'master_export', null, null, { entity: e.data, rows: r.length, format: p.data.format });
      return r;
    });
    const name = `${e.data}${template ? '-template' : ''}.${p.data.format}`;
    const file = p.data.format === 'xlsx' ? await toXlsx(spec.label, spec.columns, data) : toCsv(spec.columns, data);
    res.setHeader('Content-Type', p.data.format === 'xlsx' ? XLSX_TYPE : `${CSV_TYPE}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file);
  }
}

function rowError(err: unknown): { field: string; message: string } {
  if (err instanceof RowError) return { field: err.field, message: err.message };
  if (err instanceof Problem) return { field: '', message: err.message };
  const pg = (err as { cause?: { code?: string; message?: string } })?.cause ?? (err as { code?: string; message?: string });
  if (pg?.code === '23P01') return { field: 'validFrom', message: 'Periode bertabrakan dengan tarif yang sudah ada' };
  if (pg?.code === 'CRQ01') return { field: '', message: 'Batas paket tercapai' };
  if (pg?.code === '23505') return { field: '', message: 'Data dengan kunci yang sama sudah ada' };
  return { field: '', message: 'Baris tidak dapat disimpan' };
}
