import { runPipeline } from '../services/processor.ts';
import { extractCodeRefs } from './score.ts';
import type { VariantFn } from './run.ts';

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

export const VARIANTS: Record<string, VariantFn> = {
  legacy,
};
