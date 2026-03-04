import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppConfig } from '../../src/types/index.ts';
import { runPollCycle } from '../../src/services/watcher.ts';
import type { WatcherDeps } from '../../src/services/watcher.ts';
import { StateStore } from '../../src/state/state-store.ts';

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    featureWorkItemIds: [12345],
    targetRepoPath: 'C:/repos/my-repo',
    maxInvestigationsPerDay: 5,
    skillsDir: '.claude/commands',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    queryBugsUnderFeatures: mock(() => Promise.resolve([])),
    processBug: mock(() =>
      Promise.resolve({ bugId: 0, investigated: true }),
    ),
    shouldPullRepo: mock(() => false),
    pullRepo: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('runPollCycle', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
    stateStore = new StateStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('no new bugs returns all zeros', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ investigated: 0, skipped: 0, errors: 0 });
    expect(deps.queryBugsUnderFeatures).toHaveBeenCalledTimes(1);
    expect(deps.processBug).toHaveBeenCalledTimes(0);
  });

  test('new bug found calls processBug, marks as processed, and saves state', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([101])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 101, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ investigated: 1, skipped: 0, errors: 0 });
    expect(deps.processBug).toHaveBeenCalledTimes(1);
    expect(stateStore.isProcessed(101)).toBe(true);

    const reloadedStore = new StateStore(tmpDir);
    expect(reloadedStore.isProcessed(101)).toBe(true);
  });

  test('already processed bug is filtered out', async () => {
    const config = mockConfig();

    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200])),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ investigated: 0, skipped: 0, errors: 0 });
    expect(deps.processBug).toHaveBeenCalledTimes(0);
  });

  test('processBug throws: bug not marked as processed, error counted', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([300])),
      processBug: mock(() => Promise.reject(new Error('Fatal processing error'))),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ investigated: 0, skipped: 0, errors: 1 });
    expect(stateStore.isProcessed(300)).toBe(false);
  });

  test('bug with investigation failure is not marked as processed', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([400])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 400, investigated: false, error: 'AI failed' }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result).toEqual({ investigated: 0, skipped: 0, errors: 1 });
    expect(stateStore.isProcessed(400)).toBe(false);
  });

  test('daily limit stops processing remaining bugs', async () => {
    const config = mockConfig({ maxInvestigationsPerDay: 2 });

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([501, 502, 503, 504])),
      processBug: mock((cfg: AppConfig, bugId: number) =>
        Promise.resolve({ bugId, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result.investigated).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.errors).toBe(0);
    expect(deps.processBug).toHaveBeenCalledTimes(2);
    expect(stateStore.isProcessed(501)).toBe(true);
    expect(stateStore.isProcessed(502)).toBe(true);
    expect(stateStore.isProcessed(503)).toBe(false);
  });

  test('repo pull is triggered when shouldPullRepo returns true', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      shouldPullRepo: mock(() => true),
      pullRepo: mock(() => Promise.resolve()),
      queryBugsUnderFeatures: mock(() => Promise.resolve([])),
    });

    await runPollCycle(config, stateStore, deps);

    expect(deps.pullRepo).toHaveBeenCalledTimes(1);
  });

  test('repo pull is skipped when shouldPullRepo returns false', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      shouldPullRepo: mock(() => false),
      pullRepo: mock(() => Promise.resolve()),
      queryBugsUnderFeatures: mock(() => Promise.resolve([])),
    });

    await runPollCycle(config, stateStore, deps);

    expect(deps.pullRepo).toHaveBeenCalledTimes(0);
  });

  test('repo pull failure does not prevent bug processing', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      shouldPullRepo: mock(() => true),
      pullRepo: mock(() => Promise.reject(new Error('git pull failed'))),
      queryBugsUnderFeatures: mock(() => Promise.resolve([601])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 601, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result.investigated).toBe(1);
    expect(stateStore.isProcessed(601)).toBe(true);
  });
});
