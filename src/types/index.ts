/** Application configuration loaded from environment variables. */
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  featureWorkItemIds: number[];
  targetRepoPath: string;
  maxInvestigationsPerDay: number;
  skillsDir: string;
  pollIntervalMinutes: number;
  claudeModel: string;
  promptPath: string;
  assignedToFilter: string[];
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

/** Structured result from a bug investigation. */
export interface InvestigationResult {
  bugId: number;
  isValid: boolean | 'uncertain';
  rootCause: string;
  reproduction: string;
  fixSuggestion: string;
  ambiguities: string[];
}

/** Result summary after processing a single bug. */
export interface BugProcessResult {
  bugId: number;
  investigated: boolean;
  error?: string;
}

/** A skill loaded from the skills directory. */
export interface Skill {
  name: string;
  content: string;
}
