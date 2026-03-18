import type {
  AppConfig,
  BugProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';

export interface WatcherDeps {
  queryBugsUnderFeatures: (
    config: AppConfig,
    featureIds: number[],
  ) => Promise<number[]>;

  queryTaggedBugsUnderFeatures: (
    config: AppConfig,
    featureIds: number[],
    tag: string,
  ) => Promise<number[]>;

  processBug: (
    config: AppConfig,
    bugId: number,
  ) => Promise<BugProcessResult>;

  removeTagFromWorkItem: (
    config: AppConfig,
    workItemId: number,
    tagToRemove: string,
  ) => Promise<void>;
}

const defaultDeps: WatcherDeps = {
  queryBugsUnderFeatures: sdk.queryBugsUnderFeatures,
  queryTaggedBugsUnderFeatures: sdk.queryTaggedBugsUnderFeatures,
  processBug: proc.processBug,
  removeTagFromWorkItem: sdk.removeTagFromWorkItem,
};

function log(message: string): void {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
): Promise<{ investigated: number; skipped: number; errors: number }> {
  // 1. On first run, seed existing items as already processed
  if (stateStore.isFirstRun) {
    log('First run detected — seeding existing work items as already processed...');
    const existingIds = await deps.queryBugsUnderFeatures(config, config.featureWorkItemIds);
    for (const id of existingIds) {
      stateStore.markProcessed(id);
    }
    stateStore.save();
    log(`Seeded ${existingIds.length} existing work items. Future runs will only process new items.`);
    return { investigated: 0, skipped: existingIds.length, errors: 0 };
  }

  // 2. Query all open work items under feature IDs
  log(`Querying work items under feature IDs: ${config.featureWorkItemIds.join(', ')}...`);
  const bugIds = await deps.queryBugsUnderFeatures(config, config.featureWorkItemIds);
  const newBugIds = bugIds.filter((id) => !stateStore.isProcessed(id));

  // 3. Query for tagged items (bypasses assigned-to filter and processed state)
  let taggedBugIds: number[] = [];
  if (config.reinvestigateTag) {
    taggedBugIds = await deps.queryTaggedBugsUnderFeatures(
      config, config.featureWorkItemIds, config.reinvestigateTag,
    );
  }
  const taggedSet = new Set(taggedBugIds);

  // Merge new items + tagged items (deduplicated)
  const toInvestigate = [...new Set([...newBugIds, ...taggedBugIds])];

  log(`Found ${bugIds.length} work items, ${newBugIds.length} new, ${taggedBugIds.length} tagged for reinvestigation, ${bugIds.length - newBugIds.length} already processed`);

  let investigated = 0;
  let skipped = 0;
  let errors = 0;

  for (const bugId of toInvestigate) {
    // 4. Check daily limit
    if (!stateStore.canInvestigateToday(config.maxInvestigationsPerDay)) {
      log(`Daily investigation limit reached (${config.maxInvestigationsPerDay}). Skipping remaining bugs.`);
      skipped += toInvestigate.length - (investigated + errors);
      break;
    }

    try {
      const result = await deps.processBug(config, bugId);

      if (result.investigated) {
        stateStore.markProcessed(bugId);
        stateStore.incrementDailyCount();
        investigated++;

        // Remove reinvestigation tag after successful investigation
        if (taggedSet.has(bugId)) {
          try {
            await deps.removeTagFromWorkItem(config, bugId, config.reinvestigateTag);
            log(`Bug #${bugId}: Removed "${config.reinvestigateTag}" tag`);
          } catch (tagErr) {
            log(`Bug #${bugId}: Warning — failed to remove tag: ${tagErr}`);
          }
        }
      } else {
        errors++;
      }
    } catch (err) {
      log(`Bug #${bugId}: Fatal error — ${err}`);
      errors++;
    }
  }

  const allKnownIds = [...new Set([...bugIds, ...taggedBugIds])];
  stateStore.pruneProcessed(allKnownIds);
  stateStore.save();
  return { investigated, skipped, errors };
}

function sleep(ms: number, signal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = 1000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (signal.aborted || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
}

export async function startWatcher(config: AppConfig): Promise<void> {
  const stateStore = new StateStore(config.stateDir);
  const signal = { aborted: false };

  const shutdown = () => {
    log('Shutting down...');
    signal.aborted = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Starting watcher — polling every ${config.pollIntervalMinutes} minutes`);
  log(`Watching feature IDs: ${config.featureWorkItemIds.join(', ')}`);
  log(`${stateStore.processedCount} bugs already processed`);
  log(`Max ${config.maxInvestigationsPerDay} investigations per day`);

  while (!signal.aborted) {
    try {
      const result = await runPollCycle(config, stateStore);
      log(`Cycle complete: ${result.investigated} investigated, ${result.skipped} skipped, ${result.errors} errors`);
    } catch (err) {
      log(`Cycle failed: ${err}`);
    }

    if (!signal.aborted) {
      log(`Sleeping ${config.pollIntervalMinutes} minutes...`);
      await sleep(config.pollIntervalMinutes * 60 * 1000, signal);
    }
  }

  log('Watcher stopped');
}
