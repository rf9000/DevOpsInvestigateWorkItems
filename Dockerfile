FROM oven/bun:1

WORKDIR /app

# Install git and curl (git for target repo, curl for Claude Code install)
RUN apt-get update && apt-get install -y git curl bash && rm -rf /var/lib/apt/lists/*

# Create non-root user for Claude Code (refuses --dangerously-skip-permissions as root).
# Align claude to UID/GID 1000 so it matches the host user that owns the bind-mounted
# ~/.claude — otherwise the host (1000) and container clash over that shared dir (EACCES).
# The base oven/bun image already holds 1000 for its `bun` user, so renumber it out first.
# Created before anything lands in /app, and /app is handed over while still empty: a
# `chown -R /app` after the install rewrites every file into a new layer and stores
# node_modules twice.
RUN usermod -u 1100 bun && groupmod -g 1100 bun && \
    useradd -m -s /bin/bash -u 1000 -U claude && \
    chown claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# Install Claude Code CLI as non-root user. Before the dependency install, so a
# lockfile or source change does not rebuild this layer.
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install dependencies as claude, so the files are born with the right owner.
# The SDK's platform packages (claude-agent-sdk-linux-x64, -linux-x64-musl) each
# bundle a full Claude Code binary. Sessions run the CLI installed above
# (CLAUDE_CODE_EXECUTABLE_PATH, see src/services/agent-runner.ts), so those copies
# are removed in the same RUN, together with Bun's download cache, or the layer
# keeps them.
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile \
    && find node_modules -maxdepth 3 -type d -name 'claude-agent-sdk-*' -prune -exec rm -rf {} + \
    && bun pm cache rm \
    && test -d node_modules/@anthropic-ai/claude-agent-sdk

# Copy application source
COPY --chown=claude:claude . .
USER root

# CLAUDE_CODE_EXECUTABLE_PATH: the Claude Code binary every session runs. The SDK's
# own bundled binaries are removed above, so it is required.
ENV PATH="/home/claude/.local/bin:$PATH" \
    CLAUDE_CODE_EXECUTABLE_PATH=/home/claude/.local/bin/claude

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /home/claude/.claude

COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Start as root; entrypoint fixes volume permissions then drops to claude user
ENTRYPOINT ["/entrypoint.sh"]
