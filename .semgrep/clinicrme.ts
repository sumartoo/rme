// File uji aturan .semgrep/clinicrme.yml (semgrep --test). Bukan kode aplikasi.
declare const sql: any, z: any, req: any, logger: any, ident: any, expect: any, a: any;

// ruleid: crme-no-sql-raw
sql.raw(`select * from patient where id = '${req.params.id}'`);
// ok: crme-no-sql-raw
sql`select * from patient where id = ${req.params.id}`;

// ruleid: crme-tenant-from-request
const t1 = req.body.tenant_id;
// ruleid: crme-tenant-from-request
const t2 = req.query.tenantId;
// ruleid: crme-tenant-from-request
const t3 = req.headers['x-tenant-id'];

// ruleid: crme-zod-array-without-max
const a1 = z.object({ ids: z.array(z.string().uuid()) });
// ok: crme-zod-array-without-max
const a2 = z.object({ ids: z.array(z.string().uuid()).max(100) });
// ok: crme-zod-array-without-max
const a3 = z.object({ ids: z.array(z.string()).min(1).max(20) });

// ruleid: crme-no-math-random-for-secrets
const token = Math.random().toString(36);

// ruleid: crme-no-log-request-body
console.log('masuk', req.body);
// ruleid: crme-no-log-request-body
logger.info({ body: req.body }, 'request');
// ok: crme-no-log-request-body
logger.info({ path: req.path }, 'request');
// ok: crme-no-log-request-body
expect(a.body).toEqual(req.body);
export {};
