#!/usr/bin/env bash
# SessionStart: make every Bash tool call use the Node version pinned in .nvmrc,
# and tell the agent when Docker (Colima) is not running.
# Bash commands source $CLAUDE_ENV_FILE before running; stdout here is shown to the agent.

project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
want="$(tr -d '[:space:]' < "$project/.nvmrc" 2>/dev/null)"
nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"

if [ -n "$want" ] && [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -s "$nvm_sh" ]; then
  # shellcheck disable=SC1090
  . "$nvm_sh" --no-use >/dev/null 2>&1
  if node_bin="$(nvm which "$want" 2>/dev/null)" && [ -x "$node_bin" ]; then
    echo "export PATH=\"$(dirname "$node_bin"):\$PATH\"" >> "$CLAUDE_ENV_FILE"
  else
    echo "Node $want (from .nvmrc) is not installed. Ask the user to run: nvm install $want"
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, so integration tests and compose will fail. Ask the user to run: colima start"
fi
exit 0
