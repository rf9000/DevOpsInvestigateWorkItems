import { readFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AppConfig, ImageAttachment } from '../types/index.ts';
import type { DiscoveredSkill } from './skill-loader.ts';

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
  discoveredSkills: DiscoveredSkill[];
  images: ImageAttachment[];
}

export function buildUserMessage(context: InvestigationContext): SDKUserMessage {
  const blocks: ContentBlockParam[] = [
    { type: 'text', text: buildUserPrompt(context) },
  ];

  for (const img of context.images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.base64Data,
      },
    });
  }

  return {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    session_id: '',
  };
}

const REPORT_HEADERS = ['### Bug Validity', '### Root Cause', '### Suggested Fix'];

export function looksLikeReport(text: string): boolean {
  return REPORT_HEADERS.filter((h) => text.includes(h)).length >= 2;
}

function extractAssistantText(message: { message: { content: unknown[] } }): string {
  return message.message.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function investigateBug(
  config: AppConfig,
  context: InvestigationContext,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(config.promptPath, context.discoveredSkills);

  const hasImages = context.images.length > 0;

  let prompt: string | AsyncIterable<SDKUserMessage>;
  if (hasImages) {
    const userMsg = buildUserMessage(context);
    async function* singleMessage() {
      yield userMsg;
    }
    prompt = singleMessage();
  } else {
    prompt = buildUserPrompt(context);
  }

  let result: string | undefined;
  let resultSubtype: string | undefined;
  const assistantTexts: string[] = [];
  let turnCount = 0;

  for await (const message of query({
    prompt,
    options: {
      model: config.claudeModel,
      maxTurns: 40,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'LSP'],
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
    if (message.type === 'assistant') {
      turnCount++;
      const text = extractAssistantText(message);
      if (text.trim()) {
        assistantTexts.push(text);
      }
    }
    if (message.type === 'result') {
      resultSubtype = message.subtype;
      if (message.subtype === 'success') {
        result = message.result;
      } else if (message.subtype === 'error_max_turns') {
        console.error(`  Agent hit max turns (${turnCount}). Last assistant texts may contain a partial report.`);
      } else {
        console.error(`  Agent ended with result subtype: ${message.subtype}`);
      }
    }
  }

  // If no success result, try to salvage a report from assistant messages
  if (result === undefined) {
    for (let i = assistantTexts.length - 1; i >= 0; i--) {
      const candidate = assistantTexts[i]!;
      if (looksLikeReport(candidate)) {
        console.error(`  No success result (subtype=${resultSubtype ?? 'none'}, turns=${turnCount}), but found report in assistant message ${i + 1}/${assistantTexts.length}`);
        return candidate.trim();
      }
    }
    throw new Error(
      `No investigation result received from Claude Agent SDK (subtype=${resultSubtype ?? 'none'}, turns=${turnCount}, assistantMessages=${assistantTexts.length})`,
    );
  }

  // If the final result doesn't look like a report, search earlier assistant
  // messages for one that does (the agent may have output the report mid-conversation
  // and then ended with meta-commentary about a background task).
  if (!looksLikeReport(result)) {
    for (let i = assistantTexts.length - 1; i >= 0; i--) {
      const candidate = assistantTexts[i]!;
      if (looksLikeReport(candidate)) {
        return candidate.trim();
      }
    }
  }

  return result.trim();
}

export function buildSystemPrompt(
  promptPath: string,
  discoveredSkills: DiscoveredSkill[] = [],
): string {
  const basePrompt = readFileSync(promptPath, 'utf-8');
  const sections: string[] = [basePrompt];

  if (discoveredSkills.length > 0) {
    const listing = discoveredSkills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');
    sections.push(
      `## Available Invocable Skills\n\n` +
      `The target repository has the following skills available via the \`Skill\` tool. ` +
      `When your investigation touches an area covered by one of these skills, you MUST invoke it using the Skill tool — ` +
      `do not try to manually replicate what the skill does.\n\n` +
      `${listing}\n\n` +
      `To invoke a skill, use the Skill tool with the skill name. The skill will guide your investigation for that area.`,
    );
  }

  return sections.join('\n\n');
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

  if (context.images.length > 0) {
    lines.push(
      '',
      '**Attached Screenshots:**',
      `${context.images.length} screenshot(s) are attached below. Interpret these images in the context of the bug description and reproduction steps — look for error messages, unexpected UI state, incorrect data, or visual clues that help identify the root cause. Do not simply transcribe the text in the images.`,
    );
  }

  return lines.join('\n');
}
