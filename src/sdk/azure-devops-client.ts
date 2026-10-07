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

  // ADO answers a rejected PAT with a redirect to its sign-in page; followed,
  // that page arrives as 200 HTML and fails later as a confusing JSON error.
  const res = await fetch(url, {
    ...options,
    headers,
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AzureDevOpsError(
      `Azure DevOps rejected the credentials (redirect to ${res.headers.get('location')?.split('?')[0] ?? 'sign-in'}); check AZURE_DEVOPS_PAT`,
      401,
    );
  }

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

/** Escape a value for use inside a single-quoted WIQL string literal. */
export function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
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
  let wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${idList}) AND [Target].[System.WorkItemType] IN ('Bug', 'User Story') AND [Target].[System.State] NOT IN ('Resolved', 'Closed', 'Removed')`;

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

  const featureIdSet = new Set(featureIds);
  const bugIds: number[] = [];
  for (const rel of data.workItemRelations ?? []) {
    if (rel.target?.id && !featureIdSet.has(rel.target.id)) {
      bugIds.push(rel.target.id);
    }
  }

  // Deduplicate
  return [...new Set(bugIds)];
}

interface WorkItemsBatchResponse {
  value: Array<{ id: number; fields: Record<string, unknown> }>;
}

export async function queryTaggedBugsUnderFeatures(
  config: AppConfig,
  featureIds: number[],
  tag: string,
): Promise<number[]> {
  // Get all open bugs under features (no assigned-to filter)
  const idList = featureIds.join(',');
  const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${idList}) AND [Target].[System.WorkItemType] IN ('Bug', 'User Story') AND [Target].[System.State] NOT IN ('Resolved', 'Closed', 'Removed') MODE (MustContain)`;

  const path = 'wit/wiql?api-version=7.0';
  const data = await adoFetchWithRetry<WiqlResponse>(config, path, {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });

  const featureIdSet = new Set(featureIds);
  const allBugIds: number[] = [];
  for (const rel of data.workItemRelations ?? []) {
    if (rel.target?.id && !featureIdSet.has(rel.target.id)) {
      allBugIds.push(rel.target.id);
    }
  }

  const uniqueIds = [...new Set(allBugIds)];
  if (uniqueIds.length === 0) return [];

  // Batch-fetch tags (System.Tags CONTAINS is unreliable in WorkItemLinks WIQL)
  const tagLower = tag.toLowerCase();
  const taggedIds: number[] = [];
  const chunkSize = 200;

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const ids = chunk.join(',');
    const tagsPath = `wit/workitems?ids=${ids}&fields=System.Tags&api-version=7.0`;
    const tagsData = await adoFetchWithRetry<WorkItemsBatchResponse>(config, tagsPath);

    for (const item of tagsData.value ?? []) {
      const tags = String(item.fields['System.Tags'] ?? '');
      const hasTag = tags.split(';').some((t) => t.trim().toLowerCase() === tagLower);
      if (hasTag) {
        taggedIds.push(item.id);
      }
    }
  }

  return taggedIds;
}

export async function removeTagFromWorkItem(
  config: AppConfig,
  workItemId: number,
  tagToRemove: string,
): Promise<void> {
  const workItem = await getWorkItem(config, workItemId);
  const currentTags = String(workItem.fields['System.Tags'] ?? '');
  const tags = currentTags
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.toLowerCase() !== tagToRemove.toLowerCase());
  const newTags = tags.join('; ');
  // Must use "replace" — "add" on System.Tags merges instead of overwriting
  const path = `wit/workitems/${workItemId}?api-version=7.0`;
  await adoFetchWithRetry<WorkItemResponse>(config, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify([{ op: 'replace', path: '/fields/System.Tags', value: newTags }]),
  });
}

