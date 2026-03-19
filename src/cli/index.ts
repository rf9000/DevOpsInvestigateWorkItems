#!/usr/bin/env bun

import { loadConfig } from '../config/index.ts';
import { startWatcher, runPollCycle } from '../services/watcher.ts';
import { StateStore } from '../state/state-store.ts';
import { processBug } from '../services/processor.ts';
import * as sdk from '../sdk/azure-devops-client.ts';

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
  PROMPT_PATH                 Path to prompt file (default: src/prompts/investigate-bug.md)
  REINVESTIGATE_TAG           Tag that triggers reinvestigation (default: agent investigate)
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

  case 'debug-tags': {
    const config = loadConfig();
    const stateStore = new StateStore(config.stateDir);
    console.log(`=== Debug Tag Detection ===`);
    console.log(`reinvestigateTag: "${config.reinvestigateTag}"`);
    console.log(`featureIds: ${config.featureWorkItemIds.join(', ')}`);
    console.log(`assignedToFilter: ${config.assignedToFilter.length ? config.assignedToFilter.join(', ') : '(none)'}`);
    console.log();

    // Step 1: Regular query (with assigned-to filter)
    console.log(`--- Step 1: Regular WIQL query (with assigned-to filter) ---`);
    const bugIds = await sdk.queryBugsUnderFeatures(config, config.featureWorkItemIds);
    console.log(`Returned ${bugIds.length} work item IDs: ${bugIds.join(', ') || '(none)'}`);
    const newBugIds = bugIds.filter((id) => !stateStore.isProcessed(id));
    const processedBugIds = bugIds.filter((id) => stateStore.isProcessed(id));
    console.log(`  New (unprocessed): ${newBugIds.join(', ') || '(none)'}`);
    console.log(`  Already processed: ${processedBugIds.join(', ') || '(none)'}`);
    console.log();

    // Step 2: Tag query — WIQL without assigned-to filter
    console.log(`--- Step 2: Tag WIQL query (no assigned-to filter) ---`);
    const idList = config.featureWorkItemIds.join(',');
    const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${idList}) AND [Target].[System.WorkItemType] IN ('Bug', 'User Story') AND [Target].[System.State] NOT IN ('Resolved', 'Closed', 'Removed') MODE (MustContain)`;
    console.log(`WIQL: ${wiql}`);
    const wiqlData = await sdk.adoFetchWithRetry<{ workItemRelations: Array<{ target?: { id: number } }> }>(
      config, 'wit/wiql?api-version=7.0', { method: 'POST', body: JSON.stringify({ query: wiql }) },
    );
    const featureIdSet = new Set(config.featureWorkItemIds);
    const allIds: number[] = [];
    for (const rel of wiqlData.workItemRelations ?? []) {
      if (rel.target?.id && !featureIdSet.has(rel.target.id)) {
        allIds.push(rel.target.id);
      }
    }
    const uniqueIds = [...new Set(allIds)];
    console.log(`Returned ${uniqueIds.length} work item IDs: ${uniqueIds.join(', ') || '(none)'}`);
    console.log();

    // Step 3: Batch-fetch tags
    if (uniqueIds.length > 0) {
      console.log(`--- Step 3: Batch-fetch System.Tags ---`);
      const ids = uniqueIds.join(',');
      const tagsPath = `wit/workitems?ids=${ids}&fields=System.Tags&api-version=7.0`;
      console.log(`GET ${tagsPath}`);
      const tagsData = await sdk.adoFetchWithRetry<{ value: Array<{ id: number; fields: Record<string, unknown> }> }>(
        config, tagsPath,
      );
      const tagLower = config.reinvestigateTag.toLowerCase();
      console.log();
      console.log(`Work item tags:`);
      for (const item of tagsData.value ?? []) {
        const rawTags = item.fields['System.Tags'];
        const tagsStr = String(rawTags ?? '');
        const parsedTags = tagsStr.split(';').map((t) => t.trim()).filter((t) => t.length > 0);
        const hasTag = parsedTags.some((t) => t.toLowerCase() === tagLower);
        const processed = stateStore.isProcessed(item.id);
        console.log(`  #${item.id}: raw="${rawTags}" parsed=[${parsedTags.map(t => `"${t}"`).join(', ')}] hasTag=${hasTag} processed=${processed}`);
      }
      console.log();

      // Step 4: What queryTaggedBugsUnderFeatures would return
      console.log(`--- Step 4: queryTaggedBugsUnderFeatures result ---`);
      const taggedIds = await sdk.queryTaggedBugsUnderFeatures(config, config.featureWorkItemIds, config.reinvestigateTag);
      console.log(`Tagged IDs: ${taggedIds.join(', ') || '(none)'}`);
      console.log();

      // Step 5: What toInvestigate would be
      const toInvestigate = [...new Set([...newBugIds, ...taggedIds])];
      const taggedSet = new Set(taggedIds);
      console.log(`--- Step 5: Merge result ---`);
      console.log(`toInvestigate: ${toInvestigate.join(', ') || '(none)'}`);
      for (const id of toInvestigate) {
        console.log(`  #${id}: new=${newBugIds.includes(id)} tagged=${taggedSet.has(id)} → willRemoveTag=${taggedSet.has(id)}`);
      }
    } else {
      console.log(`No work items found under features — nothing to check.`);
    }
    break;
  }

  case 'help':
  default:
    console.log(HELP);
    break;
}
