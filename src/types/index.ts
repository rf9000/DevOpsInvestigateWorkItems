/** Application configuration loaded from environment variables. */
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  featureWorkItemIds: number[];
  targetRepoPath: string;
  maxInvestigationsPerDay: number;
  pollIntervalMinutes: number;
  claudeModel: string;
  claudeJudgeModel: string;
  claudeTiebreakModel: string;
  claudeMaxTurns: number;
  promptPath: string;
  assignedToFilter: string[];
  reinvestigateTag: string;
  stateDir: string;
  dryRun: boolean;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
}

/** Persisted state tracking which bugs have already been processed. */
export interface ProcessedState {
  processedBugIds: number[];
  lastRunAt: string;
  dailyInvestigationCount: number;
  dailyCountDate: string;
}

/** A bug work item fetched from Azure DevOps. */
export interface BugWorkItem {
  id: number;
  title: string;
  description: string;
  reproSteps: string;
  state: string;
  areaPath: string;
  assignedTo: string;
}

/** Structured verdict extracted from one investigation pass's prose report. */
export interface InvestigationVerdict {
  isValid: 'yes' | 'no' | 'uncertain';
  rootCauseSummary: string;
  primaryCitation: { file: string; line?: number };
  suggestedFixSummary: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Result of comparing two investigation verdicts. */
export interface JudgeResult {
  agree: boolean;
  reason: string;
}

/** One line of the append-only validation outcome log. */
export interface ValidationLogEntry {
  bugId: number;
  timestamp: string;
  verdictA: InvestigationVerdict;
  verdictB: InvestigationVerdict;
  judgeResult: JudgeResult;
  tieBreakUsed: boolean;
  tieBreakVerdict?: InvestigationVerdict;
  finalPass: 'A' | 'B' | 'tiebreak';
}

/** Result summary after processing a single bug. */
export interface BugProcessResult {
  bugId: number;
  investigated: boolean;
  error?: string;
}

/** An image attachment downloaded from Azure DevOps. */
export interface ImageAttachment {
  base64Data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  alt: string;
}

