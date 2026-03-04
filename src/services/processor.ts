import type {
  AppConfig,
  BugProcessResult,
  WorkItemResponse,
  Skill,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';

import * as sdk from '../sdk/azure-devops-client.ts';
import * as inv from './investigator.ts';
import * as sl from './skill-loader.ts';

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
}

const defaultDeps: ProcessorDeps = {
  getWorkItem: sdk.getWorkItem,
  investigateBug: inv.investigateBug,
  addWorkItemComment: sdk.addWorkItemComment,
  loadSkills: sl.loadSkills,
};

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
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
    const bugDescription = String(workItem.fields['System.Description'] ?? '');
    const bugReproSteps = String(
      workItem.fields['Microsoft.VSTS.TCM.ReproSteps'] ?? '',
    );

    log(`  Bug #${bugId}: "${bugTitle}"`);

    const skills = await deps.loadSkills(config.skillsDir);

    const context: InvestigationContext = {
      bugTitle,
      bugDescription,
      bugReproSteps,
      skills,
    };

    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.investigateBug(config, context);

    if (config.dryRun) {
      log(`  Bug #${bugId}: [DRY RUN] Investigation result:\n${output}`);
      return { bugId, investigated: true };
    }

    await deps.addWorkItemComment(config, bugId, output);
    log(`  Bug #${bugId}: Investigation posted as comment`);

    return { bugId, investigated: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`  Bug #${bugId}: Error — ${errorMsg}`);
    return { bugId, investigated: false, error: errorMsg };
  }
}
