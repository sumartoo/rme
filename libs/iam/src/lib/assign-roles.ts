import { sql } from 'drizzle-orm';
import type { Tx } from '@clinicrme/db';

/** Role dari undangan; branch_ids kosong = semua cabang (IAM-FR-009). Dipakai terima-undangan (password) & penautan Google. */
export async function assignInvitationRoles(tx: Tx, userId: string, roleIds: string[], branchIds: string[]) {
  for (const roleId of roleIds) {
    for (const branchId of branchIds.length ? branchIds : [null]) {
      await tx.execute(sql`insert into user_role_assignment(tenant_id, user_id, role_id, branch_id)
                           values (app.current_tenant_id(), ${userId}, ${roleId}, ${branchId}::uuid)`);
    }
  }
}
