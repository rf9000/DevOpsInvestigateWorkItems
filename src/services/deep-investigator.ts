import type { AppConfig } from '../types/index.ts';
import { runStructuredAgent } from './agent-runner.ts';
import { buildSystemPrompt } from './investigator.ts';
import type { SpendSink } from './spend-tracker.ts';
import { renderWorkItem } from './triager.ts';
import type { RunAgent, WorkItemContext } from './triager.ts';
import { investigationResultSchema } from './triage-schemas.ts';
import type { InvestigationResult, TriageResult } from './triage-schemas.ts';

export function renderTriageHints(t: TriageResult): string {
  const lines = [
    '## Triage findings',
    `- Classification: ${t.classification}`,
    `- Summary: ${t.summary}`,
  ];
  if (t.area) lines.push(`- Area: ${t.area}`);
  if (t.likelyFiles.length > 0) lines.push(`- Likely files: ${t.likelyFiles.join(', ')}`);
  const related = t.duplicates.filter((d) => d.confidence === 'medium');
  if (related.length > 0) lines.push(`- Related items: ${related.map((d) => `#${d.id} ${d.title}`).join('; ')}`);
  return lines.join('\n');
}

export async function investigateDeep(
  config: AppConfig,
  ctx: WorkItemContext,
  triage: TriageResult,
  onSpend?: SpendSink,
  runAgent: RunAgent = runStructuredAgent,
): Promise<InvestigationResult> {
  return runAgent({
    label: 'investigate',
    model: config.claudeModel,
    systemPrompt: buildSystemPrompt(config.deepPromptPath, ctx.discoveredSkills),
    userPrompt: `${renderWorkItem(ctx)}\n\n${renderTriageHints(triage)}`,
    images: ctx.images,
    cwd: config.targetRepoPath,
    maxTurns: 40,
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'LSP'],
    schema: investigationResultSchema,
    ...(onSpend ? { onSpend } : {}),
  });
}
