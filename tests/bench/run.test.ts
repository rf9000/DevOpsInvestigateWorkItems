import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import type { BenchCase } from '../../src/bench/collect.ts';
import { runBench } from '../../src/bench/run.ts';
import type { BenchRow, RunDeps, VariantFn } from '../../src/bench/run.ts';
import { createSpendTracker } from '../../src/services/spend-tracker.ts';

function mockConfig(): AppConfig {
  return {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 'x',
    featureWorkItemIds: [1], targetRepoPath: 'C:/repos/banking', maxInvestigationsPerDay: 5,
    assignedToFilter: [], reinvestigateTag: 'agent investigate', pollIntervalMinutes: 5,
    claudeModel: 'claude-opus-5-5', promptPath: './prompt.md', stateDir: '.state',
    costLogPath: '.state/cost-ledger.jsonl', dryRun: false,
  };
}

const cases: BenchCase[] = [
  { id: 1, title: 'one', source: 'pr', baseCommit: 'c1', fixFiles: ['/app/A.al'], fixLinks: ['pr:1'] },
  { id: 2, title: 'two', source: 'commit', baseCommit: 'c2', fixFiles: ['/app/B.al', '/app/C.al'], fixLinks: ['commit:x'] },
];

function variant(usd: number, refs: string[], seen: AppConfig[] = []): VariantFn {
  return mock(async (config: AppConfig) => {
    seen.push(config);
    const spend = createSpendTracker();
    spend.add('investigate', {
      usd, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      turns: 3, models: ['m'],
    });
    return { outcome: 'completed' as const, markdown: 'md', codeRefs: refs, spend };
  });
}

function makeDeps(variants: Record<string, VariantFn>, rows: BenchRow[] = []): RunDeps & { disposed: string[] } {
  const disposed: string[] = [];
  let t = 0;
  return {
    variants,
    createWorktree: mock(async (commit: string) => ({
      path: `/wt/${commit}`,
      dispose: async () => { disposed.push(commit); },
    })),
    appendRow: (row) => { rows.push(row); },
    now: () => (t += 1000),
    disposed,
  };
}

describe('runBench', () => {
  test('runs every case x repeat x variant in a pre-fix worktree, dry run, and scores it', async () => {
    const seen: AppConfig[] = [];
    const rows: BenchRow[] = [];
    const deps = makeDeps({ legacy: variant(1, ['app/a.al', 'app/b.al'], seen), triage: variant(0.5, []) }, rows);

    const result = await runBench(mockConfig(), cases, { variants: ['legacy', 'triage'], repeat: 2, runId: 'r1' }, deps);

    expect(result.rows).toHaveLength(8);
    expect(rows).toHaveLength(8);
    expect(result.stoppedForBudget).toBe(false);
    expect(deps.createWorktree).toHaveBeenCalledTimes(2);
    expect(deps.disposed).toEqual(['c1', 'c2']);
    expect(seen[0]!.targetRepoPath).toBe('/wt/c1');
    expect(seen[0]!.dryRun).toBe(true);

    const legacy2 = result.rows.find((r) => r.variant === 'legacy' && r.caseId === 2)!;
    expect(legacy2.fileRecall).toBe(0.5);
    expect(legacy2.costUsd).toBe(1);
    expect(legacy2.turns).toBe(3);
    expect(legacy2.durationMs).toBe(1000);
    expect(legacy2.runId).toBe('r1');
    expect(legacy2.scored).toBe(true);
  });

  test('stops before the next run once the budget is spent', async () => {
    const deps = makeDeps({ legacy: variant(2, []) });

    const result = await runBench(mockConfig(), cases, { variants: ['legacy'], repeat: 1, maxUsd: 1.5, runId: 'r' }, deps);

    expect(result.rows).toHaveLength(1);
    expect(result.stoppedForBudget).toBe(true);
    expect(deps.disposed).toEqual(['c1']);
  });

  test('records a variant that throws as a failed row and keeps going', async () => {
    const boom: VariantFn = mock(async () => { throw new Error('agent crashed'); });
    const deps = makeDeps({ legacy: boom });

    const result = await runBench(mockConfig(), cases, { variants: ['legacy'], repeat: 1, runId: 'r' }, deps);

    expect(result.rows.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(result.rows[0]!.error).toBe('agent crashed');
  });

  test('records a case whose worktree cannot be created as failed rows', async () => {
    const deps = makeDeps({ legacy: variant(1, []) });
    deps.createWorktree = mock(async () => { throw new Error('bad commit'); });

    const result = await runBench(mockConfig(), cases.slice(0, 1), { variants: ['legacy'], repeat: 2, runId: 'r' }, deps);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.error).toContain('bad commit');
  });

  test('rejects unknown variants up front', async () => {
    const deps = makeDeps({ legacy: variant(1, []) });
    await expect(runBench(mockConfig(), cases, { variants: ['nope'], repeat: 1, runId: 'r' }, deps)).rejects.toThrow('nope');
  });
});
