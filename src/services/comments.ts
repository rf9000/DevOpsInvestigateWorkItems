import type { WorkItemComment } from '../types/index.ts';
import { stripHtmlToText } from '../utils/html.ts';

const UNKNOWN_AUTHOR = 'Unknown';

/**
 * Render a work item's discussion thread as plain text for the prompt.
 * Comments arrive as HTML and in no guaranteed order, so they are stripped and
 * sorted oldest-first — the order a reader would follow the conversation in.
 */
export function formatCommentThread(comments: WorkItemComment[]): string {
  const ordered = [...comments].sort((a, b) =>
    String(a.createdDate ?? '').localeCompare(String(b.createdDate ?? '')),
  );

  const blocks: string[] = [];

  for (const comment of ordered) {
    const body = stripHtmlToText(String(comment.text ?? ''));
    if (!body.trim()) continue;

    const author = comment.createdBy?.displayName?.trim() || UNKNOWN_AUTHOR;
    const date = String(comment.createdDate ?? '').slice(0, 10);
    const heading = date ? `**${author}** (${date}):` : `**${author}**:`;

    blocks.push(`${heading}\n${body}`);
  }

  return blocks.join('\n\n---\n\n');
}
