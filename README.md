# DevOps Investigate Work Items

Automatically investigates new bugs under Azure DevOps feature work items using Claude AI and posts findings as work item comments.

## How it works

1. Polls Azure DevOps for bug work items linked under configured feature IDs
2. Tracks which bugs have already been processed (JSON state file)
3. For each new bug, sends the title, description, and repro steps to a Claude agent
4. The Claude agent investigates the bug against a local codebase using Read, Grep, Glob, and Bash tools
5. Posts the investigation result as a comment on the Azure DevOps work item

On first run, existing bugs are seeded as already-processed so only new bugs are investigated.

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
| `TARGET_REPO_PATH` | Local path to the repository for Claude to investigate |

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

The service runs on an Azure VM using Docker Compose. The container clones the target repo, polls Azure DevOps, and runs Claude Code investigations automatically.

### Prerequisites

- SSH access to the VM
- A Claude Code team subscription (for OAuth authentication)

### Initial Setup

1. SSH into the VM:
   ```bash
   ssh -i "vm-devops-automation_key.pem" azureuser@<VM_IP>
   ```

2. Navigate to the team directory:
   ```bash
   cd ~/teams/<team-name>
   ```

3. Install Claude Code CLI on the **VM host** (not inside Docker):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   source ~/.bashrc
   ```

4. Authenticate Claude Code. The VM has no browser, so use an extended timeout to give yourself time to complete the OAuth flow:
   ```bash
   ANTHROPIC_AUTH_TIMEOUT=300000 claude auth login
   ```
   - Copy the URL it shows and open it in your local browser
   - Sign in and authorize
   - Paste the code back into the VM terminal when prompted

5. Configure `.env.investigate` with your Azure DevOps settings.

6. Ensure `docker-compose.yml` bind-mounts the host credentials into the container:
   ```yaml
   volumes:
     - /home/azureuser/.claude:/home/claude/.claude
   ```

7. Build and start:
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

### Deploying Changes

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

### Architecture Notes

- The container starts as **root** to fix volume permissions, then drops to a non-root `claude` user via the entrypoint
- Claude Code refuses `--dangerously-skip-permissions` (used by the Agent SDK) when running as root, which is why the non-root user is required
- The target repo is cloned into `/repo` inside the container on startup
- State (processed bugs) is persisted via a Docker volume at `/app/.state`

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
