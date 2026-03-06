import { describe, test, expect } from 'bun:test';
import { buildUserPrompt, buildUserMessage, buildSystemPrompt, canUseTool } from '../../src/services/investigator.ts';
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
    images: [],
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

  test('includes image interpretation hint when images present', () => {
    const prompt = buildUserPrompt({ ...baseContext, images: [
      { base64Data: 'x', mediaType: 'image/png', alt: 'test' },
    ] });
    expect(prompt).toContain('**Attached Screenshots:**');
    expect(prompt).toContain('context of the bug description');
    expect(prompt).toContain('Do not simply transcribe');
  });

  test('omits image hint when no images', () => {
    const prompt = buildUserPrompt(baseContext);
    expect(prompt).not.toContain('**Attached Screenshots:**');
  });
});

describe('buildUserMessage', () => {
  const baseContext: InvestigationContext = {
    bugTitle: 'Login fails',
    bugDescription: 'Crash on login',
    bugReproSteps: '1. Login',
    skills: [],
    images: [],
  };

  test('returns SDKUserMessage with text-only when no images', () => {
    const msg = buildUserMessage(baseContext);
    expect(msg.type).toBe('user');
    expect(msg.session_id).toBe('');
    expect(msg.parent_tool_use_id).toBeNull();

    const content = msg.message.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
  });

  test('includes image content blocks when images provided', () => {
    const context: InvestigationContext = {
      ...baseContext,
      images: [
        { base64Data: 'aWNvbg==', mediaType: 'image/png', alt: 'screenshot' },
        { base64Data: 'anBlZw==', mediaType: 'image/jpeg', alt: 'error' },
      ],
    };
    const msg = buildUserMessage(context);
    const blocks = msg.message.content as Array<{ type: string; source?: { data: string; media_type: string } }>;

    expect(blocks).toHaveLength(3); // 1 text + 2 images
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('image');
    expect(blocks[1]!.source!.data).toBe('aWNvbg==');
    expect(blocks[1]!.source!.media_type).toBe('image/png');
    expect(blocks[2]!.type).toBe('image');
    expect(blocks[2]!.source!.data).toBe('anBlZw==');
    expect(blocks[2]!.source!.media_type).toBe('image/jpeg');
  });

  test('text block contains the user prompt content', () => {
    const msg = buildUserMessage(baseContext);
    const blocks = msg.message.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.text).toContain('Login fails');
    expect(blocks[0]!.text).toContain('Crash on login');
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
