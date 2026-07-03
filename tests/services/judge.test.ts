import { describe, test, expect } from 'bun:test';
import { buildJudgePrompt } from '../../src/services/judge.ts';
import type { InvestigationVerdict } from '../../src/types/index.ts';

function verdict(overrides: Partial<InvestigationVerdict> = {}): InvestigationVerdict {
  return {
    isValid: 'yes',
    rootCauseSummary: 'Missing null check in auth.ts',
    primaryCitation: { file: 'src/auth.ts', line: 42 },
    suggestedFixSummary: 'Add a guard clause before dereferencing the token.',
    confidence: 'high',
    ...overrides,
  };
}

describe('buildJudgePrompt', () => {
  test('includes both verdicts', () => {
    const a = verdict();
    const b = verdict({ isValid: 'no' });
    const prompt = buildJudgePrompt(a, b);
    expect(prompt).toContain('auth.ts');
    expect(prompt).toContain('"isValid": "yes"');
    expect(prompt).toContain('"isValid": "no"');
  });

  test('asks whether the verdicts agree', () => {
    const prompt = buildJudgePrompt(verdict(), verdict());
    expect(prompt.toLowerCase()).toContain('agree');
  });
});
