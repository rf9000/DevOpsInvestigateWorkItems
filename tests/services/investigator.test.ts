import { describe, test, expect } from 'bun:test';
import { buildUserPrompt, buildSystemPrompt } from '../../src/services/investigator.ts';
import type { InvestigationContext } from '../../src/services/investigator.ts';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('buildUserPrompt', () => {
  const baseContext: InvestigationContext = {
    bugTitle: 'Login fails with expired token',
    bugDescription: 'When a user has an expired JWT token, the login page crashes instead of redirecting to the auth page.',
    bugReproSteps: '1. Login with valid credentials\n2. Wait for token to expire\n3. Try to access dashboard',
    skills: [],
  };

  test('includes bug title', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Title:** Login fails with expired token');
  });

  test('includes bug description when present', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Description:**');
    expect(prompt).toContain('expired JWT token');
  });

  test('omits description when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, bugDescription: '' });
    expect(prompt).not.toContain('**Description:**');
  });

  test('includes repro steps when present', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('**Reproduction Steps:**');
    expect(prompt).toContain('Wait for token to expire');
  });

  test('omits repro steps when empty', () => {
    const prompt = buildUserPrompt({ ...baseContext, bugReproSteps: '' });
    expect(prompt).not.toContain('**Reproduction Steps:**');
  });

  test('includes Bug Report header', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).toContain('## Bug Report');
  });

  test('sections appear in correct order', () => {
    const prompt = buildUserPrompt(baseContext);
    const titleIdx = prompt.indexOf('**Title:**');
    const descIdx = prompt.indexOf('**Description:**');
    const reproIdx = prompt.indexOf('**Reproduction Steps:**');
    expect(titleIdx).toBeLessThan(descIdx);
    expect(descIdx).toBeLessThan(reproIdx);
  });
});

describe('buildSystemPrompt', () => {
  test('returns base prompt when no skills', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    const promptPath = join(tmpDir, 'prompt.md');
    writeFileSync(promptPath, 'You are a bug investigator.', 'utf-8');

    const result = buildSystemPrompt(promptPath, []);
    expect(result).toBe('You are a bug investigator.');
  });

  test('appends skills to base prompt', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    const promptPath = join(tmpDir, 'prompt.md');
    writeFileSync(promptPath, 'Base prompt.', 'utf-8');

    const skills = [
      { name: 'coding-standards', content: 'Use TypeScript strict mode.' },
      { name: 'testing', content: 'Always write unit tests.' },
    ];

    const result = buildSystemPrompt(promptPath, skills);
    expect(result).toContain('Base prompt.');
    expect(result).toContain('## Loaded Skills');
    expect(result).toContain('### Skill: coding-standards');
    expect(result).toContain('Use TypeScript strict mode.');
    expect(result).toContain('### Skill: testing');
    expect(result).toContain('Always write unit tests.');
  });
});
