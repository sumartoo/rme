# API Contracts — ClinicRME SaaS

| | |
|---|---|
| Versi | 1.0 — Disetujui (DEC-018) |
| Tanggal | 4 November 2026 |
| Kontrak | [`api/openapi.yaml`](../../api/openapi.yaml) — OpenAPI 3.1, dibangkitkan oleh `tools/gen_openapi.py` |
| ADR | ADR-0003 (auth), ADR-0008 (OpenAPI) |
| Lint | Redocly recommended — **valid** ([bukti](../reports/stage-2/evidence/openapi_lint.txt)) |

## 1. Ringkasan

| Tag | Operasi | Tag | Operasi |
|---|---|---|---|
| Auth | 9 | Scheduling | 15 |
| IAM | 13 | Clinical | 14 |
| Audit | 1 | Document | 3 |
| Platform | 6 | Pharmacy | 16 |
| Tenant | 4 | Billing | 18 |
| Master | 18 | Integration | 7 |
| Terminology | 2 | Report | 10 |
| Patient | 8 | **Total** | **144** |

Cakupan: **138 dari 140** requirement fungsional MVP dirujuk oleh minimal satu operasi (`x-requirements`). Dua sisanya bukan API: AUD-FR-003 ditegakkan di database (ADR-0007), SCH-FR-011 adalah job terjadwal di worker.

## 2. Konvensi

| Aspek | Aturan |
|---|---|
| Base path | `/api/v1` (staf), `/api/platform/v1` (platform admin), `/api/patient/v1` (Android — Stage 13), `/api/integrations/...` (webhook) |
| Autentikasi | Cookie sesi `crme_session` (HttpOnly, Secure, SameSite=Lax). Tenant & cabang aktif berasal dari sesi, **tidak pernah** dari body/query |
| Otorisasi | Setiap operasi memiliki `x-permission`; dicek di backend (guard global, deny by default) |
| Format | JSON, `camelCase`; tanggal ISO-8601; waktu UTC (`date-time`) |
| Uang | String desimal (`"150000.00"`) — tidak pernah `number` |
| Kuantitas | String desimal hingga 4 digit |
| Error | RFC 9457 `application/problem+json` dengan `code` stabil, mis. `PAT-409-DUPLICATE`, `CLN-409-SIGNED`, `PLT-403-QUOTA` |
| Pagination | Cursor: `?cursor=&limit=` → `{ data, page: { nextCursor, hasMore } }` |
| Idempotency | Header `Idempotency-Key` wajib pada pembuatan pasien, kunjungan, pengesahan, dispensing, pembayaran, refund, QRIS, dokumen |
| Konkurensi | `If-Match` (ETag/version) pada update objek yang dapat diedit bersamaan; `412` bila versi berubah |
| Resource tenant lain | Selalu `404` (bukan `403`) agar keberadaan data tidak bocor |
| Rate limit | `/auth/*` dan export dibatasi; `429` |

## 3. Kode Status

| Status | Arti |
|---|---|
| 200 / 201 / 202 / 204 | Sukses / dibuat / diterima untuk diproses asinkron / tanpa isi |
| 302 | Redirect OAuth Google |
| 400 | Validasi input gagal (`errors[]` per field) |
| 401 | Belum login, sesi tidak berlaku, atau MFA belum diverifikasi |
| 403 | Tidak punya permission |
| 404 | Tidak ada, atau milik tenant/cabang lain |
| 409 | Konflik status, data immutable, duplikat, kuota |
| 412 | `If-Match` tidak cocok |
| 422 | Pengesahan RM ditolak karena data belum lengkap (daftar `missing`) |
| 429 | Terlalu banyak percobaan |

## 4. Alur Kunci

### Login Google (ADR-0003)
```
GET  /api/v1/auth/google            → 302 ke Google
GET  /api/v1/auth/google/callback   → 302 ke aplikasi (cookie sesi diset)
POST /api/v1/auth/mfa/verify        → bila role butuh MFA
POST /api/v1/me/branch              → bila user punya > 1 cabang
GET  /api/v1/me, /api/v1/me/menu
```

### Pasien walk-in sampai bayar (WF-01)
```
GET  /patients?q=…                          cari
POST /patients/duplicate-check              cek duplikat
POST /patients                              registrasi (Idempotency-Key)
POST /encounters/walk-in                    kunjungan + antrean
POST /queue/{ticketId}/call                 panggil
POST /encounters/{id}/vitals                perawat
GET  /encounters/{id}/chart                 dokter membuka (audit READ)
PUT  /encounters/{id}/note                  SOAP draft (If-Match)
PUT  /encounters/{id}/diagnoses             ICD-10
PUT  /encounters/{id}/prescription          resep (+ peringatan)
POST /encounters/{id}/sign                  sahkan (422 bila belum lengkap)
GET  /pharmacy/worklist → POST /prescriptions/{id}/review → POST /prescriptions/{id}/dispense
GET  /encounters/{id}/invoice → POST /invoices/{id}/issue → POST /invoices/{id}/payments | /qris
```

### QRIS
```
POST /invoices/{id}/qris (Idempotency-Key) → { qrPayload, expiresAt }
Provider → POST /api/integrations/payment-gateway/callback (X-Signature)
  · signature tidak valid → 401, dicatat
  · callback ganda → 200, tanpa pembayaran ganda (unique idempotency_key)
GET  /qris/{chargeId} → status (polling / SSE)
```

## 5. Endpoint Real-time

| Endpoint | Mekanisme | Pemakai |
|---|---|---|
| `/api/v1/queue/board/stream` | Server-Sent Events | Layar TV antrean (SCH-FR-008) |
| `/api/v1/qris/{chargeId}/stream` | SSE | Layar kasir menunggu pembayaran |
| `/api/v1/pharmacy/worklist/stream` | SSE | Worklist farmasi ≤ 5 detik (AC-PHM-FR-006-1) |

Endpoint SSE didokumentasikan di sini karena OpenAPI 3.1 tidak memodelkan stream dengan baik.

## 6. Yang Belum Termasuk

- API aplikasi pasien `/api/patient/v1` — Stage 13 (Lanjutan).
- API BPJS — Lanjutan (DEC-006).
- Report builder — Lanjutan (RPT-FR-010).
- Endpoint FHIR publik — tidak di MVP (OD-009, ADR-0004).

## 7. Cara Memperbarui

```bash
pip install pyyaml
python3 tools/gen_openapi.py api/openapi.yaml
npx @redocly/cli lint api/openapi.yaml
python3 tools/gen_rtm.py docs/01-requirements   # kolom API di RTM ikut diperbarui
```

Mulai Stage 4, sumber kebenaran berpindah ke kode NestJS (`@nestjs/swagger`); file ini menjadi pembanding saat gate Stage 4.
