// Klinik uji aplikasi klinik (W##), dibuat SETELAH uji konsol (U02 mengharapkan daftar tenant kosong).
// Jalur resmi provision_tenant, lalu dua user sintetis ber-password: admin klinik (wajib TOTP) dan kasir.
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { CLINIC_CODE, USER_PASSWORD, dbUrl } from './config';

/** Uji E2E tidak menjalankan pengirim email: tetapkan token tautan yang diketahui langsung (hanya hash yang disimpan, seperti worker). */
export async function setLinkToken(kind: 'invitation' | 'reset', email: string, token: string): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const hash = createHash('sha256').update(token).digest('hex');
    const q = kind === 'invitation'
      ? `UPDATE app.user_invitation SET token_hash = $2 WHERE lower(email) = lower($1) AND accepted_at IS NULL`
      : `UPDATE app.password_reset_request SET token_hash = $2 WHERE user_id = (SELECT id FROM app.app_user WHERE lower(email) = lower($1)) AND used_at IS NULL`;
    const r = await c.query(q, [email, hash]);
    if (!r.rowCount) throw new Error(`tidak ada ${kind} aktif untuk ${email}`);
  } finally {
    await c.end();
  }
}

export async function seedClinic(): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows: [t] } = await c.query(`SELECT app.provision_tenant($1, 'PT Klinik Web E2E (sintetis)', 'Klinik Web E2E', 'KLINIK_PRATAMA',
      (SELECT id FROM app.subscription_plan WHERE code = 'PILOT'), 14, 'admin@klinik-web.test', 'e2e-invite-hash', NULL) AS id`, [CLINIC_CODE]);
    // Dua cabang (kuota paket PILOT = 2) untuk uji pilih cabang aktif (IAM-FR-009)
    const { rows: [f] } = await c.query(`INSERT INTO app.facility(tenant_id, name, facility_type) VALUES ($1, 'Klinik Web E2E', 'KLINIK_PRATAMA') RETURNING id`, [t.id]);
    for (const [code, name] of [['UTM', 'Cabang Utama'], ['TMR', 'Cabang Timur']]) {
      await c.query(`INSERT INTO app.branch(tenant_id, facility_id, code, name) VALUES ($1, $2, $3, $4)`, [t.id, f.id, code, name]);
    }
    for (const [email, name, role] of [['admin@klinik-web.test', 'Admin Klinik E2E', 'TENANT_ADMIN'], ['kasir@klinik-web.test', 'Kasir E2E', 'KASIR']]) {
      const { rows: [u] } = await c.query(`INSERT INTO app.app_user(tenant_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`, [t.id, email, name]);
      await c.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t.id, u.id, pw]);
      await c.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id) SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [t.id, u.id, role]);
    }
  } finally {
    await c.end();
  }
}

/** User sintetis tambahan untuk uji tahap berikutnya (Stage 8+); ditambah saat uji itu mulai agar jumlah user uji lama tidak berubah. */
/** `practitionerName`: tautkan akun ke data tenaga kesehatan (dokter yang mengisi & mengesahkan rekam medis). */
/** Role kustom klinik (tanpa MFA) untuk skenario E2E, mis. penyetuju stok terpisah dari petugas farmasi. */
export async function addClinicRole(code: string, name: string, permissions: string[]): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    const { rows: [r] } = await c.query(`INSERT INTO app.role(tenant_id, code, name, requires_mfa) VALUES ($1, $2, $3, false)
                                         ON CONFLICT DO NOTHING RETURNING id`, [t.id, code, name]);
    if (!r) return;
    await c.query(`INSERT INTO app.role_permission(tenant_id, role_id, permission_code) SELECT $1, $2, unnest($3::text[])`, [t.id, r.id, permissions]);
  } finally {
    await c.end();
  }
}

/** Obat + harga jual + stok satu batch di lokasi bawaan cabang pertama klinik E2E (data sintetis). */
export async function addClinicDrugStock(o: { code: string; name: string; drugClass: string; uomCode: string; price: number; qty: number; batchNo: string }): Promise<string> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    const { rows: [d] } = await c.query(`INSERT INTO app.drug_item(tenant_id, code, generic_name, dosage_form, base_uom_id, drug_class, ingredients)
      SELECT $1, $2, $3, 'Tablet', u.id, $4, ARRAY[lower($3)] FROM app.uom u WHERE u.tenant_id = $1 AND u.code = $5 RETURNING id`,
      [t.id, o.code, o.name, o.drugClass, o.uomCode]);
    await c.query(`INSERT INTO app.drug_price(tenant_id, drug_item_id, sell_price, valid_from) VALUES ($1, $2, $3, current_date - 1)`, [t.id, d.id, o.price]);
    const { rows: [b] } = await c.query(`INSERT INTO app.stock_batch(tenant_id, drug_item_id, batch_no, expiry_date, unit_cost)
      VALUES ($1, $2, $3, current_date + 365, $4) RETURNING id`, [t.id, d.id, o.batchNo, Math.round(o.price / 2)]);
    const { rows: [l] } = await c.query(`SELECT l.id, br.name FROM app.stock_location l JOIN app.branch br ON br.id = l.branch_id
       WHERE l.tenant_id = $1 AND l.is_default AND br.is_active ORDER BY br.code LIMIT 1`, [t.id]);
    await c.query(`INSERT INTO app.stock_movement(tenant_id, batch_id, location_id, movement_type, qty, ref_type, ref_id)
      VALUES ($1, $2, $3, 'RECEIPT', $4, 'goods_receipt', gen_random_uuid())`, [t.id, b.id, l.id, o.qty]);
    return l.name as string;
  } finally {
    await c.end();
  }
}

