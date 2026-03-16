FROM oven/bun:1

WORKDIR /app

# Install git and curl (git for target repo, curl for Claude Code install)
RUN apt-get update && apt-get install -y git curl bash && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (needed by @anthropic-ai/claude-agent-sdk)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY . .

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /root/.claude

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
