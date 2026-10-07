import type { BenchRow } from './run.ts';

export interface VariantSummary {
  variant: string;
  runs: number;
  failed: number;
  /** Count per route of runs a variant chose not to investigate in depth. */
  gated: Record<string, number>;
  totalUsd: number;
  meanUsd: number;
  meanDurationMs: number;
  p90DurationMs: number;
  meanTurns: number;
  /** Runs on cases with a known fix; the quality fields below cover only these. */
  scoredRuns: number;
  /** Over scored runs; a failed or gated run scores 0, because the case has a real fix. */
  meanRecall: number;
  /** Over completed scored runs only. */
  meanRecallInvestigated: number;
  anyHitRate: number;
  /** Over scored runs that cited at least one file. */
  meanPrecision: number | null;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function p90(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!;
}

function groupBy<K, T>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

export function summarize(rows: BenchRow[]): VariantSummary[] {
  return [...groupBy(rows, (r) => r.variant)].map(([variant, rs]) => {
    // Rows written before `scored` existed always had a fix.
    const scored = rs.filter((r) => r.scored !== false);
    const completed = scored.filter((r) => r.outcome === 'completed');
    const gated: Record<string, number> = {};
    for (const r of rs) {
      if (r.outcome.startsWith('gated:')) {
        const route = r.outcome.slice('gated:'.length);
        gated[route] = (gated[route] ?? 0) + 1;
      }
    }
    const precisions = scored.map((r) => r.refPrecision).filter((p): p is number => p !== null);
    const totalUsd = rs.reduce((n, r) => n + r.costUsd, 0);

    return {
      variant,
      runs: rs.length,
      failed: rs.filter((r) => r.outcome === 'failed').length,
      gated,
      totalUsd,
      meanUsd: totalUsd / rs.length,
      meanDurationMs: mean(rs.map((r) => r.durationMs)),
      p90DurationMs: p90(rs.map((r) => r.durationMs)),
      meanTurns: mean(rs.map((r) => r.turns)),
      scoredRuns: scored.length,
      meanRecall: mean(scored.map((r) => r.fileRecall)),
      meanRecallInvestigated: mean(completed.map((r) => r.fileRecall)),
      anyHitRate: mean(scored.map((r) => (r.anyFileHit ? 1 : 0))),
      meanPrecision: precisions.length === 0 ? null : mean(precisions),
    };
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(0)}s`;

export function renderReport(rows: BenchRow[]): string {
  const summaries = summarize(rows);
  const variants = summaries.map((s) => s.variant);
  const lines: string[] = [];

  lines.push('## Summary', '');
  lines.push('| variant | runs | scored | failed | gated | total cost | mean cost | mean time | p90 time | mean turns | recall (all) | recall (investigated) | any hit | precision |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    const gated = Object.entries(s.gated).map(([k, v]) => `${k}: ${v}`).join(', ') || '-';
    lines.push(`| ${s.variant} | ${s.runs} | ${s.scoredRuns} | ${s.failed} | ${gated} | ${usd(s.totalUsd)} | ${usd(s.meanUsd)} | ${secs(s.meanDurationMs)} | ${secs(s.p90DurationMs)} | ${s.meanTurns.toFixed(1)} | ${pct(s.meanRecall)} | ${pct(s.meanRecallInvestigated)} | ${pct(s.anyHitRate)} | ${s.meanPrecision === null ? '-' : pct(s.meanPrecision)} |`);
  }

  // Per case: mean over repeats, with the recall range to show run-to-run variance.
  lines.push('', '## Per case', '');
  lines.push(`| case | title | ${variants.map((v) => `${v} cost | ${v} recall | ${v} outcome`).join(' | ')} |`);
  lines.push(`|---|---|${variants.map(() => '---|---|---|').join('')}`);
  for (const [caseId, rs] of [...groupBy(rows, (r) => r.caseId)].sort((a, b) => a[0] - b[0])) {
    const cells = variants.map((v) => {
      const vr = rs.filter((r) => r.variant === v);
      if (vr.length === 0) return '- | - | -';
      const recalls = vr.map((r) => r.fileRecall);
      const lo = Math.min(...recalls);
      const hi = Math.max(...recalls);
      const recall = vr[0]!.scored === false ? 'n/a'
        : lo === hi ? pct(lo) : `${pct(mean(recalls))} (${pct(lo)}-${pct(hi)})`;
      const outcomes = [...new Set(vr.map((r) => r.outcome))].join(', ');
      return `${usd(mean(vr.map((r) => r.costUsd)))} | ${recall} | ${outcomes}`;
    });
    const title = (rs[0]!.title ?? '').replace(/\|/g, '/').slice(0, 60);
    lines.push(`| ${caseId} | ${title} | ${cells.join(' | ')} |`);
  }

  return lines.join('\n') + '\n';
}

const CSV_COLUMNS = [
  'runId', 'variant', 'caseId', 'title', 'repeat', 'outcome', 'error', 'costUsd', 'turns', 'durationMs',
  'models', 'scored', 'fileRecall', 'anyFileHit', 'refPrecision', 'matchedFixFiles', 'codeRefs', 'fixFiles',
] as const;

function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join(';') : value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: BenchRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
