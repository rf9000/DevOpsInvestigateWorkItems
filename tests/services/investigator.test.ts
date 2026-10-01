import { describe, test, expect } from 'bun:test';
import { buildQueryOptions, buildUserPrompt, buildUserMessage, buildSystemPrompt, canUseTool, denyDestructiveBashHook, looksLikeReport } from '../../src/services/investigator.ts';
import type { InvestigationContext } from '../../src/services/investigator.ts';
import type { DiscoveredSkill } from '../../src/services/skill-loader.ts';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('buildUserPrompt', () => {
  const baseContext: InvestigationContext = {
    bugTitle: 'Login fails with expired token',
    bugDescription: 'When a user has an expired JWT token, the login page crashes instead of redirecting to the auth page.',
    bugReproSteps: '1. Login with valid credentials\n2. Wait for token to expire\n3. Try to access dashboard',
    discoveredSkills: [],
    images: [],
    attachments: [],
    skippedAttachments: [],
    comments: '',
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
    discoveredSkills: [],
    images: [],
    attachments: [],
    skippedAttachments: [],
    comments: '',
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
  test('returns base prompt when no discovered skills', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    const promptPath = join(tmpDir, 'prompt.md');
    writeFileSync(promptPath, 'You are a bug investigator.', 'utf-8');

    const result = buildSystemPrompt(promptPath);
    expect(result).toBe('You are a bug investigator.');
  });

  test('appends discovered skills section when present', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    const promptPath = join(tmpDir, 'prompt.md');
    writeFileSync(promptPath, 'Base prompt.', 'utf-8');

    const discovered: DiscoveredSkill[] = [
      { name: 'online-investigate', description: 'Investigates mappings between AL and C# microservices.', skillDir: '/fake/path' },
    ];

    const result = buildSystemPrompt(promptPath, discovered);
    expect(result).toContain('Base prompt.');
    expect(result).toContain('## Available Invocable Skills');
    expect(result).toContain('**online-investigate**');
    expect(result).toContain('Investigates mappings between AL and C# microservices.');
    expect(result).toContain('Skill tool');
  });

  test('omits discovered skills section when empty', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'prompt-test-'));
    const promptPath = join(tmpDir, 'prompt.md');
    writeFileSync(promptPath, 'Base prompt.', 'utf-8');

    const result = buildSystemPrompt(promptPath, []);
    expect(result).not.toContain('Available Invocable Skills');
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

describe('denyDestructiveBashHook', () => {
  const abort = new AbortController();

  function preToolUseInput(toolName: string, toolInput: unknown) {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu_test',
      session_id: 'test',
      transcript_path: '',
      cwd: '',
    } as Parameters<typeof denyDestructiveBashHook>[0];
  }

  test('denies destructive bash commands with a reason', async () => {
    const output = await denyDestructiveBashHook(
      preToolUseInput('Bash', { command: 'rm -rf src/' }),
      'toolu_test',
      { signal: abort.signal },
    );
    if (!('hookSpecificOutput' in output)) {
      throw new Error('Expected a sync hook output with hookSpecificOutput');
    }
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
  });

  test('returns empty output for safe bash commands', async () => {
    const output = await denyDestructiveBashHook(
      preToolUseInput('Bash', { command: 'git status' }),
      'toolu_test',
      { signal: abort.signal },
    );
    expect(output).toEqual({});
  });

  test('returns empty output for non-PreToolUse events', async () => {
    const output = await denyDestructiveBashHook(
      { hook_event_name: 'SessionEnd' } as Parameters<typeof denyDestructiveBashHook>[0],
      undefined,
      { signal: abort.signal },
    );
    expect(output).toEqual({});
  });
});

