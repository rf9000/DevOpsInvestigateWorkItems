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
  promptPath: string;
  assignedToFilter: string[];
  reinvestigateTag: string;
  stateDir: string;
  costLogPath: string;
  dryRun: boolean;
}

/** Response shape when fetching a single work item. */
export interface WorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
  rev: number;
  url: string;
  /** Present when fetched with `$expand=all` or `$expand=relations`. */
  relations?: WorkItemRelation[];
}

/** A link from a work item to another work item or an artifact (commit, PR, ...). */
export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
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

/** Structured result from a bug investigation. */
export interface InvestigationResult {
  bugId: number;
  isValid: boolean | 'uncertain';
  rootCause: string;
  reproduction: string;
  fixSuggestion: string;
  ambiguities: string[];
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
  /** The work item's System.Title, when it was fetched before the run ended. */
  title?: string;
  outcome: 'completed' | 'failed';
  /** USD reported by the Agent SDK across the investigation pass(es). */
  costUsd: number;
  /** Keyed by step; this bot currently records a single `investigate` step. */
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

