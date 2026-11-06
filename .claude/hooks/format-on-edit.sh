#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the edited file with the repo's Prettier config,
# so edits always match `pnpm format:check`. Never blocks.

project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"

[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in "$project"/*) ;; *) exit 0 ;; esac
case "$file" in
  */node_modules/*|*/dist/*) exit 0 ;;
  *.ts|*.tsx|*.js|*.cjs|*.mjs|*.json|*.css|*.md|*.yaml|*.yml|*.html) ;;
  *) exit 0 ;;
esac

prettier="$project/node_modules/.bin/prettier"
[ -x "$prettier" ] || exit 0
# Run from the root so .prettierignore (e.g. docs/) is respected.
cd "$project" && "$prettier" --write --ignore-unknown --log-level silent "$file" >/dev/null 2>&1
exit 0
