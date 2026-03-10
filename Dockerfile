FROM oven/bun:1

WORKDIR /app

# Install git (needed to clone target repo at startup)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY . .

# State directory (mount a volume here for persistence)
VOLUME /app/.state

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
