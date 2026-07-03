import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendValidationLog } from '../../src/state/validation-log.ts';
import type { AppConfig, ValidationLogEntry } from '../../src/types/index.ts';

function mockConfig(stateDir: string): AppConfig {
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
    claudeMaxTurns: 40,
    promptPath: './prompt.md',
    stateDir,
    dryRun: false,
  };
}

function entry(bugId: number): ValidationLogEntry {
  return {
    bugId,
    timestamp: '2026-07-03T00:00:00.000Z',
    verdictA: {
      isValid: 'yes',
      rootCauseSummary: 'x',
      primaryCitation: { file: 'a.ts' },
      suggestedFixSummary: 'y',
      confidence: 'high',
    },
    verdictB: {
      isValid: 'yes',
      rootCauseSummary: 'x',
      primaryCitation: { file: 'a.ts' },
      suggestedFixSummary: 'y',
      confidence: 'high',
    },
    judgeResult: { agree: true, reason: 'match' },
    tieBreakUsed: false,
    finalPass: 'A',
  };
}

describe('appendValidationLog', () => {
  test('creates the state directory and writes one JSON line', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'validation-log-test-'));
    const config = mockConfig(stateDir);

    appendValidationLog(config, entry(100));

    const contents = readFileSync(join(stateDir, 'validation-log.jsonl'), 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry(100));
  });

  test('appends subsequent entries rather than overwriting', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'validation-log-test-'));
    const config = mockConfig(stateDir);

    appendValidationLog(config, entry(100));
    appendValidationLog(config, entry(101));

    const contents = readFileSync(join(stateDir, 'validation-log.jsonl'), 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).bugId).toBe(101);
  });
});
