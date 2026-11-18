import { Client } from 'pg';

/**
 * Role LOGIN aplikasi & konsol platform (Stage 15): hanya anggota role grup (`clinicrme_app` / `clinicrme_platform`), NOBYPASSRLS,
 * bukan superuser/owner — sama dengan deploy/vps/init-roles.sh. Dijalankan job migrasi Cloud Run setelah migrasi, dengan password dari
 * Secret Manager (env), sehingga password tidak tertulis di Terraform state maupun SQL. Idempoten; password diperbarui setiap jalan (rotasi).
 */
export interface LoginRole { user: string; password: string; group: 'clinicrme_app' | 'clinicrme_platform' }

export async function ensureLoginRoles(ownerUrl: string, roles: LoginRole[]): Promise<string[]> {
  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    for (const r of roles) {
      if (!/^[a-z][a-z0-9_]{2,62}$/.test(r.user)) throw new Error(`Nama role tidak valid: ${r.user}`);
      if (r.password.length < 24) throw new Error(`Password role ${r.user} terlalu pendek (min. 24)`);
      const u = c.escapeIdentifier(r.user);
      const { rowCount } = await c.query('select 1 from pg_roles where rolname = $1', [r.user]);
      if (!rowCount) await c.query(`create role ${u} login nobypassrls nosuperuser nocreatedb nocreaterole`);
      await c.query(`alter role ${u} login nobypassrls nosuperuser nocreatedb nocreaterole password ${c.escapeLiteral(r.password)}`);
      await c.query(`grant ${c.escapeIdentifier(r.group)} to ${u}`);
    }
    const { rows } = await c.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname = any($1::text[]) and (rolsuper or rolbypassrls or rolcreaterole)`, [roles.map((r) => r.user)]);
    if (rows.length) throw new Error(`Role tidak aman (superuser/BYPASSRLS/CREATEROLE): ${rows.map((x) => x.rolname).join(', ')}`);
    return roles.map((r) => r.user);
  } finally {
    await c.end();
  }
}

/** Role dari env job migrasi: APP_DB_USER/APP_DB_PASSWORD dan PLATFORM_DB_USER/PLATFORM_DB_PASSWORD (keduanya opsional berpasangan). */
export function loginRolesFromEnv(env: Record<string, string | undefined>): LoginRole[] {
  const out: LoginRole[] = [];
  for (const [prefix, group] of [['APP', 'clinicrme_app'], ['PLATFORM', 'clinicrme_platform']] as const) {
    const user = env[`${prefix}_DB_USER`], password = env[`${prefix}_DB_PASSWORD`];
    if (!user && !password) continue;
    if (!user || !password) throw new Error(`${prefix}_DB_USER dan ${prefix}_DB_PASSWORD harus diisi berpasangan`);
    out.push({ user, password, group });
  }
  return out;
}
