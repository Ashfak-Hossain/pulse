import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { assertRestrictedRole, createDb, type Database } from '../src/index.js';

// Roles that row-level security does not limit, directly or through a role they can switch to.
// Each one must stop the app from starting
const unsafeRoles = {
  rc_bypass: 'has BYPASSRLS',
  rc_bypass_member: 'is a member of a BYPASSRLS role (one SET ROLE away)',
  rc_super_member: 'is a member of a superuser role',
  rc_owner: 'owns a table (owners skip RLS unless it is forced)',
  rc_member: 'is a member of a table owner, so it can act as the owner',
  rc_noinherit: 'is a NOINHERIT member of a table owner (SET ROLE still works)',
  rc_nested: 'reaches a table owner through another role',
  rc_parted_owner: 'owns a partitioned table',
} as const;

function urlAs(role: string): string {
  const url = new URL(inject('ownerUrl'));
  url.username = role;
  url.password = role;
  return url.href;
}

describe('assertRestrictedRole (the boot check the API and worker run)', () => {
  const owner = createDb(inject('ownerUrl'));
  const opened: Database[] = [];

  function connectAs(url: string): Database {
    const db = createDb(url);
    opened.push(db);
    return db;
  }

  beforeAll(async () => {
    // Own schema, so the tables never show up in the migration tests' list of public tables
    await owner.execute(sql`
      create role rc_bypass login password 'rc_bypass' nosuperuser bypassrls;
      create role rc_bypass_member login password 'rc_bypass_member' in role rc_bypass;
      create role rc_super nologin superuser;
      create role rc_super_member login password 'rc_super_member' in role rc_super;
      create role rc_owner login password 'rc_owner' nosuperuser nobypassrls;
      create role rc_member login password 'rc_member' nosuperuser nobypassrls in role rc_owner;
      create role rc_noinherit login password 'rc_noinherit' noinherit in role rc_owner;
      create role rc_nested login password 'rc_nested' in role rc_member;
      create role rc_parted_owner login password 'rc_parted_owner';
      create schema role_check;
      create table role_check.owned (id int);
      alter table role_check.owned owner to rc_owner;
      create table role_check.parted (id int) partition by range (id);
      alter table role_check.parted owner to rc_parted_owner;
    `);
  });

  afterAll(async () => {
    await Promise.all(opened.map((db) => db.$client.end()));
    // "if exists": when setup fails, cleanup must not hide its error
    await owner.execute(sql`
      drop schema if exists role_check cascade;
      drop role if exists rc_nested, rc_noinherit, rc_member, rc_owner, rc_parted_owner,
        rc_super_member, rc_super, rc_bypass_member, rc_bypass;
    `);
    await owner.$client.end();
  });

  it('lets pulse_app through: not superuser, no BYPASSRLS, owns nothing', async () => {
    await expect(assertRestrictedRole(connectAs(inject('appUrl')))).resolves.toBeUndefined();
  });

  it('stops the owner role used for migrations (a superuser)', async () => {
    await expect(assertRestrictedRole(owner)).rejects.toThrow(/row-level security/);
  });

  it.each(Object.entries(unsafeRoles))('stops %s, which %s', async (role) => {
    await expect(assertRestrictedRole(connectAs(urlAs(role)))).rejects.toThrow(
      /row-level security/,
    );
  });

  it('stops a superuser login that switched to pulse_app (RESET ROLE would switch back)', async () => {
    const url = new URL(inject('ownerUrl'));
    url.searchParams.set('options', '-c role=pulse_app');
    const switched = connectAs(url.href);
    // The setup really took effect: queries run as pulse_app, the login is still the owner
    const { rows } = await switched.execute<{ current: string; session: string }>(
      sql`select current_user as current, session_user as session`,
    );
    expect(rows[0]).toEqual({ current: 'pulse_app', session: url.username });

    await expect(assertRestrictedRole(switched)).rejects.toThrow(/row-level security/);
  });

  it('names the role but never the connection URL or password in the error', async () => {
    const error: unknown = await assertRestrictedRole(owner).catch((caught: unknown) => caught);
    const message = error instanceof Error ? error.message : '';
    const { username, password } = new URL(inject('ownerUrl'));
    expect(message).toContain(`"${username}"`);
    expect(message).not.toContain(inject('ownerUrl'));
    expect(message).not.toContain(`:${password}@`);
  });
});
