/** File extensions treated as source files when pulling references out of a report. */
const SOURCE_EXT = 'al|cs|ts|tsx|js|jsx|json|xml|xlf|yml|yaml|ps1|psm1|sql|cshtml|razor|csproj|sln|config|py|md';

// Inside backticks a path may contain spaces ("Bank Account\Codeunits\X.al").
const BACKTICK_SPAN = /`([^`\n]+)`/g;
const PATH_IN_SPAN = new RegExp(String.raw`^[\w .\-()\\/:]*\.(?:${SOURCE_EXT})(?::[\d\-,]+)?$`, 'i');
// Outside backticks only space-free paths are safe to match.
const BARE_PATH = new RegExp(String.raw`(?<![\w./\\-])[\w.\-\\/:]*\w\.(?:${SOURCE_EXT})(?::[\d\-,]+)?(?!\w)`, 'gi');

/** Repo-relative, case-insensitive form of a path, so refs and fix files compare equal. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\\/g, '/')
    .replace(/:\d[\d\-,]*$/, '')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/** Source file paths mentioned in a free-form markdown report, normalized and deduplicated. */
export function extractCodeRefs(markdown: string): string[] {
  const refs: string[] = [];
  const add = (raw: string) => {
    const p = normalizePath(raw);
    if (p && !refs.includes(p)) refs.push(p);
  };

  const outside = markdown.replace(BACKTICK_SPAN, (_m, span: string) => {
    if (PATH_IN_SPAN.test(span.trim())) add(span);
    return ' ';
  });
  for (const m of outside.matchAll(BARE_PATH)) add(m[0]);

  return refs;
}

function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export interface RefScore {
  /** Share of fix files that at least one ref points at. */
  fileRecall: number;
  anyFileHit: boolean;
  /** Share of refs that point at a fix file; null when there are no refs. */
  refPrecision: number | null;
  matchedFixFiles: string[];
}

/** Compare the files a report pointed at with the files the real fix changed. */
export function scoreRefs(refs: string[], fixFiles: string[]): RefScore {
  const r = refs.map(normalizePath);
  const f = fixFiles.map(normalizePath);

  const matchedFixFiles = f.filter((fix) => r.some((ref) => sameFile(ref, fix)));
  const matchedRefs = r.filter((ref) => f.some((fix) => sameFile(ref, fix)));

  return {
    fileRecall: f.length === 0 ? 0 : matchedFixFiles.length / f.length,
    anyFileHit: matchedFixFiles.length > 0,
    refPrecision: r.length === 0 ? null : matchedRefs.length / r.length,
    matchedFixFiles,
  };
}