describe('looksLikeReport', () => {
  test('returns true for a well-formed report', () => {
    const report = `### Bug Validity\nYes\n\n### Root Cause\nMissing null check.\n\n### Suggested Fix\nAdd guard clause.`;
    expect(looksLikeReport(report)).toBe(true);
  });

  test('returns true with 2 of 3 headers', () => {
    const partial = `### Bug Validity\nYes\n\n### Root Cause\nSomething broke.`;
    expect(looksLikeReport(partial)).toBe(true);
  });

  test('returns false for meta-commentary', () => {
    const meta = 'the background task completed but the analysis is already finished — those results were redundant.';
    expect(looksLikeReport(meta)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(looksLikeReport('')).toBe(false);
  });

  test('returns false with only 1 header', () => {
    const oneHeader = `### Bug Validity\nYes, this is a bug.`;
    expect(looksLikeReport(oneHeader)).toBe(false);
  });
});

describe('buildUserPrompt — attachments and comments', () => {
  const base: InvestigationContext = {
    bugTitle: 'Bank lookup returns nothing',
    bugDescription: 'desc',
    bugReproSteps: 'steps',
    discoveredSkills: [],
    images: [],
    attachments: [],
    skippedAttachments: [],
    comments: '',
  };

  test('lists each attachment with its path so the agent can read it', () => {
    const prompt = buildUserPrompt({
      ...base,
      attachments: [
        { fileName: 'error.log', localPath: '/tmp/ado/82007/error.log', sizeBytes: 2048 },
      ],
    });

    expect(prompt).toContain('error.log');
    expect(prompt).toContain('/tmp/ado/82007/error.log');
  });

  test('tells the agent to read attachments on demand', () => {
    const prompt = buildUserPrompt({
      ...base,
      attachments: [
        { fileName: 'a.txt', localPath: '/tmp/ado/1/a.txt', sizeBytes: 10 },
      ],
    });

    expect(prompt).toContain('Read');
  });

  test('omits the attachment section when there are none', () => {
    expect(buildUserPrompt(base)).not.toContain('**Attached Files:**');
  });

  test('reports attachments that could not be downloaded', () => {
    const prompt = buildUserPrompt({
      ...base,
      skippedAttachments: [{ fileName: 'huge.zip', reason: 'exceeds 10485760 byte limit' }],
    });

    expect(prompt).toContain('huge.zip');
    expect(prompt).toContain('exceeds');
  });

  test('includes the comment thread when present', () => {
    const prompt = buildUserPrompt({ ...base, comments: '**Ada** (2026-09-01):\nstill broken' });

    expect(prompt).toContain('**Discussion:**');
    expect(prompt).toContain('still broken');
  });

  test('omits the discussion section when there are no comments', () => {
    expect(buildUserPrompt(base)).not.toContain('**Discussion:**');
  });
});

describe('buildQueryOptions', () => {
  const base: InvestigationContext = {
    bugTitle: 't',
    bugDescription: 'd',
    bugReproSteps: 's',
    discoveredSkills: [],
    images: [],
    attachments: [],
    skippedAttachments: [],
    comments: '',
  };

  const config = {
    claudeMaxTurns: 40,
    targetRepoPath: 'C:/repos/target',
  } as never;

  test('grants access to the attachment directory when attachments exist', () => {
    const options = buildQueryOptions(config, 'claude-sonnet-5', {
      ...base,
      attachments: [
        { fileName: 'a.log', localPath: '/tmp/ado-attachments/82007/a.log', sizeBytes: 5 },
      ],
    }, 'sys', () => {});

    expect(options.additionalDirectories).toEqual(['/tmp/ado-attachments/82007']);
  });

  test('grants access to one directory even with several attachments', () => {
    const options = buildQueryOptions(config, 'claude-sonnet-5', {
      ...base,
      attachments: [
        { fileName: 'a.log', localPath: '/tmp/ado-attachments/1/a.log', sizeBytes: 5 },
        { fileName: 'b.log', localPath: '/tmp/ado-attachments/1/b.log', sizeBytes: 5 },
      ],
    }, 'sys', () => {});

    expect(options.additionalDirectories).toEqual(['/tmp/ado-attachments/1']);
  });

  test('omits additionalDirectories when there are no attachments', () => {
    const options = buildQueryOptions(config, 'claude-sonnet-5', base, 'sys', () => {});

    expect(options.additionalDirectories).toBeUndefined();
  });

  test('carries the model and turn limit through', () => {
    const options = buildQueryOptions(config, 'claude-opus-4-8', base, 'sys', () => {});

    expect(options.model).toBe('claude-opus-4-8');
    expect(options.maxTurns).toBe(40);
  });
});
