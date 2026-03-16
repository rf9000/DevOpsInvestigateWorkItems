#!/bin/bash
set -e

# Fix ownership of mounted volumes (they mount as root)
if [ "$(id -u)" = "0" ]; then
  chown -R claude:claude /app/.state
  chown -R claude:claude /home/claude/.claude 2>/dev/null || true

  # Clone or update the target repo as claude user
  if [ -n "$TARGET_REPO_URL" ]; then
    if [ -d "$TARGET_REPO_PATH/.git" ]; then
      echo "Pulling latest changes in $TARGET_REPO_PATH..."
      su claude -c "git -C \"$TARGET_REPO_PATH\" pull" || true
    else
      echo "Cloning $TARGET_REPO_URL to $TARGET_REPO_PATH..."
      su claude -c "git clone \"$TARGET_REPO_URL\" \"$TARGET_REPO_PATH\""
    fi
  fi

  exec su claude -c "export HOME=/home/claude && cd /app && bun run start"
fi

exec bun run start
