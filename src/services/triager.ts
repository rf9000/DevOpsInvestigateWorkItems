import { readFileSync } from 'fs';
import type { AppConfig, ImageAttachment, WorkItemComment } from '../types/index.ts';
import { ADO_TOOLS_SERVER, createAdoToolServer } from './ado-tools.ts';
import type { AdoToolScope } from './ado-tools.ts';
import { runStructuredAgent } from './agent-runner.ts';
import type { DiscoveredSkill } from './skill-loader.ts';
import type { SpendSink } from './spend-tracker.ts';
import { triageResultSchema } from './triage-schemas.ts';
import type { TriageResult } from './triage-schemas.ts';

export interface WorkItemContext {
  id: number;
  type: string;
  title: string;
  description: string;
  reproSteps: string;
  /** Oldest first. Empty in replays. */
  comments: WorkItemComment[];
  images: ImageAttachment[];
  discoveredSkills: DiscoveredSkill[];
}

/** Text every comment the bot posts ends with. */
export const BOT_FOOTER_MARKER = 'If you want the agent to investigate again';

export function isBotComment(c: WorkItemComment): boolean {
  return c.text.includes(BOT_FOOTER_MARKER);
}

/** The work item as the agent sees it; shared by the triage and deep stages. */
export function renderWorkItem(ctx: WorkItemContext): string {
  const lines = [`## Work item #${ctx.id} (${ctx.type})`, `**Title:** ${ctx.title}`];
  if (ctx.description) lines.push('', '**Description:**', ctx.description);
  if (ctx.reproSteps) lines.push('', '**Reproduction Steps:**', ctx.reproSteps);
  if (ctx.comments.length > 0) {
    lines.push('', '**Comments (oldest first):**');
    for (const c of ctx.comments) {
      const who = isBotComment(c) ? '[bot]' : c.author;
      lines.push(`- ${who} (${c.createdDate.slice(0, 10)}): ${c.text}`);
    }
  }
  if (ctx.images.length > 0) {
    lines.push(
      '',
      '**Attached Screenshots:**',
      `${ctx.images.length} screenshot(s) are attached below. Interpret them in the context of the report: look for error messages, unexpected UI state or incorrect data.`,
    );
  }
  return lines.join('\n');
}

export type RunAgent = typeof runStructuredAgent;

export async function triageWorkItem(
  config: AppConfig,
  ctx: WorkItemContext,
  scope: AdoToolScope,
  onSpend?: SpendSink,
  runAgent: RunAgent = runStructuredAgent,
): Promise<TriageResult> {
  return runAgent({
    label: 'triage',
    model: config.triageModel,
    systemPrompt: readFileSync(config.triagePromptPath, 'utf-8'),
    userPrompt: renderWorkItem(ctx),
    images: ctx.images,
    cwd: config.targetRepoPath,
    maxTurns: 15,
    tools: ['Read', 'Grep', 'Glob'],
    mcpServers: { [ADO_TOOLS_SERVER]: createAdoToolServer(config, scope) },
    schema: triageResultSchema,
    ...(onSpend ? { onSpend } : {}),
  });
}
