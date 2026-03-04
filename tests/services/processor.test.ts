import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import { processBug } from '../../src/services/processor.ts';
import type { ProcessorDeps } from '../../src/services/processor.ts';

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    featureWorkItemIds: [12345],
    targetRepoPath: 'C:/repos/my-repo',
    maxInvestigationsPerDay: 5,
    skillsDir: '.claude/commands',
    assignedToFilter: [],
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function makeDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    getWorkItem: mock(() =>
      Promise.resolve({
        id: 100,
        fields: {
          'System.Title': 'Login crashes on expired token',
          'System.Description': 'The login page crashes.',
          'Microsoft.VSTS.TCM.ReproSteps': '1. Login\n2. Wait\n3. Crash',
        },
        rev: 1,
        url: 'https://example.com/100',
      }),
    ),
    investigateBug: mock(() => Promise.resolve('### Bug Validity\nYes\n\n### Root Cause\nToken validation missing.')),
    addWorkItemComment: mock(() => Promise.resolve({ id: 1, text: 'comment' })),
    loadSkills: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

describe('processBug', () => {
  test('successful investigation returns investigated=true', async () => {
    const config = mockConfig();
    const deps = makeDeps();

    const result = await processBug(config, 100, deps);

    expect(result).toEqual({ bugId: 100, investigated: true });
    expect(deps.getWorkItem).toHaveBeenCalledTimes(1);
    expect(deps.investigateBug).toHaveBeenCalledTimes(1);
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(deps.loadSkills).toHaveBeenCalledTimes(1);
  });

  test('investigation failure returns investigated=false with error', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      investigateBug: mock(() =>
        Promise.reject(new Error('Claude API error')),
      ),
    });

    const result = await processBug(config, 100, deps);

    expect(result.bugId).toBe(100);
    expect(result.investigated).toBe(false);
    expect(result.error).toContain('Claude API error');
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(0);
  });

  test('getWorkItem failure returns investigated=false with error', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      getWorkItem: mock(() =>
        Promise.reject(new Error('Work item not found')),
      ),
    });

    const result = await processBug(config, 999, deps);

    expect(result.bugId).toBe(999);
    expect(result.investigated).toBe(false);
    expect(result.error).toContain('Work item not found');
    expect(deps.investigateBug).toHaveBeenCalledTimes(0);
  });

  test('dry run investigates but does not post comment', async () => {
    const config = { ...mockConfig(), dryRun: true };
    const deps = makeDeps();

    const result = await processBug(config, 100, deps);

    expect(result).toEqual({ bugId: 100, investigated: true });
    expect(deps.investigateBug).toHaveBeenCalledTimes(1);
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(0);
  });

  test('passes correct context to investigateBug', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    expect(investigateMock).toHaveBeenCalledTimes(1);
    const context = investigateMock.mock.calls[0]![1] as {
      bugTitle: string;
      bugDescription: string;
      bugReproSteps: string;
    };
    expect(context.bugTitle).toBe('Login crashes on expired token');
    expect(context.bugDescription).toBe('The login page crashes.');
    expect(context.bugReproSteps).toBe('1. Login\n2. Wait\n3. Crash');
  });

  test('loads skills and passes them to investigation context', async () => {
    const config = mockConfig();
    const skills = [{ name: 'test-skill', content: 'skill content' }];
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      loadSkills: mock(() => Promise.resolve(skills)),
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    expect(investigateMock).toHaveBeenCalledTimes(1);
    const context = investigateMock.mock.calls[0]![1] as { skills: typeof skills };
    expect(context.skills).toEqual(skills);
  });
});
