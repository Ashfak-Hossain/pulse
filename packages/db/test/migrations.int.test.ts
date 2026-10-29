import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../src/index.js';

describe('migrations on an empty PostGIS', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  async function appPrivileges(table: string): Promise<Record<string, boolean>> {
    const result = await owner.execute<Record<string, boolean>>(
      sql`select has_table_privilege('pulse_app', ${table}, 'SELECT') as select,
                 has_table_privilege('pulse_app', ${table}, 'INSERT') as insert,
                 has_table_privilege('pulse_app', ${table}, 'UPDATE') as update,
                 has_table_privilege('pulse_app', ${table}, 'DELETE') as delete`,
    );
    return result.rows[0] ?? {};
  }

  it('install the postgis extension, and only it (migration 0000 is the one source)', async () => {
    const result = await owner.execute(
      sql`select extname from pg_extension where extname like 'postgis%' order by 1`,
    );
    expect(result.rows).toEqual([{ extname: 'postgis' }]);
  });

  it('protect every table with RLS and a pulse_app policy, unless it is a listed exception', async () => {
    // Each exception is a decision in ADR 0003; a new table must either get a policy or be added here
    const exceptions = ['outbox_event', 'processed_event', 'spatial_ref_sys'];
    // r = table, p = partitioned table
    const result = await owner.execute<{ table: string; rls: boolean; policies: number }>(sql`
      select c.relname as table,
             c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p
               where p.polrelid = c.oid and 'pulse_app'::regrole = any(p.polroles)) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`);

    const unprotected = result.rows.filter(
      (table) => !exceptions.includes(table.table) && (!table.rls || table.policies === 0),
    );
    expect(unprotected).toEqual([]);
    expect(result.rows.map((table) => table.table)).toEqual(
      expect.arrayContaining(['campus', ...exceptions]),
    );
  });

  it('keep views from skipping RLS (security_invoker) and materialized views away from the app', async () => {
    // A view normally runs with its owner's rights, so it would read past RLS; a materialized
    // view has no RLS at all. Both get pulse_app's SELECT through the default grant
    const result = await owner.execute<{ name: string; kind: string }>(sql`
      select c.relname as name, c.relkind::text as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        -- PostGIS's own catalog views, which read no table of ours
        and c.relname not in ('geography_columns', 'geometry_columns')
        and ((c.relkind = 'v' and not coalesce('security_invoker=true' = any(c.reloptions), false))
          or (c.relkind = 'm' and has_table_privilege('pulse_app', c.oid, 'SELECT')))
      order by 1`);
    expect(result.rows).toEqual([]);
  });

  it('store campus.location as a WGS 84 point (SRID 4326)', async () => {
    const result = await owner.execute(
      sql`select type, srid from geometry_columns where f_table_name = 'campus' and f_geometry_column = 'location'`,
    );
    expect(result.rows).toEqual([{ type: 'POINT', srid: 4326 }]);
  });

  it('match the schema’s NOT NULL columns (hand edits to generated SQL can drop one)', async () => {
    const result = await owner.execute<{ table: string; column: string }>(sql`
      select table_name as table, column_name as column
      from information_schema.columns
      where table_schema = 'public' and is_nullable = 'YES'
        and table_name in ('campus', 'outbox_event', 'processed_event')
      order by 1, 2`);
    // published_at is the only column the schema leaves nullable
    expect(result.rows).toEqual([{ table: 'outbox_event', column: 'published_at' }]);
  });

  it('turn on row-level security for campus', async () => {
    const result = await owner.execute(
      sql`select relrowsecurity from pg_class where relname = 'campus'`,
    );
    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  it('leave the app role without superuser or BYPASSRLS', async () => {
    const result = await app.execute(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(result.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('let the app role only add outbox events (reading and publishing them is the relay’s job)', async () => {
    expect(await appPrivileges('outbox_event')).toEqual({
      select: false,
      insert: true,
      update: false,
      delete: false,
    });
  });

  it('let the app role record processed events but never change or remove them', async () => {
    expect(await appPrivileges('processed_event')).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
  });

  it('let the app role read, add and change campuses but never delete one (RLS decides which rows)', async () => {
    expect(await appPrivileges('campus')).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
    });
  });

  it('keep the outbox counter away from the app (its value is the total number of events)', async () => {
    const result = await owner.execute(
      sql`select has_sequence_privilege('pulse_app', 'outbox_event_seq_seq', 'SELECT') as read,
                 has_sequence_privilege('pulse_app', 'outbox_event_seq_seq', 'USAGE') as use`,
    );
    expect(result.rows).toEqual([{ read: false, use: false }]);
  });

  it('let the app role use sequences created by later migrations', async () => {
    const result = await owner.execute(
      sql`select defaclobjtype as kind from pg_default_acl
          where array_to_string(defaclacl, ',') like '%pulse_app=%' order by kind`,
    );
    // r = tables, S = sequences
    expect(result.rows).toEqual([{ kind: 'S' }, { kind: 'r' }]);
  });

  it('leave the app role owning no table (owners skip RLS)', async () => {
    const result = await app.execute(
      sql`select count(*)::int as owned from pg_tables where tableowner = current_user`,
    );
    expect(result.rows).toEqual([{ owned: 0 }]);
  });
});
