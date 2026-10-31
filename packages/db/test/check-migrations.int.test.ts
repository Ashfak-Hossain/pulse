import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

type Journal = { entries: { idx: number; when: number; tag: string }[] };

// Each case breaks a throwaway git copy of this package, never the real migrations folder.
// `main` holds the package as it is; the cases change the working tree on top of it
describe('check-migrations.sh', () => {
  let repo = '';

  function run(command: string, args: string[]): { status: number | null; output: string } {
    const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  function git(...args: string[]): void {
    // hooksPath: the developer's global git hooks must not run in the throwaway repo
    const config = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
    const result = run('git', [...config, '-c', 'core.hooksPath=/dev/null', ...args]);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed:\n${result.output}`);
    }
  }

  const check = () => run('sh', ['scripts/check-migrations.sh', 'main']);
  const generate = () => run('pnpm', ['exec', 'drizzle-kit', 'generate']);
  const schemaPath = () => join(repo, 'src', 'schema.ts');
  const journalPath = () => join(repo, 'migrations', 'meta', '_journal.json');

  function editSchema(from: string, to: string): void {
    const schema = readFileSync(schemaPath(), 'utf8');
    expect(schema).toContain(from);
    writeFileSync(schemaPath(), schema.replace(from, to));
  }

  function editJournal(change: (journal: Journal) => void): void {
    const journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as Journal;
    change(journal);
    writeFileSync(journalPath(), JSON.stringify(journal, null, 2));
  }

  function lastEntry(journal: Journal): Journal['entries'][number] {
    const entry = journal.entries.at(-1);
    if (!entry) {
      throw new Error('the journal has no entries');
    }
    return entry;
  }

  const addColumn = () =>
    editSchema(
      "timezone: text('timezone').notNull(),",
      "timezone: text('timezone').notNull(),\n    probe: text('probe'),",
    );

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'check-migrations-'));
    for (const path of ['src', 'migrations', 'scripts', 'drizzle.config.ts', 'package.json']) {
      cpSync(join(packageDir, path), join(repo, path), { recursive: true });
    }
    // drizzle-kit and drizzle-orm come from the real package; git ignores the link
    symlinkSync(join(packageDir, 'node_modules'), join(repo, 'node_modules'));
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('switch', '-qc', 'pr');
  });

  beforeEach(() => {
    git('checkout', '--', '.');
    git('clean', '-fdq');
  });

  afterAll(() => {
    if (repo) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes an untouched folder', () => {
    const result = check();
    expect(result.output).toContain('ok  journal matches the migration files');
    expect(result.status).toBe(0);
  });

  it('passes a schema change that comes with its generated migration', () => {
    addColumn();
    expect(generate().status).toBe(0);
    const result = check();
    expect(result.output).toContain('ok  journal matches the migration files');
    expect(result.status).toBe(0);
  });

  it('fails a schema change with no migration', () => {
    addColumn();
    const result = check();
    expect(result.output).toContain('has changes with no migration');
    expect(result.status).toBe(1);
  });

  it('fails a renamed column, which drizzle-kit cannot ask about without a terminal', () => {
    editSchema("timezone: text('timezone')", "tz: text('tz')");
    const result = check();
    expect(result.output).toContain('drizzle-kit generate did not finish');
    expect(result.status).toBe(1);
  });

  it('fails when a merged migration is edited', () => {
    appendFileSync(join(repo, 'migrations', '0002_app-privileges.sql'), '\n-- edited\n');
    const result = check();
    expect(result.output).toContain('merged migrations were changed');
    expect(result.status).toBe(1);
  });

  it('fails when a merged journal entry changes', () => {
    editJournal((journal) => {
      lastEntry(journal).when += 1;
    });
    const result = check();
    expect(result.output).toContain('is on the base branch and was changed or removed');
    expect(result.status).toBe(1);
  });

  it('fails a .sql file the journal does not list', () => {
    writeFileSync(join(repo, 'migrations', '0003_orphan.sql'), 'SELECT 1;\n');
    const result = check();
    expect(result.output).toContain('0003_orphan.sql is not in the journal');
    expect(result.status).toBe(1);
  });

  it('fails a new migration dated before the last merged one', () => {
    addColumn();
    expect(generate().status).toBe(0);
    editJournal((journal) => {
      lastEntry(journal).when = 1;
    });
    const result = check();
    expect(result.output).toContain('is not later than the one before it');
    expect(result.status).toBe(1);
  });

  it('fails a new migration dated in the future', () => {
    addColumn();
    expect(generate().status).toBe(0);
    editJournal((journal) => {
      lastEntry(journal).when = Date.now() + 2 * 24 * 60 * 60 * 1000;
    });
    const result = check();
    expect(result.output).toContain('is dated in the future');
    expect(result.status).toBe(1);
  });

  // A custom migration changes no schema, so the drift check passes and the journal check is
  // the one that has to notice
  it('fails a new migration whose snapshot is missing', () => {
    expect(run('pnpm', ['exec', 'drizzle-kit', 'generate', '--custom']).status).toBe(0);
    unlinkSync(join(repo, 'migrations', 'meta', '0003_snapshot.json'));
    const result = check();
    expect(result.output).toContain('has no meta/0003_snapshot.json');
    expect(result.status).toBe(1);
  });

  // The left-over snapshot of a migration that was half deleted: generate diffs against it, so
  // the schema change it describes passes the drift check with no migration. Only the count notices
  it('fails a snapshot the journal does not list', () => {
    addColumn();
    expect(generate().status).toBe(0);
    for (const file of readdirSync(join(repo, 'migrations'))) {
      if (file.startsWith('0003_')) {
        unlinkSync(join(repo, 'migrations', file));
      }
    }
    editJournal((journal) => {
      journal.entries.pop();
    });
    const result = check();
    expect(result.output).toContain('ok  schema and migrations agree');
    expect(result.output).toContain('meta/ holds 4 snapshots for 3 journal entries');
    expect(result.status).toBe(1);
  });
}, 120_000);
