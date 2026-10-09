import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AppConfig, WorkItemComment, WorkItemResponse, WorkItemSummary } from '../types/index.ts';
import type { SearchWorkItemsOptions } from '../sdk/azure-devops-client.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import { stripHtmlToText } from '../utils/html.ts';

/** In-process MCP server name; tools appear to the agent as mcp__workitems__<tool>. */
export const ADO_TOOLS_SERVER = 'workitems';

export interface AdoToolDeps {
  searchWorkItems: (config: AppConfig, keywords: string[], options: SearchWorkItemsOptions) => Promise<WorkItemSummary[]>;
  getWorkItem: (config: AppConfig, id: number) => Promise<WorkItemResponse>;
  getWorkItemComments: (config: AppConfig, id: number) => Promise<WorkItemComment[]>;
}

const defaultDeps: AdoToolDeps = {
  searchWorkItems: sdk.searchWorkItems,
  getWorkItem: sdk.getWorkItem,
  getWorkItemComments: (config, id) => sdk.getWorkItemComments(config, id, 5),
};

export interface AdoToolScope {
  /** The item being triaged: never returned, so it cannot match itself. */
  currentId: number;
  /** Replays hide anything created after the bug, and every comment, so the fix cannot leak in. */
  replay?: { createdBefore: string };
}

const MAX_TEXT = 2000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export async function searchTool(
  config: AppConfig,
  scope: AdoToolScope,
  keywords: string[],
  deps: AdoToolDeps = defaultDeps,
): Promise<string> {
  const results = await deps.searchWorkItems(config, keywords, {
    excludeId: scope.currentId,
    ...(scope.replay ? { createdBefore: scope.replay.createdBefore } : {}),
  });
  if (results.length === 0) return 'No matching work items.';
  return results.map((r) => `#${r.id} [${r.type}, ${r.state}, created ${r.createdDate.slice(0, 10)}] ${r.title}`).join('\n');
}

export async function getWorkItemTool(
  config: AppConfig,
  scope: AdoToolScope,
  id: number,
  deps: AdoToolDeps = defaultDeps,
): Promise<string> {
  if (id === scope.currentId) return 'That is the work item being triaged; its content is already in the prompt.';
  const item = await deps.getWorkItem(config, id);
  const f = item.fields;
  const created = String(f['System.CreatedDate'] ?? '');
  if (scope.replay && created && created >= scope.replay.createdBefore) {
    return `Work item #${id} is not available.`;
  }

  const lines = [
    `#${id} ${String(f['System.Title'] ?? '')}`,
    `Type: ${String(f['System.WorkItemType'] ?? '')} | State: ${String(f['System.State'] ?? '')} | Created: ${created.slice(0, 10)}`,
  ];
  const description = stripHtmlToText(String(f['System.Description'] ?? ''));
  if (description) lines.push('', 'Description:', clip(description));
  const repro = stripHtmlToText(String(f['Microsoft.VSTS.TCM.ReproSteps'] ?? ''));
  if (repro) lines.push('', 'Repro steps:', clip(repro));

  if (!scope.replay) {
    const comments = await deps.getWorkItemComments(config, id);
    if (comments.length > 0) {
      lines.push('', 'Recent comments:');
      for (const c of comments) lines.push(`- ${c.author} (${c.createdDate.slice(0, 10)}): ${clip(c.text)}`);
    }
  }
  return lines.join('\n');
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

async function safely(run: () => Promise<string>) {
  try {
    return text(await run());
  } catch (err) {
    return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
  }
}

/** Read-only work item tools for duplicate detection. */
export function createAdoToolServer(
  config: AppConfig,
  scope: AdoToolScope,
  deps: AdoToolDeps = defaultDeps,
): McpServerConfig {
  return createSdkMcpServer({
    name: ADO_TOOLS_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'search_work_items',
        'Search Azure DevOps work items (any state) whose title or description contain ALL the given keywords. Returns up to 20, newest first. Use 1-3 distinctive keywords per search; run several searches with different words.',
        { keywords: z.array(z.string()).min(1).max(6) },
        async (args) => safely(() => searchTool(config, scope, args.keywords, deps)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'get_work_item',
        'Read one Azure DevOps work item: title, type, state, description, repro steps and recent comments.',
        { id: z.number().int().positive() },
        async (args) => safely(() => getWorkItemTool(config, scope, args.id, deps)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
