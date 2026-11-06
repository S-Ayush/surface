#!/usr/bin/env bash
# PreToolUse(Edit|Write): committed migrations are immutable (they may already be
# applied in someone's database). Exit 2 blocks the edit and tells the agent why.

project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$file" ] || exit 0
rel="${file#"$project"/}"

case "$rel" in
  apps/server/migrations/*.sql) ;;
  *) exit 0 ;;
esac

if git -C "$project" cat-file -e "HEAD:$rel" 2>/dev/null; then
  echo "Blocked: $rel is already committed. Applied migrations must never change. Change the Drizzle schema and generate a new migration instead (see .claude/rules/database.md)." >&2
  exit 2
fi
exit 0
