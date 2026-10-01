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
  attachmentMaxBytes: number;
  attachmentMaxCount: number;
  promptPath: string;
  assignedToFilter: string[];
  reinvestigateTag: string;
  stateDir: string;
  costLogPath: string;
  dryRun: boolean;
}

/** A link from a work item to another item or file, returned under $expand=all. */
export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
  relations?: WorkItemRelation[];
}

/** A single comment on a work item's discussion thread. */
export interface WorkItemComment {
  id: number;
  text: string;
  createdDate?: string;
  createdBy?: { displayName?: string };
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

/** What one LLM call cost. Messages API calls report tokens only, so their `usd` is 0. */
export interface CallSpend {
  usd: number;
  /** Uncached input tokens — only the part of the prompt the cache did not serve. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens written into the prompt cache. */
  cacheCreationInputTokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadInputTokens: number;
  /** Agent turns; 0 for a single Messages API call. */
  turns: number;
  models: string[];
}

/**
 * Spend summed over every call one step made. Same shape as DevOpsCoder's
 * StepSpend, so one dashboard reader handles both ledgers.
 */
export interface StepSpend {
  /** Cumulative USD across every call this step made. */
  usd: number;
  /** How many LLM calls this step made. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Cumulative agent turns, summed across calls. */
  turns: number;
  /** Distinct models this step ran on, in first-seen order. */
  models: string[];
}

/** One line of the cost ledger (JSONL): one record per processed work item. */
export interface CostRecord {
  /** ISO timestamp of when processing finished. */
  at: string;
  workItemId: number;
  outcome: 'completed' | 'failed';
  /** USD across the agent passes. Judge and extraction calls add tokens but no USD. */
  costUsd: number;
  /** Keyed by step: investigate:A, investigate:B, investigate:tiebreak, extract, judge. */
  perStage: Record<string, StepSpend>;
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

