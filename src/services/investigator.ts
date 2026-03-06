import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig, Skill } from '../types/index.ts';

const DENIED_BASH_PATTERNS = [
  /\bgit\s+(push|commit|merge|rebase|reset|checkout|branch\s+-[dD]|stash\s+drop|clean|tag\s+-d)/,
  /\brm\s+(-rf?|--recursive)/,
  /\brmdir\b/,
  /\bdel\b/,
  /\bmkdir\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\b(chmod|chown)\b/,
  /\bnpm\s+(publish|install|uninstall)/,
  /\bbun\s+(add|remove|install|publish)/,
  /\bcurl\s.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|--request\s*(POST|PUT|PATCH|DELETE))/,
  /\baz\s+devops/,
  /\bgh\s+(pr|issue)\s+(create|close|merge|delete|comment)/,
  />\s*[^\s]/, // redirect output to file
  /\btee\b/,
  /\bsed\s+-i/,
  /\bawk\b.*>/, // awk with output redirect
];

export async function canUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    for (const pattern of DENIED_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Blocked destructive bash command: ${command}`,
        };
      }
    }
  }
  return { behavior: 'allow' };
}

export interface InvestigationContext {
  bugTitle: string;
  bugDescription: string;
  bugReproSteps: string;
  skills: Skill[];
}

export async function investigateBug(
  config: AppConfig,
  context: InvestigationContext,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(config.promptPath, context.skills);
  const userPrompt = buildUserPrompt(context);

  let result: string | undefined;

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: config.claudeModel,
      maxTurns: 25,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Agent', 'LSP'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemPrompt,
      },
      settingSources: ['project'],
      cwd: config.targetRepoPath,
    },
  })) {
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }

  if (result === undefined) {
    throw new Error('No investigation result received from Claude Agent SDK');
  }

  return result.trim();
}

export function buildSystemPrompt(
  promptPath: string,
  skills: Skill[],
): string {
  const basePrompt = readFileSync(promptPath, 'utf-8');

  if (skills.length === 0) {
    return basePrompt;
  }

  const skillSections = skills
    .map((s) => `### Skill: ${s.name}\n${s.content}`)
    .join('\n\n');

  return `${basePrompt}\n\n## Loaded Skills\n\n${skillSections}`;
}

export function buildUserPrompt(context: InvestigationContext): string {
  const lines: string[] = [
    '## Bug Report',
    `**Title:** ${context.bugTitle}`,
  ];

  if (context.bugDescription) {
    lines.push('', '**Description:**', context.bugDescription);
  }

  if (context.bugReproSteps) {
    lines.push('', '**Reproduction Steps:**', context.bugReproSteps);
  }

  return lines.join('\n');
}
