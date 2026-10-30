import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

type RoleRow = { role: string; unsafe: boolean };

// Row-level security does not limit superusers, BYPASSRLS roles or a table's owner, nor any role
// that can SET ROLE to one of them. The API and worker connect as pulse_app; this refuses to
// start if they were given anything else
export async function assertRestrictedRole(db: Database): Promise<void> {
  // Both the login (session_user) and the active role (current_user): a login that switched
  // roles can switch back with RESET ROLE. pg_has_role(…, 'MEMBER') is true for the role itself
  // and for every role it is a member of, so membership counts like the real thing
  const { rows } = await db.execute<RoleRow>(sql`
    select r.rolname as role,
           exists (
             select 1
             from pg_roles p
             where (p.rolsuper or p.rolbypassrls)
               and pg_has_role(r.oid, p.oid, 'MEMBER')
           )
           or exists (
             select 1
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p')
               and n.nspname <> 'information_schema'
               and n.nspname !~ '^pg_'
               and pg_has_role(r.oid, c.relowner, 'MEMBER')
           ) as unsafe
    from pg_roles r
    where r.rolname in (current_user, session_user)
  `);
  if (rows.length === 0) {
    throw new Error('Could not read the current database role');
  }
  const unsafe = rows.find((row) => row.unsafe);
  if (unsafe !== undefined) {
    throw new Error(
      `Database role "${unsafe.role}" may bypass row-level security ` +
        '(superuser, BYPASSRLS or table owner, or a member of one); connect as pulse_app',
    );
  }
}
