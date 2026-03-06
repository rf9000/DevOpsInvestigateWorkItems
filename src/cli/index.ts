#!/usr/bin/env bun

import { loadConfig } from '../config/index.ts';
import { startWatcher, runPollCycle } from '../services/watcher.ts';
import { StateStore } from '../state/state-store.ts';
import { processBug } from '../services/processor.ts';

const HELP = `
Bug Investigation System

Usage:
  devops-investigate <command>

Commands:
  watch            Start the long-running watcher (polls every N minutes)
  run-once         Run a single poll cycle and exit
  run-bug <id>     Investigate a single bug and post results to Azure DevOps
  test-bug <id>    Investigate a single bug (dry-run, no writes)
  reset-state      Clear the processed bug state and exit
  help             Show this help message

Options:
  --dry-run        Read-only mode: investigate but skip Azure DevOps writes

Environment variables:
  AZURE_DEVOPS_PAT            Azure DevOps personal access token (required)
  AZURE_DEVOPS_ORG            Azure DevOps organization name (required)
  AZURE_DEVOPS_PROJECT        Azure DevOps project name (required)
  FEATURE_WORK_ITEM_IDS       Comma-separated feature work item IDs (required)
  TARGET_REPO_PATH            Local path to repository to investigate (required)
  POLL_INTERVAL_MINUTES       Polling interval (default: 15)
  MAX_INVESTIGATIONS_PER_DAY  Daily investigation limit (default: 5)
  CLAUDE_MODEL                Claude model to use (default: claude-sonnet-4-6)
  PROMPT_PATH                 Path to prompt file (default: .claude/commands/do-process-item.md)
  SKILLS_DIR                  Path to skill .md files (default: .claude/commands)
  STATE_DIR                   State directory (default: .state)
`.trim();

const command = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

switch (command) {
  case 'watch': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made to Azure DevOps\n');
    await startWatcher(config);
    break;
  }

  case 'run-once': {
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made to Azure DevOps\n');
    const stateStore = new StateStore(config.stateDir);
    const result = await runPollCycle(config, stateStore);
    console.log(`Done: ${result.investigated} investigated, ${result.skipped} skipped, ${result.errors} errors`);
    break;
  }

  case 'run-bug': {
    const bugIdArg = process.argv[3];
    if (!bugIdArg || isNaN(Number(bugIdArg))) {
      console.error('Usage: devops-investigate run-bug <bug-id>');
      process.exitCode = 1;
      break;
    }
    const config = loadConfig();
    config.dryRun = dryRun;
    if (dryRun) console.log('[DRY RUN] No writes will be made to Azure DevOps\n');
    console.log(`Investigating Bug #${bugIdArg}...\n`);
    const result = await processBug(config, Number(bugIdArg));
    if (result.investigated) {
      console.log(`\nDone: Bug #${bugIdArg} investigated successfully`);
    } else {
      console.log(`\nFailed: ${result.error}`);
      process.exitCode = 1;
    }
    break;
  }

  case 'test-bug': {
    const bugIdArg = process.argv[3];
    if (!bugIdArg || isNaN(Number(bugIdArg))) {
      console.error('Usage: devops-investigate test-bug <bug-id>');
      process.exitCode = 1;
      break;
    }
    const config = loadConfig();
    config.dryRun = true;
    console.log(`[DRY RUN] Investigating Bug #${bugIdArg}\n`);
    const result = await processBug(config, Number(bugIdArg));
    if (result.investigated) {
      console.log(`\nDone: Bug #${bugIdArg} investigated successfully`);
    } else {
      console.log(`\nFailed: ${result.error}`);
      process.exitCode = 1;
    }
    break;
  }

  case 'reset-state': {
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    stateStore.reset();
    console.log('State has been reset');
    break;
  }

  case 'help':
  default:
    console.log(HELP);
    break;
}
