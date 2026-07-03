import { describe, test, expect, mock } from 'bun:test';
import { runInvestigation } from '../../src/services/investigation-orchestrator.ts';
import type { OrchestratorDeps } from '../../src/services/investigation-orchestrator.ts';
import type { AppConfig, InvestigationVerdict, JudgeResult } from '../../src/types/index.ts';
import type { InvestigationContext } from '../../src/services/investigator.ts';

function mockConfig(): AppConfig {
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
    claudeModel: 'claude-sonnet-5',
    claudeJudgeModel: 'claude-haiku-4-5',
    claudeTiebreakModel: 'claude-opus-4-8',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function mockContext(): InvestigationContext {
  return {
    bugTitle: 'Login crashes',
    bugDescription: 'desc',
    bugReproSteps: 'steps',
    discoveredSkills: [],
    images: [],
  };
}

function verdict(overrides: Partial<InvestigationVerdict> = {}): InvestigationVerdict {
  return {
    isValid: 'yes',
    rootCauseSummary: 'Missing null check',
    primaryCitation: { file: 'src/auth.ts', line: 42 },
    suggestedFixSummary: 'Add a guard clause',
    confidence: 'high',
    ...overrides,
  };
}

describe('runInvestigation', () => {
  test('agreement: posts pass A report, no tiebreak', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: true, reason: 'match' }));
    const appendValidationLog = mock((..._args: unknown[]) => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug).toHaveBeenCalledTimes(2);
    expect(judgeVerdicts).toHaveBeenCalledTimes(1);
    expect(result).toBe('report from claude-sonnet-5');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(false);
    expect(logEntry.finalPass).toBe('A');
  });

  test('disagreement resolved by tiebreak agreeing with pass B', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    let judgeCall = 0;
    const judgeVerdicts = mock((): Promise<JudgeResult> => {
      judgeCall++;
      // 1st call: A vs B -> disagree. 2nd call: A vs tiebreak -> disagree. 3rd call: B vs tiebreak -> agree.
      if (judgeCall === 3) return Promise.resolve({ agree: true, reason: 'tiebreak matches B' });
      return Promise.resolve({ agree: false, reason: 'mismatch' });
    });
    const appendValidationLog = mock((..._args: unknown[]) => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug).toHaveBeenCalledTimes(3);
    expect(investigateBug.mock.calls[2]![2]).toBe('claude-opus-4-8');
    expect(judgeVerdicts).toHaveBeenCalledTimes(3);
    // Tiebreak agreed with pass B, so pass B's own report is posted (both
    // passes run on config.claudeModel, which mockConfig() sets to
    // 'claude-sonnet-5') — not the tiebreak's report.
    expect(result).toBe('report from claude-sonnet-5');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(true);
    expect(logEntry.finalPass).toBe('B');
  });

  test('true 3-way split posts the tiebreak (Opus) report', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: false, reason: 'all differ' }));
    const appendValidationLog = mock((..._args: unknown[]) => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(result).toBe('report from claude-opus-4-8');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(true);
    expect(logEntry.finalPass).toBe('tiebreak');
  });

  test('pass A and pass B both run on config.claudeModel', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: true, reason: 'match' }));
    const appendValidationLog = mock((..._args: unknown[]) => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug.mock.calls[0]![2]).toBe('claude-sonnet-5');
    expect(investigateBug.mock.calls[1]![2]).toBe('claude-sonnet-5');
  });

  test('agreement: appendValidationLog throwing does not block returning the report', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: true, reason: 'match' }));
    const appendValidationLog = mock((..._args: unknown[]) => {
      throw new Error('disk full');
    });

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(result).toBe('report from claude-sonnet-5');
    expect(appendValidationLog).toHaveBeenCalledTimes(1);
  });

  test('tiebreak: appendValidationLog throwing does not block returning the report', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: false, reason: 'all differ' }));
    const appendValidationLog = mock((..._args: unknown[]) => {
      throw new Error('disk full');
    });

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(result).toBe('report from claude-opus-4-8');
    expect(appendValidationLog).toHaveBeenCalledTimes(1);
  });
});
