import type {
  AppConfig,
  BugProcessResult,
  ImageAttachment,
  WorkItemResponse,
  Skill,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';
import type { AttachmentDownload } from '../sdk/azure-devops-client.ts';
import type { DiscoveredSkill } from './skill-loader.ts';

import { marked } from 'marked';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as inv from './investigator.ts';
import * as sl from './skill-loader.ts';
import { extractImageUrls, stripHtmlToText } from '../utils/html.ts';

export interface ProcessorDeps {
  getWorkItem: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemResponse>;

  investigateBug: (
    config: AppConfig,
    context: InvestigationContext,
  ) => Promise<string>;

  addWorkItemComment: (
    config: AppConfig,
    workItemId: number,
    commentHtml: string,
  ) => Promise<unknown>;

  loadSkills: (skillsDir: string) => Promise<Skill[]>;

  discoverTargetRepoSkills: (targetRepoPath: string) => DiscoveredSkill[];

  downloadAttachment: (
    config: AppConfig,
    attachmentUrl: string,
  ) => Promise<AttachmentDownload>;
}

const defaultDeps: ProcessorDeps = {
  getWorkItem: sdk.getWorkItem,
  investigateBug: inv.investigateBug,
  addWorkItemComment: sdk.addWorkItemComment,
  loadSkills: sl.loadSkills,
  discoverTargetRepoSkills: sl.discoverTargetRepoSkills,
  downloadAttachment: sdk.downloadAttachment,
};

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

    const skills = await deps.loadSkills(config.skillsDir);
    const discoveredSkills = deps.discoverTargetRepoSkills(config.targetRepoPath);

    if (discoveredSkills.length > 0) {
      log(`  Bug #${bugId}: Discovered ${discoveredSkills.length} invocable skill(s) in target repo`);
    }

    const context: InvestigationContext = {
      bugTitle,
      bugDescription,
      bugReproSteps,
      skills,
      discoveredSkills,
      images,
    };

    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.investigateBug(config, context);

    if (!output || !output.trim()) {
      log(`  Bug #${bugId}: Investigation returned empty result — skipping comment`);
      return { bugId, investigated: false, error: 'Investigation returned empty result' };
    }

    if (config.dryRun) {
      log(`  Bug #${bugId}: [DRY RUN] Investigation result:\n${output}`);
      return { bugId, investigated: true };
    }

    const commentHtml = await marked(output);
    await deps.addWorkItemComment(config, bugId, commentHtml);
    log(`  Bug #${bugId}: Investigation posted as comment`);

    return { bugId, investigated: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${bugId}: Error — ${errorMsg}`);
    return { bugId, investigated: false, error: errorMsg };
  }
}
