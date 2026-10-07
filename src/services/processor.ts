import type {
  AppConfig,
  BugProcessResult,
  CostRecord,
  ImageAttachment,
  WorkItemResponse,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';
import type { AttachmentDownload } from '../sdk/azure-devops-client.ts';
import type { DiscoveredSkill } from './skill-loader.ts';
import type { SpendSink, SpendTracker } from './spend-tracker.ts';

import { marked } from 'marked';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as inv from './investigator.ts';
import * as sl from './skill-loader.ts';
import { extractImageUrls, stripHtmlToText } from '../utils/html.ts';
import { createSpendTracker } from './spend-tracker.ts';
import { appendCostRecord } from '../state/cost-ledger.ts';

export interface ProcessorDeps {
  getWorkItem: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemResponse>;

  investigateBug: (
    config: AppConfig,
    context: InvestigationContext,
    onSpend?: SpendSink,
  ) => Promise<string>;

  addWorkItemComment: (
    config: AppConfig,
    workItemId: number,
    commentHtml: string,
  ) => Promise<unknown>;

  discoverTargetRepoSkills: (targetRepoPath: string) => DiscoveredSkill[];

  downloadAttachment: (
    config: AppConfig,
    attachmentUrl: string,
  ) => Promise<AttachmentDownload>;

  recordCost: (config: AppConfig, entry: CostRecord) => void;
}

const defaultDeps: ProcessorDeps = {
  getWorkItem: sdk.getWorkItem,
  investigateBug: inv.investigateBug,
  addWorkItemComment: sdk.addWorkItemComment,
  discoverTargetRepoSkills: sl.discoverTargetRepoSkills,
  downloadAttachment: sdk.downloadAttachment,
  recordCost: (config, entry) => appendCostRecord(config.costLogPath, entry),
};

function log(message: string): void {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

// The ledger is bookkeeping for the dashboard, so a failed write must never
// change the outcome of a bug. Dry runs post nothing, so they record nothing.
function safeRecordCost(
  deps: ProcessorDeps,
  config: AppConfig,
  bugId: number,
  title: string | undefined,
  spend: SpendTracker,
  outcome: CostRecord['outcome'],
): void {
  if (config.dryRun) return;
  try {
    deps.recordCost(config, {
      at: new Date().toISOString(),
      workItemId: bugId,
      ...(title !== undefined ? { title } : {}),
      outcome,
      costUsd: spend.totalUsd(),
      perStage: spend.snapshot(),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${bugId}: Skipping cost ledger write — ${errMsg}`);
  }
}

/** What one pipeline run produced. Nothing has been posted or recorded yet. */
export interface PipelineResult {
  outcome: 'completed' | 'failed';
  /** Known once the work item is fetched; a failure before that has no title. */
  title?: string;
  /** The comment to post, as markdown. Only set when outcome is completed. */
  markdown?: string;
  error?: string;
  spend: SpendTracker;
}

/**
 * Fetch the work item, investigate it and render the comment. Has no side
 * effects on Azure DevOps or the ledger, so the benchmark can replay it.
 */
export async function runPipeline(
  config: AppConfig,
  bugId: number,
  deps: ProcessorDeps = defaultDeps,
): Promise<PipelineResult> {
  const spend = createSpendTracker();
  let title: string | undefined;

  try {
    const workItem = await deps.getWorkItem(config, bugId);

    const bugTitle = String(workItem.fields['System.Title'] ?? '');
    const rawDescription = String(workItem.fields['System.Description'] ?? '');
    const rawReproSteps = String(
      workItem.fields['Microsoft.VSTS.TCM.ReproSteps'] ?? '',
    );

    title = bugTitle;
    log(`  Bug #${bugId}: "${bugTitle}"`);

    // Extract image URLs from HTML fields (combined max 5)
    const extractedImages = extractImageUrls(
      rawDescription + rawReproSteps,
      5,
    );

    // Download images (skip failures gracefully)
    const images: ImageAttachment[] = [];
    for (const img of extractedImages) {
      try {
        const download = await deps.downloadAttachment(config, img.url);
        images.push({
          base64Data: download.data.toString('base64'),
          mediaType: download.mediaType,
          alt: img.alt,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`  Bug #${bugId}: Skipping image download — ${errMsg}`);
      }
    }

    if (images.length > 0) {
      log(`  Bug #${bugId}: Downloaded ${images.length} image(s)`);
    }

    // Strip HTML to plain text for cleaner prompt
    const bugDescription = stripHtmlToText(rawDescription);
    const bugReproSteps = stripHtmlToText(rawReproSteps);

    const discoveredSkills = deps.discoverTargetRepoSkills(config.targetRepoPath);

    if (discoveredSkills.length > 0) {
      log(`  Bug #${bugId}: Discovered ${discoveredSkills.length} invocable skill(s) in target repo`);
    }

    const context: InvestigationContext = {
      bugTitle,
      bugDescription,
      bugReproSteps,
      discoveredSkills,
      images,
    };

    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.investigateBug(config, context, (call) =>
      spend.add('investigate', call),
    );

    if (!output || !output.trim()) {
      return { outcome: 'failed', title, error: 'Investigation returned empty result', spend };
    }

    // Strip any preamble before first ### header
    const headerIndex = output.indexOf('### ');
    const cleanedOutput = headerIndex > 0 ? output.slice(headerIndex) : output;

    // Append reinvestigate tag footer
    const footer = `\n\n---\n*If you want the agent to investigate again, tag the work item with: \`${config.reinvestigateTag}\`*`;

    return { outcome: 'completed', title, markdown: cleanedOutput + footer, spend };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { outcome: 'failed', title, error: errorMsg, spend };
  }
}

export async function processBug(
  config: AppConfig,
  bugId: number,
  deps: ProcessorDeps = defaultDeps,
): Promise<BugProcessResult> {
  log(`Processing Bug #${bugId}...`);

  const run = await runPipeline(config, bugId, deps);
  const { title, spend } = run;

  if (run.outcome === 'failed' || run.markdown === undefined) {
    const errorMsg = run.error ?? 'unknown error';
    log(`  Bug #${bugId}: Error — ${errorMsg}`);
    safeRecordCost(deps, config, bugId, title, spend, 'failed');
    return { bugId, investigated: false, error: errorMsg };
  }

  if (config.dryRun) {
    log(`  Bug #${bugId}: [DRY RUN] Investigation result:\n${run.markdown}`);
    return { bugId, investigated: true };
  }

  try {
    const commentHtml = await marked(run.markdown);
    await deps.addWorkItemComment(config, bugId, commentHtml);
    log(`  Bug #${bugId}: Investigation posted as comment`);
    safeRecordCost(deps, config, bugId, title, spend, 'completed');
    return { bugId, investigated: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${bugId}: Error — ${errorMsg}`);
    safeRecordCost(deps, config, bugId, title, spend, 'failed');
    return { bugId, investigated: false, error: errorMsg };
  }
}
