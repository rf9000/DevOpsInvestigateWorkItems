FROM oven/bun:1

WORKDIR /app

# Install git and curl (git for target repo, curl for Claude Code install)
RUN apt-get update && apt-get install -y git curl bash && rm -rf /var/lib/apt/lists/*

# Install dependencies (as root before switching user)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY . .

# Create non-root user for Claude Code (refuses --dangerously-skip-permissions as root).
# Align claude to UID/GID 1000 so it matches the host user that owns the bind-mounted
# ~/.claude — otherwise the host (1000) and container clash over that shared dir (EACCES).
# The base oven/bun image already holds 1000 for its `bun` user, so renumber it out first.
RUN usermod -u 1100 bun && groupmod -g 1100 bun && \
    useradd -m -s /bin/bash -u 1000 -U claude && \
    chown -R claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# Install Claude Code CLI as non-root user
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

ENV PATH="/home/claude/.local/bin:$PATH"

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /home/claude/.claude

COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Start as root; entrypoint fixes volume permissions then drops to claude user
ENTRYPOINT ["/entrypoint.sh"]
