// Part of check-migrations.sh: checks migrations/meta/_journal.json against the base branch's copy
// and against the files on disk. drizzle's migrator runs exactly the journal's entries, in order,
// and only those whose `when` is later than the last one a database applied, so a wrong journal
// silently skips migrations instead of failing.
// Usage: node scripts/check-journal.ts <base-journal.json> <migrations-dir>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = { idx: number; when: number; tag: string };

// A laptop clock that runs ahead would write a `when` that blocks every later migration until
// real time catches up; a day covers any honest time zone or clock drift
const futureLimitMs = 24 * 60 * 60 * 1000;

function readEntries(path: string): Entry[] {
  const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: Entry[] };
  return journal.entries;
}

function check(base: Entry[], head: Entry[], dir: string, now: number): string[] {
  const problems: string[] = [];

  base.forEach((entry, i) => {
    if (JSON.stringify(entry) !== JSON.stringify(head[i])) {
      problems.push(`entry ${i} (${entry.tag}) is on the base branch and was changed or removed`);
    }
  });

  head.forEach((entry, i) => {
    const prefix = `${String(i).padStart(4, '0')}_`;
    if (entry.idx !== i || !entry.tag.startsWith(prefix)) {
      problems.push(`entry ${i} (${entry.tag}) should have idx ${i} and a tag starting ${prefix}`);
    }
    const previous = head[i - 1];
    if (previous && entry.when <= previous.when) {
      problems.push(`entry ${i} (${entry.tag}) is not later than the one before it`);
    }
    if (i >= base.length && entry.when > now + futureLimitMs) {
      problems.push(`entry ${i} (${entry.tag}) is dated in the future: check your clock`);
    }
    if (!existsSync(join(dir, 'meta', `${prefix}snapshot.json`))) {
      problems.push(`entry ${i} (${entry.tag}) has no meta/${prefix}snapshot.json`);
    }
  });

  // A .sql file the journal does not list is never applied, and nothing else would notice
  const tags = new Set(head.map((entry) => entry.tag));
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    if (!tags.has(file.slice(0, -'.sql'.length))) {
      problems.push(`${file} is not in the journal, so it would never run`);
    }
  }
  // A snapshot the journal does not list would become generate's "latest" and could hide drift
  const snapshots = readdirSync(join(dir, 'meta')).filter((name) =>
    name.endsWith('_snapshot.json'),
  );
  if (snapshots.length !== head.length) {
    problems.push(`meta/ holds ${snapshots.length} snapshots for ${head.length} journal entries`);
  }
  for (const tag of tags) {
    if (!existsSync(join(dir, `${tag}.sql`))) {
      problems.push(`the journal lists ${tag}, but ${tag}.sql is missing`);
    }
  }
  return problems;
}

const [basePath, dir] = process.argv.slice(2);
if (!basePath || !dir) {
  console.error('usage: node scripts/check-journal.ts <base-journal.json> <migrations-dir>');
  process.exit(2);
}
const problems = check(
  readEntries(basePath),
  readEntries(join(dir, 'meta', '_journal.json')),
  dir,
  Date.now(),
);
for (const problem of problems) {
  console.error(problem);
}
process.exit(problems.length === 0 ? 0 : 1);
