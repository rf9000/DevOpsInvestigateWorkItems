import { runPipeline, runTriagePipeline } from '../services/processor.ts';
import { extractCodeRefs } from './score.ts';
import type { VariantFn } from './run.ts';
import type { AppConfig } from '../types/index.ts';

/**
 * The current production agent: one investigation pass, free-form markdown.
 * Its prompt (src/prompts/investigate-bug.md) and investigator.ts are the
 * frozen baseline, so new variants go in new files instead of editing them.
 */
const legacy: VariantFn = async (config, workItemId) => {
  const run = await runPipeline(config, workItemId);
  return {
    outcome: run.outcome,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.markdown !== undefined ? { markdown: run.markdown } : {}),
    codeRefs: extractCodeRefs(run.markdown ?? ''),
    spend: run.spend,
  };
};

/**
 * Cheap triage, then a deep dive only when triage routes there. Scored on the
 * deep dive's structured code references; a gated case scores its triage hints.
 * `overrides` swaps models per stage so model choices are compared on the same cases.
 */
function triageVariant(overrides: Partial<Pick<AppConfig, 'triageModel' | 'claudeModel'>> = {}): VariantFn {
  return async (config, workItemId) => {
    const run = await runTriagePipeline({ ...config, ...overrides }, workItemId, { replay: true });
    const outcome = run.outcome === 'completed' && run.route && run.route !== 'investigate'
      ? (`gated:${run.route}` as const)
      : run.outcome;
    return {
      outcome,
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.markdown !== undefined ? { markdown: run.markdown } : {}),
      codeRefs: run.codeRefs ?? [],
      spend: run.spend,
    };
  };
}

export const VARIANTS: Record<string, VariantFn> = {
  legacy,
  /** Triage on TRIAGE_MODEL, deep dive on CLAUDE_MODEL, as configured. */
  triage: triageVariant(),
  /** Triage on Sonnet 5.5 instead, to check what Haiku costs in quality. */
  'triage-sonnet': triageVariant({ triageModel: 'claude-sonnet-5-5' }),
};
