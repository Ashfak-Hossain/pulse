#!/bin/sh
# Proves each core service answers a real request, not just that its container is running.
# Users and ports come from the running stack, so overrides in infra/compose/.env still pass.
# Run after `pnpm infra:up`: `pnpm infra:smoke`. Needs curl and jq.
set -eu

cd "$(dirname "$0")/../.."
compose="docker compose -f infra/compose/compose.yaml --profile core"

fail() {
  echo "FAIL $1" >&2
  exit 1
}

# Host address of a published container port, for example 127.0.0.1:1025
published() {
  $compose port "$1" "$2" 2>/dev/null || fail "$1: port $2 not published (is it up? pnpm infra:ps)"
}

# Single quotes on purpose: the container's shell expands its own POSTGRES_USER and POSTGRES_DB
postgis=$($compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT postgis_lib_version()"') ||
  fail "postgres: query failed (is it up? pnpm infra:ps)"
echo "ok  postgres  PostGIS $postgis"

pong=$($compose exec -T redis redis-cli ping) || fail "redis: no answer"
[ "$pong" = PONG ] || fail "redis: expected PONG, got '$pong'"
echo "ok  redis     $pong"

smtp=$(published mailpit 1025)
inbox=$(published mailpit 8025)
# Unique per run, so messages from earlier runs never make this one pass
subject="pulse-smoke-$(date +%s)-$$"
printf 'Subject: %s\r\n\r\nSmoke test.\r\n' "$subject" |
  curl -sS --url "smtp://$smtp" --mail-from smoke@pulse.local --mail-rcpt dev@pulse.local -T - ||
  fail "mailpit: SMTP send failed"
# Fetched before jq: in sh a pipeline reports only jq's exit code, which would hide a curl failure
body=$(curl -fsS --get "http://$inbox/api/v1/search" --data-urlencode "query=subject:$subject") ||
  fail "mailpit: API did not answer"
count=$(printf '%s' "$body" | jq -r '.messages_count')
[ "$count" = 1 ] || fail "mailpit: expected 1 message, found '$count'"
echo "ok  mailpit   1 message received ($subject)"
