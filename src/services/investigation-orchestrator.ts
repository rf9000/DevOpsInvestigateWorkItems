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

export interface OrchestratorDeps {
  investigateBug: (
    config: AppConfig,
    context: InvestigationContext,
    model: string,
  ) => Promise<string>;

  extractVerdict: (report: string, model: string) => Promise<InvestigationVerdict>;

  judgeVerdicts: (
    verdictA: InvestigationVerdict,
    verdictB: InvestigationVerdict,
    model: string,
  ) => Promise<JudgeResult>;

  appendValidationLog: (config: AppConfig, entry: ValidationLogEntry) => void;
}

const defaultDeps: OrchestratorDeps = {
  investigateBug: inv.investigateBug,
  extractVerdict: ext.extractVerdict,
  judgeVerdicts: jdg.judgeVerdicts,
  appendValidationLog: writeValidationLog,
};

interface Pass {
  report: string;
  verdict: InvestigationVerdict;
}

async function runPass(
  config: AppConfig,
  context: InvestigationContext,
  model: string,
  deps: OrchestratorDeps,
): Promise<Pass> {
  const report = await deps.investigateBug(config, context, model);
  const verdict = await deps.extractVerdict(report, config.claudeJudgeModel);
  return { report, verdict };
}

export async function runInvestigation(
  config: AppConfig,
  bugId: number,
  context: InvestigationContext,
  deps: OrchestratorDeps = defaultDeps,
): Promise<string> {
  const [passA, passB] = await Promise.all([
    runPass(config, context, config.claudeModel, deps),
    runPass(config, context, config.claudeModel, deps),
  ]);

  const abJudgment = await deps.judgeVerdicts(passA.verdict, passB.verdict, config.claudeJudgeModel);

  if (abJudgment.agree) {
    deps.appendValidationLog(config, {
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

  const tiebreak = await runPass(config, context, config.claudeTiebreakModel, deps);
  const aVsTiebreak = await deps.judgeVerdicts(passA.verdict, tiebreak.verdict, config.claudeJudgeModel);
  const bVsTiebreak = await deps.judgeVerdicts(passB.verdict, tiebreak.verdict, config.claudeJudgeModel);

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

  deps.appendValidationLog(config, {
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
