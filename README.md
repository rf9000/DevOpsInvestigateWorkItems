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
