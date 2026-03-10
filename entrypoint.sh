#!/bin/bash
set -e

# Clone or update the target repo
if [ -n "$TARGET_REPO_URL" ]; then
  if [ -d "$TARGET_REPO_PATH" ]; then
    echo "Pulling latest changes in $TARGET_REPO_PATH..."
    git -C "$TARGET_REPO_PATH" pull || true
  else
    echo "Cloning $TARGET_REPO_URL to $TARGET_REPO_PATH..."
    git clone "$TARGET_REPO_URL" "$TARGET_REPO_PATH"
  fi
fi

exec bun run start
