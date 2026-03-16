# DevOps Investigate Work Items

Automatically investigates new bugs under Azure DevOps feature work items using Claude AI and posts findings as work item comments.

## How it works

1. Polls Azure DevOps for bug work items linked under configured feature IDs
2. Tracks which bugs have already been processed (JSON state file)
3. For each new bug, sends the title, description, and repro steps to a Claude agent
4. The Claude agent investigates the bug against a local codebase using Read, Grep, Glob, and Bash tools
5. Posts the investigation result as a comment on the Azure DevOps work item

On first run, existing bugs are seeded as already-processed so only new bugs are investigated.

## Architecture

```
                          ┌───────────────┐
                          │  Azure DevOps │
                          │  (bugs, PRs)  │
                          └───────┬───────┘
                                  │ REST API
                                  │
┌─────────────────────────────────┼───────────────────────────────┐
│  Azure VM (Ubuntu)              │                               │
│                                 │                               │
│  ~/repos/                       │    ~/teams/<team>/            │
│  ┌──────────────────┐           │    ┌──────────────────────┐   │
│  │ continia-banking/│           │    │ docker-compose.yml   │   │
│  │ other-repo/      │           │    │ .env.investigate     │   │
│  └────────┬─────────┘           │    │ DevOpsInvestigate    │   │
│           │                     │    │   WorkItems/         │   │
│           │ bind mount (:ro)    │    └──────────┬───────────┘   │
│           │                     │               │ build         │
│  ┌────────┼─────────────────────┼───────────────┼─────────┐    │
│  │  Docker Container            │               │         │    │
│  │        │                     │               │         │    │
│  │        ▼                     ▼               ▼         │    │
│  │   /repo            ┌─────────────────┐  /app           │    │
│  │   (read-only)      │    Watcher      │  (service)      │    │
│  │        │           │  poll ► fetch ► │                  │    │
│  │        │           │  investigate ►  │                  │    │
│  │        │           │  post comment   │                  │    │
│  │        │           └────────┬────────┘                  │    │
│  │        │                    │                           │    │
│  │        │                    ▼                           │    │
│  │        │           ┌────────────────┐                   │    │
│  │        └──────────►│  Claude Agent  │                   │    │
│  │                    │  (reads code,  │                   │    │
│  │                    │   finds bugs)  │                   │    │
│  │                    └────────────────┘                   │    │
│  │                                                        │    │
│  │   /app/.state (Docker volume)                          │    │
│  │   /home/claude/.claude (bind mount from ~/.claude)     │    │
│  └────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

The service runs as a Docker container on an Azure VM. Target repositories are cloned once on the VM host under `~/repos/` and bind-mounted read-only into containers. This allows multiple services to share the same repo, makes repos browsable via WinSCP/SSH, and avoids duplicate clones.

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```
2. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `AZURE_DEVOPS_PAT` | Azure DevOps personal access token |
| `AZURE_DEVOPS_ORG` | Azure DevOps organization name |
| `AZURE_DEVOPS_PROJECT` | Azure DevOps project name |
| `FEATURE_WORK_ITEM_IDS` | Comma-separated feature work item IDs to watch |
| `TARGET_REPO_PATH` | Path to the target repository (mounted from host in Docker, local path otherwise) |

### Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MINUTES` | 15 | Polling interval in minutes |
| `MAX_INVESTIGATIONS_PER_DAY` | 5 | Daily investigation limit |
| `CLAUDE_MODEL` | claude-sonnet-4-6 | Claude model to use |
| `PROMPT_PATH` | .claude/commands/do-process-item.md | Path to the investigation prompt |
| `SKILLS_DIR` | .claude/commands | Directory containing skill `.md` files loaded into the agent |
| `ASSIGNED_TO_FILTER` | *(all)* | Comma-separated names to filter bugs by assignee |
| `STATE_DIR` | .state | State file directory |

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start the watcher (polls every N minutes) |
| `bun run once` | Run a single poll cycle and exit |
| `bun run run-bug -- <id>` | Investigate a single bug and post results to Azure DevOps |
| `bun src/cli/index.ts test-bug <id>` | Investigate a single bug in dry-run mode |
| `bun src/cli/index.ts reset-state` | Clear processed bug state |
| `bun test` | Run all tests |
| `bun run typecheck` | TypeScript type checking |

Add `--dry-run` to `watch`, `run-once`, or `run-bug` to skip writing comments to Azure DevOps.

## VM Deployment (Docker)

The service runs on an Azure VM using Docker Compose. Target repos are cloned on the VM host under `~/repos/` and mounted into containers as volumes. This allows multiple services to share the same repo, makes repos browsable via tools like WinSCP, and avoids duplicate clones.

### Prerequisites

- SSH access to the VM
- A Claude Code team subscription (for OAuth authentication)

### Directory Structure

```
~/repos/                         # Shared repos (cloned once, used by any service)
  continia-banking/
  other-repo/
~/teams/                         # Per-team service deployments
  continia-banking/
    docker-compose.yml
    .env.investigate
    DevOpsInvestigateWorkItems/  # This repo (cloned)
```

### Initial Setup