export interface AttachmentDownload {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

export async function downloadAttachment(
  config: AppConfig,
  attachmentUrl: string,
  retryDelays: number[] = DEFAULT_RETRY_DELAYS,
): Promise<AttachmentDownload> {
  const authHeader =
    'Basic ' + Buffer.from(':' + config.pat).toString('base64');
  const maxAttempts = retryDelays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(attachmentUrl, {
      headers: { Authorization: authHeader },
    });

    if (!res.ok) {
      const isLastAttempt = attempt === maxAttempts;
      if (res.status < 500 || isLastAttempt) {
        throw new AzureDevOpsError(
          `Attachment download error ${res.status}: ${attachmentUrl}`,
          res.status,
        );
      }
      const delay = retryDelays[attempt - 1] ?? 0;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    // Determine media type from Content-Type header, fallback to URL extension
    let mediaType = (res.headers.get('Content-Type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();

    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      // Fallback: infer from file extension in URL
      const extMatch = attachmentUrl.match(/fileName=.*\.(png|jpe?g|gif|webp)/i);
      if (extMatch) {
        const ext = extMatch[1]!.toLowerCase();
        mediaType =
          ext === 'jpg' ? 'image/jpeg' : (`image/${ext}` as string);
      }
    }

    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      throw new AzureDevOpsError(
        `Unsupported media type "${mediaType}" for attachment: ${attachmentUrl}`,
        0,
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_ATTACHMENT_SIZE) {
      throw new AzureDevOpsError(
        `Attachment exceeds 5MB limit (${arrayBuffer.byteLength} bytes): ${attachmentUrl}`,
        0,
      );
    }

    return {
      data: Buffer.from(arrayBuffer),
      mediaType: mediaType as AttachmentDownload['mediaType'],
    };
  }

  throw new Error('downloadAttachment: unexpected code path');
}

interface CommentResponse {
  id: number;
  text: string;
}

interface WiqlFlatResponse {
  workItems: Array<{ id: number }>;
}

export async function queryTaggedWorkItems(
  config: AppConfig,
  tag: string,
): Promise<number[]> {
  // Flat WIQL query across the entire project — not scoped to parent features
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Bug', 'User Story') AND [System.State] NOT IN ('Resolved', 'Closed', 'Removed') AND [System.Tags] CONTAINS '${escapeWiql(tag)}'`;

  const path = 'wit/wiql?api-version=7.0';
  const data = await adoFetchWithRetry<WiqlFlatResponse>(config, path, {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });

  const candidateIds = (data.workItems ?? []).map((wi) => wi.id);
  if (candidateIds.length === 0) return [];

  // Batch-fetch for exact tag matching (CONTAINS is substring-based)
  const tagLower = tag.toLowerCase();
  const taggedIds: number[] = [];
  const chunkSize = 200;

  for (let i = 0; i < candidateIds.length; i += chunkSize) {
    const chunk = candidateIds.slice(i, i + chunkSize);
    const ids = chunk.join(',');
    const tagsPath = `wit/workitems?ids=${ids}&fields=System.Tags&api-version=7.0`;
    const tagsData = await adoFetchWithRetry<WorkItemsBatchResponse>(config, tagsPath);

    for (const item of tagsData.value ?? []) {
      const tags = String(item.fields['System.Tags'] ?? '');
      const hasTag = tags.split(';').some((t) => t.trim().toLowerCase() === tagLower);
      if (hasTag) {
        taggedIds.push(item.id);
      }
    }
  }

  return taggedIds;
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

// --- Benchmark helpers: closed bugs and the files their fixes changed ---

export async function queryClosedBugsUnderFeatures(
  config: AppConfig,
  featureIds: number[],
): Promise<number[]> {
  const idList = featureIds.join(',');
  const wiql = `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${idList}) AND [Target].[System.WorkItemType] = 'Bug' AND [Target].[System.State] IN ('Resolved', 'Closed') MODE (MustContain)`;

  const data = await adoFetchWithRetry<WiqlResponse>(config, 'wit/wiql?api-version=7.0', {
    method: 'POST',
    body: JSON.stringify({ query: wiql }),
  });

  const featureIdSet = new Set(featureIds);
  const ids = (data.workItemRelations ?? [])
    .map((rel) => rel.target?.id)
    .filter((id): id is number => !!id && !featureIdSet.has(id));
  return [...new Set(ids)];
}

export async function getWorkItemsWithRelations(
  config: AppConfig,
  ids: number[],
): Promise<WorkItemResponse[]> {
  const items: WorkItemResponse[] = [];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize).join(',');
    const path = `wit/workitems?ids=${chunk}&$expand=relations&api-version=7.0`;
    const data = await adoFetchWithRetry<{ value: WorkItemResponse[] }>(config, path);
    items.push(...(data.value ?? []));
  }
  return items;
}

// Artifact links carry project and repo GUIDs; a linked repo may live in
// another project, so git calls are scoped to the project from the link.
function inProject(config: AppConfig, project: string): AppConfig {
  return { ...config, project };
}

export interface GitRepository {
  id: string;
  name: string;
}

export async function getRepository(
  config: AppConfig,
  project: string,
  repoId: string,
): Promise<GitRepository> {
  return adoFetchWithRetry<GitRepository>(
    inProject(config, project),
    `git/repositories/${repoId}?api-version=7.0`,
  );
}

export interface GitPullRequest {
  status: string;
  lastMergeTargetCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
}

export async function getPullRequest(
  config: AppConfig,
  project: string,
  repoId: string,
  prId: number,
): Promise<GitPullRequest> {
  return adoFetchWithRetry<GitPullRequest>(
    inProject(config, project),
    `git/repositories/${repoId}/pullRequests/${prId}?api-version=7.0`,
  );
}

interface GitChangeItem {
  path?: string;
  isFolder?: boolean;
  gitObjectType?: string;
}

function filePaths(changes: Array<{ item?: GitChangeItem }>): string[] {
  return changes
    .map((c) => c.item)
    .filter((item): item is GitChangeItem & { path: string } =>
      !!item?.path && !item.isFolder && item.gitObjectType !== 'tree')
    .map((item) => item.path);
}

export async function getPullRequestChangedFiles(
  config: AppConfig,
  project: string,
  repoId: string,
  prId: number,
): Promise<string[]> {
  const scoped = inProject(config, project);
  const base = `git/repositories/${repoId}/pullRequests/${prId}/iterations`;
  const iterations = await adoFetchWithRetry<{ value: Array<{ id: number }> }>(
    scoped,
    `${base}?api-version=7.0`,
  );
  const last = Math.max(...(iterations.value ?? []).map((it) => it.id));
  if (!Number.isFinite(last)) return [];

  // compareTo defaults to 0: the full diff against the common commit.
  const changes = await adoFetchWithRetry<{ changeEntries: Array<{ item?: GitChangeItem }> }>(
    scoped,
    `${base}/${last}/changes?$top=2000&api-version=7.0`,
  );
  return filePaths(changes.changeEntries ?? []);
}

export async function getCommitChangedFiles(
  config: AppConfig,
  project: string,
  repoId: string,
  commitId: string,
): Promise<string[]> {
  const data = await adoFetchWithRetry<{ changes: Array<{ item?: GitChangeItem }> }>(
    inProject(config, project),
    `git/repositories/${repoId}/commits/${commitId}/changes?$top=2000&api-version=7.0`,
  );
  return filePaths(data.changes ?? []);
}
