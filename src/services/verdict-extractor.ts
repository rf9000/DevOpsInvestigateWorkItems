import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { InvestigationVerdict } from '../types/index.ts';

const VerdictSchema = z.object({
  isValid: z.enum(['yes', 'no', 'uncertain']),
  rootCauseSummary: z.string(),
  primaryCitation: z.object({
    file: z.string(),
    line: z.number().optional(),
  }),
  suggestedFixSummary: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export function buildVerdictExtractionPrompt(report: string): string {
  return [
    'Extract a structured verdict from the following bug investigation report.',
    'Base every field only on what the report actually states — do not infer beyond it.',
    'If the report does not clearly state a field, use your best reading of the report\'s intent.',
    '',
    '## Report',
    report,
  ].join('\n');
}

export async function extractVerdict(
  report: string,
  model: string,
): Promise<InvestigationVerdict> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildVerdictExtractionPrompt(report) }],
    output_config: { format: zodOutputFormat(VerdictSchema) },
  });

  if (!response.parsed_output) {
    throw new Error('Verdict extraction failed to produce structured output');
  }

  return response.parsed_output;
}
