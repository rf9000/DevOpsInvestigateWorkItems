import type { WorkItemUpdate } from '../types/index.ts';

export const AUTOMATIC = 'automatic';
export const UNKNOWN = 'unknown';

/** Split an ADO `System.Tags` string ("a; b; c") into trimmed, lowercased, non-empty tags. */
function splitTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Lowercased uniqueName of the most recent revision that added any of `tags`;
 * UNKNOWN when none. Scans newest-first so a re-tag credits whoever asked for
 * the current attempt, not whoever asked first.
 */
export function triggeredByFrom(updates: WorkItemUpdate[], tags: string[]): string {
  const needles = tags.map((t) => t.trim().toLowerCase());
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    const change = update?.fields?.['System.Tags'];
    if (!update || !change) continue;

    const before = splitTags(change.oldValue);
    const after = splitTags(change.newValue);
    if (!needles.some((n) => after.includes(n) && !before.includes(n))) continue;

    const name = update.revisedBy?.uniqueName;
    return name ? name.toLowerCase() : UNKNOWN;
  }
  return UNKNOWN;
}

/**
 * Never throws and never waits longer than `timeoutMs`: fetch errors or a
 * timeout → warn once + UNKNOWN. ADO retries sleep between attempts, and a run
 * must not wait on a failed "who" lookup.
 */
export async function lookupTriggeredBy(
  fetchUpdates: () => Promise<WorkItemUpdate[]>,
  tags: string[],
  warn: (msg: string) => void,
  timeoutMs = 10_000,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return triggeredByFrom(await Promise.race([fetchUpdates(), timeout]), tags);
  } catch (err) {
    warn(`triggeredBy lookup failed :: ${err instanceof Error ? err.message : String(err)}`);
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}
