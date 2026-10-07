import type { AppConfig, StepSpend } from '../types/index.ts';
import type { SpendTracker } from '../services/spend-tracker.ts';
import { createSpendTracker } from '../services/spend-tracker.ts';
import type { BenchCase } from './collect.ts';
import { scoreRefs } from './score.ts';

/** What one variant produced for one case. Nothing is posted. */
export interface VariantOutput {
  /** `gated:<route>` when a variant decided not to investigate in depth. */
  outcome: 'completed' | 'failed' | `gated:${string}`;
  error?: string;
  markdown?: string;
  /** Files the report points at; scored against the real fix. */
  codeRefs: string[];
  spend: SpendTracker;
}

export type VariantFn = (config: AppConfig, workItemId: number) => Promise<VariantOutput>;

/** One line of a results JSONL file. */
export interface BenchRow {
  runId: string;
  at: string;
  variant: string;
  caseId: number;
  title: string;
  repeat: number;
  outcome: VariantOutput['outcome'];
  error?: string;
  costUsd: number;
  perStage: Record<string, StepSpend>;
  turns: number;
  durationMs: number;
  models: string[];
  codeRefs: string[];
  fixFiles: string[];
  /** False when the case has no known fix: cost and behavior only, no recall. */
  scored: boolean;
  matchedFixFiles: string[];
  fileRecall: number;
  anyFileHit: boolean;
  refPrecision: number | null;
  markdown?: string;
}

export interface Worktree {
  path: string;
  dispose: () => Promise<void>;
}

export interface RunDeps {
  variants: Record<string, VariantFn>;
  createWorktree: (commit: string) => Promise<Worktree>;
  appendRow: (row: BenchRow) => void;
  now: () => number;
}

export interface RunOptions {
  variants: string[];
  repeat: number;
  /** Stop before starting another run once this much has been spent. */
  maxUsd?: number;
  runId: string;
}

export interface RunResult {
  rows: BenchRow[];
  totalUsd: number;
  stoppedForBudget: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runBench(
  config: AppConfig,
  cases: BenchCase[],
  options: RunOptions,
  deps: RunDeps,
): Promise<RunResult> {
  const unknown = options.variants.filter((v) => !deps.variants[v]);
  if (unknown.length > 0) {
    throw new Error(`Unknown variant(s): ${unknown.join(', ')}. Known: ${Object.keys(deps.variants).join(', ')}`);
  }

  const rows: BenchRow[] = [];
  let totalUsd = 0;
  const overBudget = () => options.maxUsd !== undefined && totalUsd >= options.maxUsd;

  const record = (c: BenchCase, variant: string, repeat: number, out: VariantOutput, durationMs: number) => {
    const perStage = out.spend.snapshot();
    const stages = Object.values(perStage);
    const score = scoreRefs(out.codeRefs, c.fixFiles);
    const row: BenchRow = {
      runId: options.runId,
      at: new Date().toISOString(),
      variant,
      caseId: c.id,
      title: c.title,
      repeat,
      outcome: out.outcome,
      ...(out.error !== undefined ? { error: out.error } : {}),
      costUsd: out.spend.totalUsd(),
      perStage,
      turns: stages.reduce((n, s) => n + s.turns, 0),
      durationMs,
      models: [...new Set(stages.flatMap((s) => s.models))],
      codeRefs: out.codeRefs,
      fixFiles: c.fixFiles,
      scored: c.fixFiles.length > 0,
      ...score,
      ...(out.markdown !== undefined ? { markdown: out.markdown } : {}),
    };
    totalUsd += row.costUsd;
    rows.push(row);
    deps.appendRow(row);
  };

  const failed = (error: string): VariantOutput =>
    ({ outcome: 'failed', error, codeRefs: [], spend: createSpendTracker() });

  for (const c of cases) {
    if (overBudget()) break;

    let worktree: Worktree;
    try {
      worktree = await deps.createWorktree(c.baseCommit);
    } catch (err) {
      for (let r = 1; r <= options.repeat; r++) {
        for (const v of options.variants) record(c, v, r, failed(`worktree: ${errorMessage(err)}`), 0);
      }
      continue;
    }

    try {
      // The agent must see the code as it was before the fix, and must not post.
      const caseConfig: AppConfig = { ...config, targetRepoPath: worktree.path, dryRun: true };
      for (let r = 1; r <= options.repeat; r++) {
        for (const v of options.variants) {
          if (overBudget()) break;
          const started = deps.now();
          let out: VariantOutput;
          try {
            out = await deps.variants[v]!(caseConfig, c.id);
          } catch (err) {
            out = failed(errorMessage(err));
          }
          record(c, v, r, out, deps.now() - started);
        }
      }
    } finally {
      await worktree.dispose();
    }
  }

  return { rows, totalUsd, stoppedForBudget: overBudget() && rows.length < cases.length * options.repeat * options.variants.length };
}
