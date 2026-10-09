import { z } from 'zod';

export const CLASSIFICATIONS = [
  'bug',
  'investigation',
  'feature_request',
  'question',
  'config_or_data',
  'not_a_bug',
] as const;

export const triageResultSchema = z.object({
  classification: z.enum(CLASSIFICATIONS)
    .describe('bug: code defect. investigation: needs code analysis but is not clearly a defect. The rest need no code deep dive.'),
  summary: z.string().describe('One or two sentences: what the reporter experiences or asks for.'),
  area: z.string().describe('Functional area or module, e.g. "Remittance advice export". Empty when unknown.'),
  severityGuess: z.enum(['critical', 'high', 'medium', 'low', 'unknown']),
  completeness: z.enum(['sufficient', 'needs_info'])
    .describe('needs_info only when a developer could not start without an answer from the reporter.'),
  missingInfo: z.array(z.string()).describe('What is missing. Empty when sufficient.'),
  questionsForReporter: z.array(z.string()).describe('Concrete questions to ask. Empty when sufficient.'),
  duplicates: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    confidence: z.enum(['high', 'medium']),
    reason: z.string(),
  })).describe('Existing work items describing the same problem. Only items you opened and compared.'),
  likelyFiles: z.array(z.string()).describe('Repo files you found that are probably involved, if any. Helps the deep dive start.'),
  rationale: z.string().describe('Why this classification and route, in two or three sentences.'),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

export const investigationResultSchema = z.object({
  validity: z.enum(['valid', 'invalid', 'uncertain'])
    .describe('Whether code was found that causes the described behavior.'),
  confidence: z.enum(['high', 'medium', 'low']),
  rootCause: z.string().describe('Why it happens, referencing files and lines. Markdown allowed.'),
  codeReferences: z.array(z.object({
    path: z.string().describe('Repo-relative file path.'),
    line: z.number().int().nullable(),
    note: z.string(),
  })).describe('Every file a fix would most likely change, most important first.'),
  reproduction: z.array(z.string()).describe('Steps to reproduce.'),
  suggestedFix: z.string().describe('Short, precise, actionable. Markdown allowed.'),
  risks: z.string().describe('What the fix could break, or an empty string.'),
  ambiguities: z.array(z.string()),
});

export type InvestigationResult = z.infer<typeof investigationResultSchema>;

/** JSON schema for the Agent SDK `outputFormat`, without the `$schema` marker. */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Where a triaged work item goes next. */
export type TriageRoute =
  | 'investigate'
  | 'needs_info'
  | 'duplicate'
  | Exclude<TriageResult['classification'], 'bug' | 'investigation'>;

/**
 * A work item of type Bug always gets the deep dive unless it lacks the
 * information to start or duplicates another item: in the benchmark, the
 * cheap model twice called a real, later fixed bug a feature request or not a
 * bug. Classification alone only gates other types, such as User Stories.
 */
export function routeFor(t: TriageResult, workItemType: string): TriageRoute {
  if (t.completeness === 'needs_info') return 'needs_info';
  if (t.duplicates.some((d) => d.confidence === 'high')) return 'duplicate';
  if (t.classification === 'bug' || t.classification === 'investigation') return 'investigate';
  if (workItemType.toLowerCase() === 'bug') return 'investigate';
  return t.classification;
}
