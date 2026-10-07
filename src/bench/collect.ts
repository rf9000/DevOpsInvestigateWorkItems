import type { AppConfig, WorkItemResponse } from '../types/index.ts';

/** One replayable benchmark case: a closed bug and the files its real fix changed. */
export interface BenchCase {
  id: number;
  title: string;
  /**
   * Kind of the link that gives the base commit (a PR when there is one). `none`: no
   * fix yet, so the case runs against HEAD and only measures cost and behavior.
   */
  source: 'pr' | 'commit' | 'none';
  /** Commit the agent investigates: the code as it was before the fix. */
  baseCommit: string;
  /** Repo paths changed by every fix link, deduplicated. Empty means unscored. */
  fixFiles: string[];
  fixLinks: string[];
}

export interface ArtifactLink {
  kind: 'pr' | 'commit';
  project: string;
  repoId: string;
  /** PR number or commit SHA. */
  ref: string;
}

const LINK_KINDS: Record<string, ArtifactLink['kind']> = {
  PullRequestId: 'pr',
  Commit: 'commit',
};

/** Parse `vstfs:///Git/PullRequestId/{proj}%2F{repo}%2F{pr}` or `vstfs:///Git/Commit/{proj}%2F{repo}%2F{sha}`. */
export function parseArtifactLink(url: string): ArtifactLink | null {
  const m = url.match(/^vstfs:\/\/\/Git\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const kind = LINK_KINDS[m[1]!];
  if (!kind) return null;
  const parts = decodeURIComponent(m[2]!).split('/');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const [project, repoId, ref] = parts as [string, string, string];
  return { kind, project, repoId, ref };
}

/** Repo name from an Azure DevOps git remote URL (https, ssh or visualstudio.com). */
export function repoNameFromRemote(remote: string): string | null {
  const trimmed = remote.trim();
  const https = trimmed.match(/\/_git\/([^/?#]+)/);
  const ssh = trimmed.match(/^[^@]+@ssh\.dev\.azure\.com:v3\/[^/]+\/[^/]+\/([^/]+)$/);
  const raw = https?.[1] ?? ssh?.[1];
  if (!raw) return null;
  return decodeURIComponent(raw).replace(/\.git$/i, '');
}

export interface CollectDeps {
  queryClosedBugs: (config: AppConfig, featureIds: number[]) => Promise<number[]>;
  getItems: (config: AppConfig, ids: number[]) => Promise<WorkItemResponse[]>;
  getRepositoryName: (project: string, repoId: string) => Promise<string>;
  /** Target branch commit the PR merged into, i.e. the code before the fix. */
  getPullRequestBase: (project: string, repoId: string, prId: number) => Promise<string | null>;
  getPullRequestFiles: (project: string, repoId: string, prId: number) => Promise<string[]>;
  getCommitFiles: (project: string, repoId: string, sha: string) => Promise<string[]>;
  /** Full SHA of a ref in the local target repo, or null when it is not there. */
  resolveCommit: (ref: string) => Promise<string | null>;
}

export interface CollectOptions {
  limit: number;
  /**
   * Collect exactly these work items instead of querying closed bugs. One
   * without a fix link becomes an unscored case at HEAD instead of being skipped.
   */
  ids?: number[];
  /** Only fix links into this repo count; compared case-insensitively. */
  repoName: string;
}

export interface CollectResult {
  cases: BenchCase[];
  skipped: Array<{ id: number; reason: string }>;
}

export async function collectCases(
  config: AppConfig,
  options: CollectOptions,
  deps: CollectDeps,
): Promise<CollectResult> {
  const explicit = options.ids !== undefined;
  const ids = options.ids ?? await deps.queryClosedBugs(config, config.featureWorkItemIds);
  const items = await deps.getItems(config, ids);
  if (explicit) {
    // Keep the order the caller gave.
    items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  } else {
    // Newest first: recent fixes match the current code and skills best.
    items.sort((a, b) =>
      String(b.fields['System.ChangedDate'] ?? '').localeCompare(String(a.fields['System.ChangedDate'] ?? '')));
  }

  const repoNames = new Map<string, Promise<string>>();
  const repoName = (project: string, repoId: string) => {
    if (!repoNames.has(repoId)) repoNames.set(repoId, deps.getRepositoryName(project, repoId));
    return repoNames.get(repoId)!;
  };
  const target = options.repoName.toLowerCase();

  const cases: BenchCase[] = [];
  const skipped: CollectResult['skipped'] = [];

  for (const item of items) {
    if (cases.length >= options.limit) break;

    const links: ArtifactLink[] = [];
    for (const rel of item.relations ?? []) {
      const link = parseArtifactLink(rel.url);
      if (link && (await repoName(link.project, link.repoId)).toLowerCase() === target) {
        links.push(link);
      }
    }
    if (links.length === 0 && explicit) {
      const head = await deps.resolveCommit('HEAD');
      if (!head) {
        skipped.push({ id: item.id, reason: 'HEAD of the target repo could not be resolved' });
        continue;
      }
      cases.push({
        id: item.id,
        title: String(item.fields['System.Title'] ?? ''),
        source: 'none',
        baseCommit: head,
        fixFiles: [],
        fixLinks: [],
      });
      continue;
    }
    if (links.length === 0) {
      skipped.push({ id: item.id, reason: 'no PR or commit link into the target repo' });
      continue;
    }

    try {
      const files = new Set<string>();
      for (const link of links) {
        const changed = link.kind === 'pr'
          ? await deps.getPullRequestFiles(link.project, link.repoId, Number(link.ref))
          : await deps.getCommitFiles(link.project, link.repoId, link.ref);
        for (const f of changed) files.add(f);
      }
      if (files.size === 0) {
        skipped.push({ id: item.id, reason: 'fix links changed no files' });
        continue;
      }

      // Prefer a PR: its merge target is before every commit in it. ADO lists
      // relations in no fixed order, so `commit^` of an arbitrary linked commit
      // can already contain earlier commits of the same fix.
      const first = links.find((l) => l.kind === 'pr') ?? links[0]!;
      const baseRef = first.kind === 'pr'
        ? await deps.getPullRequestBase(first.project, first.repoId, Number(first.ref))
        : `${first.ref}^`;
      const baseCommit = baseRef ? await deps.resolveCommit(baseRef) : null;
      if (!baseCommit) {
        skipped.push({ id: item.id, reason: `base commit ${baseRef ?? '(unknown)'} not found locally; fetch the target repo` });
        continue;
      }

      cases.push({
        id: item.id,
        title: String(item.fields['System.Title'] ?? ''),
        source: first.kind,
        baseCommit,
        fixFiles: [...files],
        fixLinks: links.map((l) => `${l.kind}:${l.ref}`),
      });
    } catch (err) {
      skipped.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { cases, skipped };
}
