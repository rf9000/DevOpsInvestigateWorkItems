#!/bin/bash
set -e

# Fix ownership of mounted volumes (they mount as root)
if [ "$(id -u)" = "0" ]; then
  chown -R claude:claude /app/.state
  chown -R claude:claude /home/claude/.claude 2>/dev/null || true

  # Verify the target repo is mounted
  if [ -n "$TARGET_REPO_PATH" ] && [ ! -d "$TARGET_REPO_PATH/.git" ]; then
    echo "ERROR: Target repo not found at $TARGET_REPO_PATH"
    echo "Mount the repo from the host, e.g.: ~/repos/<repo-name>:$TARGET_REPO_PATH:ro"
    exit 1
  fi

  exec su claude -c "export HOME=/home/claude && cd /app && bun run start"
fi

exec bun run start
