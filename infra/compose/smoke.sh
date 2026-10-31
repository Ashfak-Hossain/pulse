#!/bin/sh
# Proves each core and events service answers a real request, not just that its container is
# running.
# Users and ports come from the running stack, so overrides in infra/compose/.env still pass.
# Run after `pnpm infra:up`: `pnpm infra:smoke`. Needs curl and jq. The first run downloads the
# Kafka CLI image (about 700 MB on disk), so it takes a while once.
set -eu

cd "$(dirname "$0")/../.."
compose="docker compose -f infra/compose/compose.yaml --profile core --profile events"

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

# The CLI image is large (about 700 MB on disk): pull it with visible progress the first time, so a
# slow first run does not look like a hang
cli_image=$($compose config --images kafka-cli)
docker image inspect "$cli_image" >/dev/null 2>&1 || $compose pull kafka-cli ||
  fail "kafka: could not pull $cli_image"

# A throwaway topic and consumer group per run, deleted on the way out (even after a failure), so
# records from earlier runs never make this one pass. The broker image has no tools, so the CLI
# runs in its own container on the Compose network. Topic and value go in as arguments ($1, $2),
# never pasted into the script text. --progress quiet hides Compose's container lines but keeps
# real errors visible.
topic="pulse-smoke-$(date +%s)-$$"
value="smoke-$$"
record=$($compose --progress quiet run --rm -T kafka-cli sh -c '
  set -e
  topic=$1
  cleanup() {
    kafka-consumer-groups.sh --bootstrap-server kafka:19092 --delete --group "$topic" \
      >/dev/null 2>&1 || true
    kafka-topics.sh --bootstrap-server kafka:19092 --delete --topic "$topic" 2>/dev/null || true
  }
  trap cleanup EXIT
  # Several partitions, so the key really decides where the record goes
  kafka-topics.sh --bootstrap-server kafka:19092 --create --topic "$topic" --partitions 3 \
    --replication-factor 1 >/dev/null
  printf "campus-1\t%s\n" "$2" | kafka-console-producer.sh --bootstrap-server kafka:19092 \
    --topic "$topic" --reader-property parse.key=true --command-property acks=all
  # Its stderr is only a "Processed 1 messages" line; a missing record shows up in the check below
  kafka-console-consumer.sh --bootstrap-server kafka:19092 --topic "$topic" --group "$topic" \
    --from-beginning --max-messages 1 --timeout-ms 20000 --formatter-property print.partition=true \
    --formatter-property print.key=true 2>/dev/null || true' sh "$topic" "$value") ||
  fail "kafka: round trip failed, see the error above (is it up? pnpm infra:ps)"
tab=$(printf '\t')
case "$record" in
  "Partition:"*"${tab}campus-1${tab}${value}") ;;
  *) fail "kafka: expected key campus-1 and value $value, got '$record'" ;;
esac
partition=${record#Partition:}
echo "ok  kafka     keyed record back from partition ${partition%%"$tab"*} ($topic)"
