import type {
  AppConfig,
  WorkItemResponse,
} from '../types/index.ts';

export class AzureDevOpsError extends Error {
  override readonly name = 'AzureDevOpsError';
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function adoFetch<T>(
  config: AppConfig,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${config.orgUrl}/${config.project}/_apis/${path}`;
  const authHeader =
    'Basic ' + Buffer.from(':' + config.pat).toString('base64');

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AzureDevOpsError(
      `Azure DevOps API error ${res.status}: ${body}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

export async function adoFetchWithRetry<T>(
  config: AppConfig,
  path: string,
  options?: RequestInit,
  retryDelays: number[] = DEFAULT_RETRY_DELAYS,
): Promise<T> {
  const maxAttempts = retryDelays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await adoFetch<T>(config, path, options);
    } catch (err: unknown) {
      const isLastAttempt = attempt === maxAttempts;

      if (err instanceof AzureDevOpsError) {
        if (err.statusCode < 500) {
          throw err;
        }
        if (isLastAttempt) {
          throw err;
        }
      } else {
        if (isLastAttempt) {
          throw err;
        }
      }

      const delay = retryDelays[attempt - 1] ?? 0;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error('adoFetchWithRetry: unexpected code path');
}

export async function getWorkItem(
  config: AppConfig,
  workItemId: number,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?$expand=all&api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path);
}

export async function updateWorkItemField(
  config: AppConfig,
  workItemId: number,
  fieldName: string,
  value: string,
): Promise<WorkItemResponse> {
  const path = `wit/workitems/${workItemId}?api-version=7.0`;
  return adoFetchWithRetry<WorkItemResponse>(config, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'add', path: `/fields/${fieldName}`, value }]),
  });
}

interface WiqlWorkItemLink {
  target: { id: number };
}

interface WiqlResponse {
  workItemRelations: WiqlWorkItemLink[];
}

export async function queryBugsUnderFeatures(
  config: AppConfig,
  featureIds: number[],
): Promise<number[]> {
  const idList = featureIds.join(',');
  let wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${idList}) AND [Target].[System.WorkItemType] IN ('Bug', 'User Story') AND [Target].[System.State] NOT IN ('Resolved', 'Closed')`;

  if (config.assignedToFilter.length > 0) {
    const names = config.assignedToFilter.map((n) => `'${n}'`).join(', ');
    wiql += ` AND [Target].[System.AssignedTo] IN (${names})`;
  }

  wiql += ' MODE (MustContain)';

  const path = 'wit/wiql?api-version=7.0';
  const data = await adoFetchWithRetry<WiqlResponse>(config, path, {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });

  const bugIds: number[] = [];
  for (const rel of data.workItemRelations ?? []) {
    if (rel.target?.id) {
      bugIds.push(rel.target.id);
    }
  }

  // Deduplicate
  return [...new Set(bugIds)];
}

interface CommentResponse {
  id: number;
  text: string;
}

export async function addWorkItemComment(
  config: AppConfig,
  workItemId: number,
  commentHtml: string,
): Promise<CommentResponse> {
  const path = `wit/workitems/${workItemId}/comments?api-version=7.0-preview.4`;
  return adoFetchWithRetry<CommentResponse>(config, path, {
    method: 'POST',
    body: JSON.stringify({ text: commentHtml }),
  });
}
