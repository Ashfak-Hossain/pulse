#!/bin/sh
# PostToolUse (Edit, Write, MultiEdit). Formats just the file Claude changed with the repo's
# Prettier, so the pre-commit format:check never fails because of Claude. Never blocks.
f=$(jq -r '.tool_input.file_path // ""')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
prettier="$root/node_modules/.bin/prettier"
case "$f" in "$root"/*) ;; *) exit 0 ;; esac
[ -f "$f" ] && [ -x "$prettier" ] || exit 0
cd "$root" && "$prettier" --write --ignore-unknown --log-level silent "$f" >/dev/null 2>&1
exit 0
