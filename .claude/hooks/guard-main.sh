#!/bin/sh
# PreToolUse (Bash). main only changes through reviewed pull requests, so Claude may not commit,
# merge or push on main, push to main from another branch, or force-push anywhere.
# Exit code 2 blocks the command and shows the message to Claude.
cmd=$(jq -r '.tool_input.command // ""')
case "$cmd" in *git*) ;; *) exit 0 ;; esac

block() { echo "Blocked by .claude/hooks/guard-main.sh: $1" >&2; exit 2; }

if printf '%s' "$cmd" | grep -Eq 'git[^|;&]* push[^|;&]*(--force|--force-with-lease| -f( |$)| \+)'; then
  block "force push is never allowed."
fi
if printf '%s' "$cmd" | grep -Eq 'git[^|;&]* push[^|;&]*( |:)main( |$)'; then
  block "push to main is not allowed; open a pull request (/pr)."
fi
branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" branch --show-current 2>/dev/null)
if [ "$branch" = "main" ] && printf '%s' "$cmd" | grep -Eq 'git[^|;&]* (commit|merge|rebase|cherry-pick|push|reset --hard)'; then
  block "you are on main. Create a branch first: git switch -c <type>/<name>."
fi
exit 0
