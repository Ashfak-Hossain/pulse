#!/bin/sh
# PreToolUse (Edit, Write, MultiEdit). Stops Claude from writing files that must not change:
# env files (secrets), the member's private scratch notes, and migrations already on main.
f=$(jq -r '.tool_input.file_path // ""')
[ -n "$f" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

block() { echo "Blocked by .claude/hooks/guard-files.sh: $1" >&2; exit 2; }

case "$(basename "$f")" in
  .env.example) ;;
  .env | .env.*) block "env files hold secrets; edit .env.example instead." ;;
esac
case "$f" in
  */notes/scratch/*) block "notes/scratch/ belongs to the member; Claude never edits it." ;;
  */packages/db/migrations/*)
    rel=${f#"$root"/}
    if git -C "$root" cat-file -e "main:$rel" 2>/dev/null; then
      block "$rel is already applied on main. Change the schema and run db:generate for a new migration."
    fi
    ;;
esac
exit 0