1. SSH into the VM:
   ```bash
   ssh -i "vm-devops-automation_key.pem" azureuser@<VM_IP>
   ```

2. Clone the target repo to the shared repos directory:
   ```bash
   mkdir -p ~/repos
   git clone <target-repo-url> ~/repos/<repo-name>
   ```

3. Navigate to the team directory:
   ```bash
   cd ~/teams/<team-name>
   ```

4. Install Claude Code CLI on the **VM host** (not inside Docker):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   source ~/.bashrc
   ```

5. Authenticate Claude Code. The VM has no browser, so use an extended timeout to give yourself time to complete the OAuth flow:
   ```bash
   ANTHROPIC_AUTH_TIMEOUT=300000 claude auth login
   ```
   - Copy the URL it shows and open it in your local browser
   - Sign in and authorize
   - Paste the code back into the VM terminal when prompted

6. Configure `.env.investigate` with your Azure DevOps settings.

7. Ensure `docker-compose.yml` mounts the shared repo and host credentials into the container:
   ```yaml
   volumes:
     - /home/azureuser/.claude:/home/claude/.claude
     - /home/azureuser/repos/<repo-name>:/repo:ro
   ```

8. Build and start:
   ```bash
   docker compose build --no-cache investigate-work-items
   docker compose up -d
   ```

### Common Commands

| Command | Description |
|---------|-------------|
| `docker compose logs -f investigate-work-items` | Follow live logs |
| `docker compose restart investigate-work-items` | Restart the service |
| `docker compose exec investigate-work-items bash` | Shell into the container |
| `docker compose exec investigate-work-items claude -p "hello"` | Test Claude Code inside container |
| `docker compose down && docker compose up -d` | Recreate containers |
| `docker compose build --no-cache investigate-work-items && docker compose up -d` | Full rebuild and restart |

### Updating the Target Repo

The target repo is cloned on the host and mounted read-only. To update it:

```bash
cd ~/repos/<repo-name>
git pull
```

No container restart needed — the mount reflects the latest files immediately.

### Deploying Service Changes

```bash
cd ~/teams/<team-name>/DevOpsInvestigateWorkItems
git pull
cd ..
docker compose build --no-cache investigate-work-items
docker compose up -d
```

### Re-authenticating Claude Code

If investigations start failing with "Claude Code process exited with code 1", the OAuth token may have expired. Re-authenticate on the VM host:

```bash
ANTHROPIC_AUTH_TIMEOUT=300000 claude auth login
```

Then restart the container:

```bash
docker compose restart investigate-work-items
```

### Troubleshooting

**"Claude Code process exited with code 1" with no other details**
- Most likely an expired OAuth token. Re-authenticate on the VM host (see above).
- Run `docker compose exec investigate-work-items claude -p "hello"` to test Claude Code directly.

**"--dangerously-skip-permissions cannot be used with root/sudo privileges"**
- The Agent SDK requires this flag, but Claude Code blocks it for root. The Dockerfile must create a non-root user and the entrypoint must drop privileges before running the app.

**"EACCES: permission denied, open" from the Agent SDK**
- Bind-mounted volumes retain host file ownership. The entrypoint must `chown -R claude:claude` on mounted directories (`/app/.state`, `/home/claude/.claude`).
- Also check that `HOME` is set correctly when using `su` — without a login shell, `HOME` stays as `/root`.

**Install script fails with syntax error or installs silently fail**
- The Claude Code install script requires `bash`, not `sh`. Use `curl -fsSL https://claude.ai/install.sh | bash`.
- After install, `~/.local/bin` must be added to `PATH`.

**OAuth login times out on the VM**
- Use `ANTHROPIC_AUTH_TIMEOUT=300000 claude auth login` to extend the timeout to 5 minutes.
- Open the auth URL on your local PC's browser, authorize, and paste the code back into the VM terminal.
- The default 15-second timeout is too short for manual copy-paste flow on headless VMs.

### Architecture Notes

- The container starts as **root** to fix volume permissions, then drops to a non-root `claude` user via the entrypoint
- Claude Code refuses `--dangerously-skip-permissions` (used by the Agent SDK) when running as root, which is why the non-root user is required
- The entrypoint runs `chown -R` on mounted volumes before dropping privileges, since bind mounts retain host uid/gid
- The target repo is mounted from the host (`~/repos/<name>:/repo:ro`), not cloned inside the container
- State (processed bugs) is persisted via a Docker volume at `/app/.state`
- Claude auth is bind-mounted from the VM host (`/home/azureuser/.claude:/home/claude/.claude`)

## Project structure

```
src/
  cli/index.ts                  CLI entry point (watch, run-once, run-bug, test-bug, reset-state)
  config/index.ts               Zod-based environment variable validation
  sdk/azure-devops-client.ts    Azure DevOps REST API client with retry
  services/
    watcher.ts                  Polling loop with graceful shutdown
    processor.ts                Fetches bug details and orchestrates investigation
    investigator.ts             Claude Agent SDK integration
    skill-loader.ts             Loads .md skill files for the agent
  state/state-store.ts          JSON-based state persistence with daily limits
  types/index.ts                Shared TypeScript interfaces
tests/                          Mirrors src/ structure
```
