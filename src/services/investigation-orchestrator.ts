import type {
  AppConfig,
  InvestigationVerdict,
  JudgeResult,
  ValidationLogEntry,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';
import * as inv from './investigator.ts';
import * as ext from './verdict-extractor.ts';
import * as jdg from './judge.ts';
import { appendValidationLog as writeValidationLog } from '../state/validation-log.ts';
import type { SpendSink } from './spend-tracker.ts';

export interface OrchestratorDeps {
  investigateBug: (
    config: AppConfig,
    context: InvestigationContext,
    model: string,
    onSpend?: SpendSink,
  ) => Promise<string>;

  extractVerdict: (report: string, model: string, onSpend?: SpendSink) => Promise<InvestigationVerdict>;

  judgeVerdicts: (
    verdictA: InvestigationVerdict,
    verdictB: InvestigationVerdict,
    model: string,
    onSpend?: SpendSink,
  ) => Promise<JudgeResult>;

  appendValidationLog: (config: AppConfig, entry: ValidationLogEntry) => void;
}

const defaultDeps: OrchestratorDeps = {
  investigateBug: inv.investigateBug,
  extractVerdict: ext.extractVerdict,
  judgeVerdicts: jdg.judgeVerdicts,
  appendValidationLog: writeValidationLog,
};

function log(message: string): void {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

// The validation log is write-only (not yet consumed) and purely for future
// analysis, so a failure here must never block a successful investigation
// from being posted.
function safeAppendValidationLog(
  deps: OrchestratorDeps,
  config: AppConfig,
  entry: ValidationLogEntry,
): void {
  try {
    deps.appendValidationLog(config, entry);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${entry.bugId}: Skipping validation log write — ${errMsg}`);
  }
}

interface Pass {
  report: string;
  verdict: InvestigationVerdict;
}

type PassLabel = 'A' | 'B' | 'tiebreak';

// Routes a call's spend to its step on the context's tracker, if there is one.
function sinkFor(context: InvestigationContext, step: string): SpendSink {
  return (call) => context.spend?.add(step, call);
}

async function runPass(
  config: AppConfig,
  context: InvestigationContext,
  model: string,
  label: PassLabel,
  deps: OrchestratorDeps,
): Promise<Pass> {
  const report = await deps.investigateBug(config, context, model, sinkFor(context, `investigate:${label}`));
  const verdict = await deps.extractVerdict(report, config.claudeJudgeModel, sinkFor(context, 'extract'));
  return { report, verdict };
}

export async function runInvestigation(
  config: AppConfig,
  bugId: number,
  context: InvestigationContext,
  deps: OrchestratorDeps = defaultDeps,
): Promise<string> {
  const [passA, passB] = await Promise.all([
    runPass(config, context, config.claudeModel, 'A', deps),
    runPass(config, context, config.claudeModel, 'B', deps),
  ]);

  const judgeSink = sinkFor(context, 'judge');
  const abJudgment = await deps.judgeVerdicts(passA.verdict, passB.verdict, config.claudeJudgeModel, judgeSink);

  if (abJudgment.agree) {
    safeAppendValidationLog(deps, config, {
      bugId,
      timestamp: new Date().toISOString(),
      verdictA: passA.verdict,
      verdictB: passB.verdict,
      judgeResult: abJudgment,
      tieBreakUsed: false,
      finalPass: 'A',
    });
    return passA.report;
  }

  const tiebreak = await runPass(config, context, config.claudeTiebreakModel, 'tiebreak', deps);
  const aVsTiebreak = await deps.judgeVerdicts(passA.verdict, tiebreak.verdict, config.claudeJudgeModel, judgeSink);
  const bVsTiebreak = await deps.judgeVerdicts(passB.verdict, tiebreak.verdict, config.claudeJudgeModel, judgeSink);

  // The tiebreak resolves *which* of pass A or B was correct. If it agrees
  // with one side, that side's own report is posted (its verdict was
  // validated). Only a true 3-way split (tiebreak agrees with neither) falls
  // back to posting the tiebreak's own report.
  let finalPass: 'A' | 'B' | 'tiebreak';
  let finalReport: string;
  if (aVsTiebreak.agree) {
    finalPass = 'A';
    finalReport = passA.report;
  } else if (bVsTiebreak.agree) {
    finalPass = 'B';
    finalReport = passB.report;
  } else {
    finalPass = 'tiebreak';
    finalReport = tiebreak.report;
  }

  safeAppendValidationLog(deps, config, {
    bugId,
    timestamp: new Date().toISOString(),
    verdictA: passA.verdict,
    verdictB: passB.verdict,
    judgeResult: abJudgment,
    tieBreakUsed: true,
    tieBreakVerdict: tiebreak.verdict,
    finalPass,
  });

  return finalReport;
}
