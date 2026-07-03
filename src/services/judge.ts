import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { InvestigationVerdict, JudgeResult } from '../types/index.ts';

const JudgeResultSchema = z.object({
  agree: z.boolean(),
  reason: z.string(),
});

export function buildJudgePrompt(
  verdictA: InvestigationVerdict,
  verdictB: InvestigationVerdict,
): string {
  return [
    'Two independent investigators each analyzed the same bug report and produced the structured verdicts below.',
    'Decide whether they materially agree: the bug-validity call must match, and the root cause must point at the same underlying issue',
    '(citing the same file, or the same logical cause even if line numbers differ slightly). Minor wording differences do not count as disagreement.',
    '',
    '## Verdict A',
    JSON.stringify(verdictA, null, 2),
    '',
    '## Verdict B',
    JSON.stringify(verdictB, null, 2),
    '',
    'Do they agree? Provide a brief reason either way.',
  ].join('\n');
}

export async function judgeVerdicts(
  verdictA: InvestigationVerdict,
  verdictB: InvestigationVerdict,
  model: string,
): Promise<JudgeResult> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: buildJudgePrompt(verdictA, verdictB) }],
    output_config: { format: zodOutputFormat(JudgeResultSchema) },
  });

  if (!response.parsed_output) {
    throw new Error('Judge failed to produce structured output');
  }

  return response.parsed_output;
}
