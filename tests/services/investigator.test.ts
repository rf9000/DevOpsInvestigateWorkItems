import { describe, test, expect } from 'bun:test';
import { buildUserPrompt, buildSystemPrompt, canUseTool } from '../../src/services/investigator.ts';
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

describe('canUseTool', () => {
  test('allows read-only bash commands', async () => {
    const safe = [
      'cat src/index.ts',
      'ls -la',
      'git log --oneline -10',
      'git status',
      'git diff HEAD',
      'grep -r "pattern" src/',
      'find . -name "*.ts"',
      'bun test',
      'bun run typecheck',
    ];
    for (const command of safe) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('allow');
    }
  });

  test('denies destructive git commands', async () => {
    const dangerous = [
      'git push origin main',
      'git commit -m "oops"',
      'git merge feature',
      'git rebase main',
      'git reset --hard HEAD~1',
      'git checkout -- .',
      'git branch -D feature',
      'git stash drop',
      'git clean -fd',
      'git tag -d v1.0',
    ];
    for (const command of dangerous) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('deny');
    }
  });

  test('denies file deletion commands', async () => {
    const dangerous = [
      'rm -rf src/',
      'rm -r node_modules',
      'rmdir build',
    ];
    for (const command of dangerous) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('deny');
    }
  });

  test('denies file write via redirect', async () => {
    const result = await canUseTool('Bash', { command: 'echo "hack" > file.ts' });
    expect(result.behavior).toBe('deny');
  });

  test('denies destructive curl commands', async () => {
    const dangerous = [
      'curl -X POST https://api.example.com/data',
      'curl --data "payload" https://api.example.com',
      'curl --request DELETE https://api.example.com/item',
    ];
    for (const command of dangerous) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('deny');
    }
  });

  test('denies package manager install/publish', async () => {
    const dangerous = [
      'npm install lodash',
      'npm publish',
      'bun add zod',
      'bun remove zod',
    ];
    for (const command of dangerous) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('deny');
    }
  });

  test('denies az devops and gh PR commands', async () => {
    const dangerous = [
      'az devops configure --defaults',
      'gh pr create --title "test"',
      'gh issue close 42',
    ];
    for (const command of dangerous) {
      const result = await canUseTool('Bash', { command });
      expect(result.behavior).toBe('deny');
    }
  });

  test('denies sed in-place edits', async () => {
    const result = await canUseTool('Bash', { command: 'sed -i "s/old/new/" file.ts' });
    expect(result.behavior).toBe('deny');
  });

  test('allows non-Bash tools without checking', async () => {
    const result = await canUseTool('Read', { file_path: '/etc/passwd' });
    expect(result.behavior).toBe('allow');
  });
});
