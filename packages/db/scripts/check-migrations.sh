#!/bin/sh
# Checks the migrations before a PR merges. CI runs it; run it yourself before pushing:
#   git fetch origin main && pnpm --filter @pulse/db db:check
#  1. drift: src/schema.ts and migrations/ agree, so no `db:generate` was forgotten
#  2. migrations already on the base branch are unchanged: a database that applied one never
#     runs it again, so an edit would silently reach only fresh databases
#  3. the journal only grows at the end, in time order, and lists every .sql file exactly once
#     (scripts/check-journal.ts)
# Usage: check-migrations.sh [base-ref]   (default origin/main)
set -eu

cd "$(dirname "$0")/.."
base_ref=${1:-origin/main}
# A DRIZZLE_OUT left in the shell would point drizzle-kit check at the wrong folder
unset DRIZZLE_OUT

fail() {
  echo "FAIL $1" >&2
  exit 1
}

# printf, not echo: dash's echo turns the backslashes in drizzle-kit's SQL and JSON into escapes
show() {
  printf '%s\n' "$1" >&2
}

# drizzle-kit prefixes './' to an absolute out path, so the scratch folder must be relative.
# node_modules is ignored by git, so a leftover folder never shows up as a change
mkdir -p node_modules/.cache
scratch=$(mktemp -d node_modules/.cache/check-migrations.XXXXXX)
trap 'rm -rf "$scratch"' EXIT

# 1. Drift. `check` fails on broken or colliding snapshots; it only warns about `when` order,
# which is why step 3 checks that itself
out=$(pnpm exec drizzle-kit check 2>&1) || {
  show "$out"
  fail "drizzle-kit check: the migrations folder is inconsistent"
}
# Generate into a copy with the real config (DRIZZLE_OUT moves its out folder), so this check
# never writes to migrations/. </dev/null: a question drizzle-kit would ask goes unanswered
cp -R migrations "$scratch/migrations"
out=$(DRIZZLE_OUT="$scratch/migrations" pnpm exec drizzle-kit generate </dev/null 2>&1) || {
  show "$out"
  fail "drizzle-kit generate failed"
}
new=$(diff -rq migrations "$scratch/migrations") || {
  show "$new"
  fail "src/schema.ts has changes with no migration: run pnpm --filter @pulse/db db:generate"
}
# drizzle-kit catches its own errors and still exits 0. A rename or drop needs an answer it
# cannot get here, so it writes nothing: only this exact line proves it compared and found nothing
case $out in
  *'No schema changes, nothing to migrate'*) ;;
  *)
    show "$out"
    fail "drizzle-kit generate did not finish (a rename or drop asks a question): run pnpm --filter @pulse/db db:generate"
    ;;
esac
echo "ok  schema and migrations agree"

# 2. Merged migrations unchanged
git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null ||
  fail "base '$base_ref' is not in this clone (locally: git fetch origin main)"
base=$(git merge-base "$base_ref" HEAD) ||
  fail "no history shared with '$base_ref' (a shallow clone? git fetch --unshallow)"
# Compared with the working tree, so uncommitted edits count too. Pathspecs are relative to here
edited=$(git diff --name-only --diff-filter=MDRT "$base" -- 'migrations/*.sql' \
  'migrations/meta/*_snapshot.json')
[ -z "$edited" ] || {
  show "$edited"
  fail "merged migrations were changed: undo that, change src/schema.ts and run db:generate"
}
echo "ok  merged migrations unchanged"

# 3. The journal
git show "$base:./migrations/meta/_journal.json" >"$scratch/base-journal.json"
node scripts/check-journal.ts "$scratch/base-journal.json" migrations ||
  fail "the journal is wrong: regenerate your migration on top of main (git rebase, then db:generate)"
echo "ok  journal matches the migration files"
