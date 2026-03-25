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
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
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
    queryTaggedWorkItems: mock(() => Promise.resolve([])),
    processBug: mock(() =>
      Promise.resolve({ bugId: 0, investigated: true }),
    ),
    removeTagFromWorkItem: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('runPollCycle', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
    stateStore = new StateStore(tmpDir);
    // Simulate a non-first-run state so seeding is skipped
    stateStore.save();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('first run seeds existing items as processed without investigating', async () => {
    // Create a fresh state store (first run = no lastRunAt)
    const freshDir = mkdtempSync(join(tmpdir(), 'watcher-first-run-'));
    const freshStore = new StateStore(freshDir);
    const config = mockConfig();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([101, 102, 103])),
    });

    const result = await runPollCycle(config, freshStore, deps);

    expect(result).toEqual({ investigated: 0, skipped: 3, errors: 0 });
    expect(deps.processBug).toHaveBeenCalledTimes(0);
    expect(freshStore.isProcessed(101)).toBe(true);
    expect(freshStore.isProcessed(102)).toBe(true);
    expect(freshStore.isProcessed(103)).toBe(true);

    rmSync(freshDir, { recursive: true, force: true });
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

  test('tagged item is reinvestigated even if already processed', async () => {
    const config = mockConfig();

    // Mark bug 200 as already processed
    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200])),
      queryTaggedWorkItems: mock(() => Promise.resolve([200])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 200, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result.investigated).toBe(1);
    expect(deps.processBug).toHaveBeenCalledTimes(1);
  });

  test('tag is removed after successful reinvestigation', async () => {
    const config = mockConfig();

    stateStore.markProcessed(200);
    stateStore.save();

    const removeTagMock = mock(() => Promise.resolve());
    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200])),
      queryTaggedWorkItems: mock(() => Promise.resolve([200])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 200, investigated: true }),
      ),
      removeTagFromWorkItem: removeTagMock,
    });

    await runPollCycle(config, stateStore, deps);

    expect(removeTagMock).toHaveBeenCalledTimes(1);
    expect(removeTagMock).toHaveBeenCalledWith(config, 200, 'agent investigate');
  });

  test('tag is not removed when investigation fails', async () => {
    const config = mockConfig();

    stateStore.markProcessed(200);
    stateStore.save();

    const removeTagMock = mock(() => Promise.resolve());
    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200])),
      queryTaggedWorkItems: mock(() => Promise.resolve([200])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 200, investigated: false, error: 'AI failed' }),
      ),
      removeTagFromWorkItem: removeTagMock,
    });

    await runPollCycle(config, stateStore, deps);

    expect(removeTagMock).toHaveBeenCalledTimes(0);
  });

  test('tag removal failure does not break the cycle', async () => {
    const config = mockConfig();

    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200])),
      queryTaggedWorkItems: mock(() => Promise.resolve([200])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 200, investigated: true }),
      ),
      removeTagFromWorkItem: mock(() => Promise.reject(new Error('API error'))),
    });

    const result = await runPollCycle(config, stateStore, deps);

    // Investigation still counts as success despite tag removal failure
    expect(result.investigated).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('new items and tagged items are deduplicated', async () => {
    const config = mockConfig();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([100, 200])),
      queryTaggedWorkItems: mock(() => Promise.resolve([200])),
      processBug: mock((cfg: AppConfig, bugId: number) =>
        Promise.resolve({ bugId, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    // 100 is new, 200 is new AND tagged — should only be processed once
    expect(result.investigated).toBe(2);
    expect(deps.processBug).toHaveBeenCalledTimes(2);
  });

  test('tagged items from outside assigned-to filter are investigated', async () => {
    const config = mockConfig({ assignedToFilter: ['Alice Smith'] });

    // Regular query (filtered by assigned-to) returns nothing
    // Tag query (project-wide, no feature/assigned-to filter) finds item 300
    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([])),
      queryTaggedWorkItems: mock(() => Promise.resolve([300])),
      processBug: mock(() =>
        Promise.resolve({ bugId: 300, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result.investigated).toBe(1);
    expect(deps.processBug).toHaveBeenCalledTimes(1);
  });

  test('tagged items from outside configured features are investigated', async () => {
    const config = mockConfig({ featureWorkItemIds: [12345] });

    // Regular query only finds items under feature 12345
    // Tag query finds item 999 which is under a different feature
    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([100])),
      queryTaggedWorkItems: mock(() => Promise.resolve([999])),
      processBug: mock((cfg: AppConfig, bugId: number) =>
        Promise.resolve({ bugId, investigated: true }),
      ),
    });

    const result = await runPollCycle(config, stateStore, deps);

    expect(result.investigated).toBe(2);
    expect(deps.processBug).toHaveBeenCalledTimes(2);
  });

  test('prunes processed IDs not returned by current query', async () => {
    const config = mockConfig();

    stateStore.markProcessed(100);
    stateStore.markProcessed(200);
    stateStore.save();

    const deps = makeDeps({
      queryBugsUnderFeatures: mock(() => Promise.resolve([200, 300])),
      processBug: mock((cfg: AppConfig, bugId: number) =>
        Promise.resolve({ bugId, investigated: true }),
      ),
    });

    await runPollCycle(config, stateStore, deps);

    expect(stateStore.isProcessed(100)).toBe(false);
    expect(stateStore.isProcessed(200)).toBe(true);
    expect(stateStore.isProcessed(300)).toBe(true);
  });

});
