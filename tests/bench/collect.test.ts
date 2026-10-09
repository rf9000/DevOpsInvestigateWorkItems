import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig, WorkItemResponse } from '../../src/types/index.ts';
import { parseArtifactLink, repoNameFromRemote, collectCases } from '../../src/bench/collect.ts';
import type { CollectDeps } from '../../src/bench/collect.ts';

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'pat',
    featureWorkItemIds: [1],
    targetRepoPath: 'C:/repos/banking',
    maxInvestigationsPerDay: 5,
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-opus-5-5',
    promptPath: './prompt.md',
    stateDir: '.state',
    costLogPath: '.state/cost-ledger.jsonl',
    dryRun: false,
    pipelineVariant: 'legacy',
    triageModel: 'claude-sonnet-5-5',
    triagePromptPath: './triage.md',
    deepPromptPath: './deep.md',
  };
}

describe('parseArtifactLink', () => {
  test('parses a pull request link', () => {
    expect(parseArtifactLink('vstfs:///Git/PullRequestId/proj-1%2Frepo-1%2F42')).toEqual({
      kind: 'pr', project: 'proj-1', repoId: 'repo-1', ref: '42',
    });
  });

  test('parses a commit link', () => {
    expect(parseArtifactLink('vstfs:///Git/Commit/proj-1%2Frepo-1%2Fabc123')).toEqual({
      kind: 'commit', project: 'proj-1', repoId: 'repo-1', ref: 'abc123',
    });
  });

  test('accepts lowercase %2f separators, as ADO writes some commit links', () => {
    expect(parseArtifactLink('vstfs:///Git/Commit/proj-1%2frepo-1%2fabc123')).toEqual({
      kind: 'commit', project: 'proj-1', repoId: 'repo-1', ref: 'abc123',
    });
  });

  test('returns null for other artifact links', () => {
    expect(parseArtifactLink('vstfs:///Build/Build/123')).toBeNull();
    expect(parseArtifactLink('vstfs:///Git/Ref/proj%2Frepo%2FGBmain')).toBeNull();
  });
});

describe('repoNameFromRemote', () => {
  test('handles https, ssh and visualstudio.com remotes', () => {
    expect(repoNameFromRemote('https://my-org@dev.azure.com/my-org/Proj/_git/Continia%20Banking')).toBe('Continia Banking');
    expect(repoNameFromRemote('git@ssh.dev.azure.com:v3/my-org/Proj/Continia%20Banking')).toBe('Continia Banking');
    expect(repoNameFromRemote('https://my-org.visualstudio.com/Proj/_git/banking.git')).toBe('banking');
  });

  test('returns null for an unrecognised remote', () => {
    expect(repoNameFromRemote('')).toBeNull();
  });
});

function item(id: number, changed: string, relations: string[]): WorkItemResponse {
  return {
    id,
    rev: 1,
    url: '',
    fields: { 'System.Title': `Bug ${id}`, 'System.ChangedDate': changed },
    relations: relations.map((url) => ({ rel: 'ArtifactLink', url })),
  };
}

function makeDeps(overrides: Partial<CollectDeps> = {}): CollectDeps {
  return {
    queryClosedBugs: mock(() => Promise.resolve([10, 11, 12, 13])),
    // Like the API: only the requested ids come back, in no particular order.
    getItems: mock((_c: AppConfig, ids: number[]) => Promise.resolve([
      item(10, '2026-01-01', ['vstfs:///Git/PullRequestId/p%2Frepo-bank%2F5']),
      item(11, '2026-03-01', ['vstfs:///Git/Commit/p%2Frepo-bank%2Fsha11', 'vstfs:///Git/Commit/p%2Frepo-bank%2Fsha11b']),
      item(12, '2026-02-01', ['vstfs:///Git/Commit/p%2Frepo-other%2Fsha12']),
      item(13, '2026-04-01', []),
    ].filter((i) => ids.includes(i.id)))),
    getRepositoryName: mock((_p: string, repoId: string) =>
      Promise.resolve(repoId === 'repo-bank' ? 'Continia Banking' : 'Other')),
    getPullRequestBase: mock(() => Promise.resolve('base5')),
    getPullRequestFiles: mock(() => Promise.resolve(['/app/A.al'])),
    getCommitFiles: mock((_p: string, _r: string, sha: string) =>
      Promise.resolve(sha === 'sha11' ? ['/app/B.al'] : ['/app/B.al', '/app/C.al'])),
    resolveCommit: mock((ref: string) => Promise.resolve(ref === 'sha11^' ? 'parent11' : ref === 'base5' ? 'base5' : null)),
    ...overrides,
  };
}

describe('collectCases', () => {
  test('keeps bugs with fix links in the target repo, newest first, with unioned files', async () => {
    const deps = makeDeps();

    const { cases, skipped } = await collectCases(mockConfig(), { limit: 10, repoName: 'continia banking' }, deps);

    expect(cases).toEqual([
      { id: 11, title: 'Bug 11', source: 'commit', baseCommit: 'parent11', fixFiles: ['/app/B.al', '/app/C.al'], fixLinks: ['commit:sha11', 'commit:sha11b'] },
      { id: 10, title: 'Bug 10', source: 'pr', baseCommit: 'base5', fixFiles: ['/app/A.al'], fixLinks: ['pr:5'] },
    ]);
    expect(skipped.map((s) => s.id).sort()).toEqual([12, 13]);
  });

  test('stops at the limit', async () => {
    const { cases } = await collectCases(mockConfig(), { limit: 1, repoName: 'Continia Banking' }, makeDeps());
    expect(cases.map((c) => c.id)).toEqual([11]);
  });

  test('skips a case whose base commit is not in the local repo', async () => {
    const deps = makeDeps({ resolveCommit: mock(() => Promise.resolve(null)) });

    const { cases, skipped } = await collectCases(mockConfig(), { limit: 10, repoName: 'Continia Banking' }, deps);

    expect(cases).toEqual([]);
    expect(skipped.find((s) => s.id === 11)?.reason).toContain('not found locally');
  });

  test('with explicit ids, keeps their order and turns unlinked items into unscored HEAD cases', async () => {
    const deps = makeDeps({
      resolveCommit: mock((ref: string) => Promise.resolve(ref === 'HEAD' ? 'head-sha' : ref === 'base5' ? 'base5' : null)),
    });

    const { cases } = await collectCases(mockConfig(), { limit: 10, repoName: 'Continia Banking', ids: [13, 10] }, deps);

    expect(deps.queryClosedBugs).not.toHaveBeenCalled();
    expect(cases.map((c) => [c.id, c.source, c.baseCommit])).toEqual([[13, 'none', 'head-sha'], [10, 'pr', 'base5']]);
    expect(cases[0]!.fixFiles).toEqual([]);
  });

  test('takes the base from a PR link even when a commit link is listed first', async () => {
    const deps = makeDeps({
      getItems: mock(() => Promise.resolve([
        item(20, '2026-05-01', [
          'vstfs:///Git/Commit/p%2frepo-bank%2flatecommit',
          'vstfs:///Git/PullRequestId/p%2Frepo-bank%2F5',
        ]),
      ])),
      resolveCommit: mock((ref: string) => Promise.resolve(ref)),
    });

    const { cases } = await collectCases(mockConfig(), { limit: 10, repoName: 'Continia Banking', ids: [20] }, deps);

    expect(cases[0]!.source).toBe('pr');
    expect(cases[0]!.baseCommit).toBe('base5');
  });
});
