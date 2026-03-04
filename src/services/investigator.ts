import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig, Skill } from '../types/index.ts';

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
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt,
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
