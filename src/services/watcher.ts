import type {
  AppConfig,
  BugProcessResult,
} from '../types/index.ts';
import { StateStore } from '../state/state-store.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as proc from './processor.ts';
import * as repoSync from './repo-sync.ts';

export interface WatcherDeps {
  queryBugsUnderFeatures: (
    config: AppConfig,
    featureIds: number[],
  ) => Promise<number[]>;

  processBug: (
    config: AppConfig,
    bugId: number,
  ) => Promise<BugProcessResult>;

  shouldPullRepo: (lastPullAt: string | null) => boolean;

  pullRepo: (repoPath: string) => Promise<void>;
}

const defaultDeps: WatcherDeps = {
  queryBugsUnderFeatures: sdk.queryBugsUnderFeatures,
  processBug: proc.processBug,
  shouldPullRepo: repoSync.shouldPullRepo,
  pullRepo: repoSync.pullRepo,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export async function runPollCycle(
  config: AppConfig,
  stateStore: StateStore,
  deps: WatcherDeps = defaultDeps,
): Promise<{ investigated: number; skipped: number; errors: number }> {
  // 1. Check if repo needs pulling
  if (deps.shouldPullRepo(stateStore.getLastRepoPullAt())) {
    try {
      await deps.pullRepo(config.targetRepoPath);
      stateStore.markRepoPulled();
    } catch (err) {
      log(`Warning: repo pull failed — ${err}`);
    }
  }

  // 2. Query bugs under feature IDs
  log(`Querying bugs under feature IDs: ${config.featureWorkItemIds.join(', ')}...`);
  const bugIds = await deps.queryBugsUnderFeatures(config, config.featureWorkItemIds);
  const newBugIds = bugIds.filter((id) => !stateStore.isProcessed(id));

  log(`Found ${bugIds.length} bugs, ${newBugIds.length} unprocessed`);

  let investigated = 0;
  let skipped = 0;
  let errors = 0;

  for (const bugId of newBugIds) {
    // 3. Check daily limit
    if (!stateStore.canInvestigateToday(config.maxInvestigationsPerDay)) {
      log(`Daily investigation limit reached (${config.maxInvestigationsPerDay}). Skipping remaining bugs.`);
      skipped += newBugIds.length - (investigated + errors);
      break;
    }

    try {
      const result = await deps.processBug(config, bugId);

      if (result.investigated) {
        stateStore.markProcessed(bugId);
        stateStore.incrementDailyCount();
        investigated++;
      } else {
        errors++;
      }
    } catch (err) {
      log(`Bug #${bugId}: Fatal error — ${err}`);
      errors++;
    }
  }

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
