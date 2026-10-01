import type {
  AppConfig,
  BugProcessResult,
  ImageAttachment,
  WorkItemComment,
  WorkItemResponse,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';
import type { AttachmentDownload } from '../sdk/azure-devops-client.ts';
import type { DiscoveredSkill } from './skill-loader.ts';
import type { MaterializedAttachment, SkippedAttachment } from './attachments.ts';

import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { marked } from 'marked';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as orchestrator from './investigation-orchestrator.ts';
import * as sl from './skill-loader.ts';
import { extractImageUrls, stripHtmlToText } from '../utils/html.ts';
import { materializeAttachments, selectAttachmentRelations } from './attachments.ts';
import { formatCommentThread } from './comments.ts';

export interface ProcessorDeps {
  getWorkItem: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemResponse>;

  runInvestigation: (
    config: AppConfig,
    bugId: number,
    context: InvestigationContext,
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

  downloadAttachmentRaw: (
    config: AppConfig,
    attachmentUrl: string,
    maxBytes: number,
  ) => Promise<Buffer>;

  getWorkItemComments: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemComment[]>;
}

const defaultDeps: ProcessorDeps = {
  getWorkItem: sdk.getWorkItem,
  runInvestigation: orchestrator.runInvestigation,
  addWorkItemComment: sdk.addWorkItemComment,
  discoverTargetRepoSkills: sl.discoverTargetRepoSkills,
  downloadAttachment: sdk.downloadAttachment,
  downloadAttachmentRaw: sdk.downloadAttachmentRaw,
  getWorkItemComments: sdk.getWorkItemComments,
};

/**
 * Read an attachment filename out of a URL query string. The value is
 * work-item data, so a malformed escape sequence is expected input rather than
 * a programming error — decodeURIComponent throws on those.
 */
function decodeFileName(encoded: string | undefined): string {
  if (!encoded) return 'comment-image';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function log(message: string): void {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export async function processBug(
  config: AppConfig,
  bugId: number,
  deps: ProcessorDeps = defaultDeps,
): Promise<BugProcessResult> {
  log(`Processing Bug #${bugId}...`);

  // Scratch space for this bug's attachments. Held outside the try so the
  // finally can always clear it, and reused across all investigation passes.
  const attachmentDir = join(tmpdir(), 'ado-attachments', String(bugId));

  try {
    const workItem = await deps.getWorkItem(config, bugId);

    const bugTitle = String(workItem.fields['System.Title'] ?? '');
    const rawDescription = String(workItem.fields['System.Description'] ?? '');
    const rawReproSteps = String(
      workItem.fields['Microsoft.VSTS.TCM.ReproSteps'] ?? '',
    );

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

    // The discussion often carries the detail the description lacks, but a
    // failure to read it must not cost us the investigation.
    let rawComments: WorkItemComment[] = [];
    try {
      rawComments = await deps.getWorkItemComments(config, bugId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`  Bug #${bugId}: Skipping comments — ${errMsg}`);
    }
    const comments = formatCommentThread(rawComments);

    // Attachments-tab files land on disk; the agent reads only what it needs.
    // Images pasted into comments are attachments too, so they join the same
    // directory rather than being lost when the comment HTML is stripped.
    const commentImages = extractImageUrls(
      rawComments.map((c) => String(c.text ?? '')).join(''),
      config.attachmentMaxCount,
    ).map((img) => ({
      url: img.url,
      fileName: decodeFileName(img.url.match(/fileName=([^&]+)/)?.[1]),
    }));

    const candidates = [
      ...selectAttachmentRelations(workItem.relations, config.attachmentMaxCount),
      ...commentImages,
    ].slice(0, config.attachmentMaxCount);
    let attachments: MaterializedAttachment[] = [];
    let skippedAttachments: SkippedAttachment[] = [];
    if (candidates.length > 0) {
      const materialized = await materializeAttachments(
        candidates,
        attachmentDir,
        (url) => deps.downloadAttachmentRaw(config, url, config.attachmentMaxBytes),
        { maxBytes: config.attachmentMaxBytes },
      );
      attachments = materialized.saved;
      skippedAttachments = materialized.skipped;
      log(
        `  Bug #${bugId}: ${attachments.length} attachment(s) available` +
          (skippedAttachments.length > 0 ? `, ${skippedAttachments.length} skipped` : ''),
      );
    }

    const context: InvestigationContext = {
      bugTitle,
      bugDescription,
      bugReproSteps,
      discoveredSkills,
      images,
      attachments,
      skippedAttachments,
      comments,
    };

    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.runInvestigation(config, bugId, context);

    if (!output || !output.trim()) {
      log(`  Bug #${bugId}: Investigation returned empty result — skipping comment`);
      return { bugId, investigated: false, error: 'Investigation returned empty result' };
    }

    // Strip any preamble before first ### header
    const headerIndex = output.indexOf('### ');
    const cleanedOutput = headerIndex > 0 ? output.slice(headerIndex) : output;

    // Append reinvestigate tag footer
    const footer = `\n\n---\n*If you want the agent to investigate again, tag the work item with: \`${config.reinvestigateTag}\`*`;
    const finalOutput = cleanedOutput + footer;

    if (config.dryRun) {
      log(`  Bug #${bugId}: [DRY RUN] Investigation result:\n${finalOutput}`);
      return { bugId, investigated: true };
    }

    const commentHtml = await marked(finalOutput);
    await deps.addWorkItemComment(config, bugId, commentHtml);
    log(`  Bug #${bugId}: Investigation posted as comment`);

    return { bugId, investigated: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${bugId}: Error — ${errorMsg}`);
    return { bugId, investigated: false, error: errorMsg };
  } finally {
    try {
      rmSync(attachmentDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log(`  Bug #${bugId}: Warning — failed to clear attachment dir: ${cleanupErr}`);
    }
  }
}