export async function addClinicUser(email: string, name: string, role: string, practitionerName?: string): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const pw = await hash(USER_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    const { rows: [u] } = await c.query(`INSERT INTO app.app_user(tenant_id, email, full_name) VALUES ($1, $2, $3)
                                         ON CONFLICT DO NOTHING RETURNING id`, [t.id, email, name]);
    if (!u) return;
    await c.query(`INSERT INTO app.user_credential(tenant_id, user_id, password_hash) VALUES ($1, $2, $3)`, [t.id, u.id, pw]);
    await c.query(`INSERT INTO app.user_role_assignment(tenant_id, user_id, role_id) SELECT $1, $2, id FROM app.role WHERE tenant_id = $1 AND code = $3`, [t.id, u.id, role]);
    if (practitionerName) {
      await c.query(`UPDATE app.app_user SET practitioner_id = (SELECT id FROM app.practitioner WHERE tenant_id = $1 AND full_name = $3)
                      WHERE id = $2`, [t.id, u.id, practitionerName]);
    }
  } finally {
    await c.end();
  }
}

/** Tarif umum (berlaku semua cabang & penjamin) untuk layanan yang belum bertarif + satu layanan konsultasi (uji kasir, Stage 11). */
export async function addClinicTariffs(price: number): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    await c.query(`INSERT INTO app.service_item(tenant_id, code, name, service_type) VALUES ($1, 'KONS-GIGI', 'Konsultasi dokter gigi', 'KONSULTASI')
                   ON CONFLICT DO NOTHING`, [t.id]);
    await c.query(`INSERT INTO app.tariff(tenant_id, service_item_id, price, valid_from)
                   SELECT $1, s.id, $2, current_date - 30 FROM app.service_item s
                    WHERE s.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM app.tariff x WHERE x.service_item_id = s.id)`, [t.id, price]);
  } finally {
    await c.end();
  }
}

/** Kunjungan sintetis yang sudah diteruskan ke kasir (status BILLING) untuk pasien & poli yang sudah ada (uji kasir, Stage 11). */
export async function addClinicBillingEncounter(o: { patientName: string; branchName: string; unitName: string; practitionerName: string;
  /** Penjamin asuransi sintetis (dibuat bila belum ada) dengan co-pay %; tanpa ini kunjungan Umum. */ insurer?: { code: string; name: string; copayPercent: number } }): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const { rows: [t] } = await c.query(`SELECT id FROM app.tenant WHERE code = $1`, [CLINIC_CODE]);
    let coverage: string | null = null;
    if (o.insurer) {
      await c.query(`INSERT INTO app.payer(tenant_id, code, name, payer_type, contract) VALUES ($1, $2, $3, 'ASURANSI', jsonb_build_object('copayPercent', $4::int))
                     ON CONFLICT DO NOTHING`, [t.id, o.insurer.code, o.insurer.name, o.insurer.copayPercent]);
      const { rows: [cv] } = await c.query(`
        INSERT INTO app.patient_coverage(tenant_id, patient_id, payer_id, member_no)
        SELECT $1, p.id, y.id, 'E2E-' || substr(md5(random()::text), 1, 8) FROM app.patient p, app.payer y
         WHERE p.tenant_id = $1 AND p.full_name = $2 AND y.tenant_id = $1 AND y.code = $3 LIMIT 1 RETURNING id`, [t.id, o.patientName, o.insurer.code]);
      coverage = cv.id;
    }
    await c.query(`
      INSERT INTO app.encounter(tenant_id, encounter_no, patient_id, branch_id, unit_id, practitioner_id, arrival_type, status, payer_type, coverage_id,
                                coverage_verified_at, arrived_at)
      SELECT $1, 'E2E-KSR-' || substr(md5(random()::text), 1, 8), p.id, b.id, u.id, pr.id, 'WALK_IN', 'BILLING',
             CASE WHEN $6::uuid IS NULL THEN 'UMUM' ELSE 'ASURANSI' END, $6::uuid, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, now()
        FROM app.patient p, app.branch b, app.service_unit u, app.practitioner pr
       WHERE p.tenant_id = $1 AND p.full_name = $2 AND b.tenant_id = $1 AND b.name = $3 AND u.branch_id = b.id AND u.name = $4
         AND pr.tenant_id = $1 AND pr.full_name = $5 LIMIT 1`, [t.id, o.patientName, o.branchName, o.unitName, o.practitionerName, coverage]);
  } finally {
    await c.end();
  }
}

/**
 * Simulasikan gangguan SATUSEHAT berkepanjangan (Stage 12 batch 3): kiriman koreksi diagnosis terakhir klinik E2E ditandai DEAD,
 * seperti setelah 5 percobaan gagal. Hanya untuk uji — memperlihatkan daftar "Perlu tindakan" & kirim ulang.
 */
export async function markLatestSatuSehatAddendumDead(): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    const { rowCount } = await c.query(`
      UPDATE app.fhir_sync_record SET status = 'DEAD', attempts = 5, last_error = 'SATUSEHAT sementara gagal (HTTP 503)', next_attempt_at = NULL
       WHERE id = (SELECT r.id FROM app.fhir_sync_record r JOIN app.tenant t ON t.id = r.tenant_id
                    WHERE t.code = $1 AND r.local_type = 'clinical_addendum' AND r.status = 'SENT' ORDER BY r.updated_at DESC LIMIT 1)`, [CLINIC_CODE]);
    if (rowCount !== 1) throw new Error('Tidak ada kiriman addendum untuk ditandai');
  } finally {
    await c.end();
  }
}
