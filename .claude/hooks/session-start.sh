#!/bin/sh
# SessionStart. Prints a 5-line orientation (branch, running/next slices, "Now" from the private
# progress board) so every session starts in context without reading big files.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
echo "Pulse · branch $(git branch --show-current) · $(git status --short | wc -l | tr -d ' ') uncommitted changes"
[ -f notes/slices.md ] && grep -E '\| (running|next|blocked) ' notes/slices.md | cut -d'|' -f2-6 | sed 's/  */ /g'
[ -f notes/progress.md ] && sed -n '/^## Now/,/^## /p' notes/progress.md | grep '^- '
echo "Run /prime for the full briefing."
exit 0
