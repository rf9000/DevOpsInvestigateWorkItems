import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkItemRelation } from '../types/index.ts';

const FALLBACK_FILE_NAME = 'attachment';

const ATTACHED_FILE_REL = 'AttachedFile';

/** An attachment relation worth downloading, before any name sanitization. */
export interface AttachmentCandidate {
  url: string;
  fileName: string;
}

/**
 * Pick the downloadable file attachments out of a work item's relations.
 * Hierarchy links, artifact links and hyperlinks all share the relations array,
 * so only AttachedFile entries are of interest here.
 */
export function selectAttachmentRelations(
  relations: WorkItemRelation[] | undefined,
  maxCount: number,
): AttachmentCandidate[] {
  const candidates: AttachmentCandidate[] = [];

  for (const rel of relations ?? []) {
    if (candidates.length >= maxCount) break;
    if (rel.rel !== ATTACHED_FILE_REL) continue;
    if (!rel.url) continue;

    const rawName = rel.attributes?.['name'];
    const fileName =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim()
        : FALLBACK_FILE_NAME;

    candidates.push({ url: rel.url, fileName });
  }

  return candidates;
}

/**
 * Turn an Azure DevOps attachment name into a filename safe to write inside a
 * scratch directory. The name comes from work item data, so it is untrusted:
 * directory components are stripped rather than escaped, and collisions are
 * resolved against names already claimed in the same directory.
 */
export function sanitizeAttachmentFileName(
  rawName: string,
  taken: Set<string>,
): string {
  // Take the last path segment under either separator, so traversal sequences
  // collapse to a bare name instead of escaping the directory.
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();

  let safe = cleaned.replace(/^\.+$/, '');
  if (!safe) safe = FALLBACK_FILE_NAME;

  if (!taken.has(safe)) return safe;

  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';

  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An attachment successfully written to the scratch directory. */
export interface MaterializedAttachment {
  fileName: string;
  localPath: string;
  sizeBytes: number;
}

/** An attachment that could not be made available, and why. */
export interface SkippedAttachment {
  fileName: string;
  reason: string;
}

export interface MaterializeResult {
  saved: MaterializedAttachment[];
  skipped: SkippedAttachment[];
}

export interface MaterializeOptions {
  maxBytes: number;
}

/**
 * Download each candidate into `destDir`, returning what landed on disk.
 * A single bad attachment must not sink the investigation, so download and
 * size failures are collected as skips rather than thrown.
 */
export async function materializeAttachments(
  candidates: AttachmentCandidate[],
  destDir: string,
  download: (url: string) => Promise<Buffer>,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const saved: MaterializedAttachment[] = [];
  const skipped: SkippedAttachment[] = [];

  if (candidates.length === 0) return { saved, skipped };

  mkdirSync(destDir, { recursive: true });
  const taken = new Set<string>();

  for (const candidate of candidates) {
    try {
      const data = await download(candidate.url);

      if (data.byteLength > options.maxBytes) {
        skipped.push({
          fileName: candidate.fileName,
          reason: `exceeds ${options.maxBytes} byte limit (${data.byteLength} bytes)`,
        });
        continue;
      }

      const fileName = sanitizeAttachmentFileName(candidate.fileName, taken);
      taken.add(fileName);

      const localPath = join(destDir, fileName);
      writeFileSync(localPath, data);

      saved.push({ fileName, localPath, sizeBytes: data.byteLength });
    } catch (err) {
      skipped.push({
        fileName: candidate.fileName,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { saved, skipped };
}
