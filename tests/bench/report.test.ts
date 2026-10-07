import { describe, test, expect } from 'bun:test';
import type { BenchRow } from '../../src/bench/run.ts';
import { summarize, renderReport, toCsv } from '../../src/bench/report.ts';

function row(p: Partial<BenchRow>): BenchRow {
  return {
    runId: 'r', at: '2026-10-07T00:00:00Z', variant: 'legacy', caseId: 1, title: 't', repeat: 1,
    outcome: 'completed', costUsd: 1, perStage: {}, turns: 10, durationMs: 1000, models: ['m'],
    codeRefs: [], fixFiles: ['a'], scored: true, matchedFixFiles: [], fileRecall: 0, anyFileHit: false, refPrecision: null,
    ...p,
  };
}

const rows: BenchRow[] = [
  row({ variant: 'legacy', caseId: 1, costUsd: 2, durationMs: 1000, turns: 10, fileRecall: 1, anyFileHit: true, refPrecision: 0.5 }),
  row({ variant: 'legacy', caseId: 2, costUsd: 4, durationMs: 3000, turns: 20, fileRecall: 0, refPrecision: 0 }),
  row({ variant: 'legacy', caseId: 2, repeat: 2, outcome: 'failed', costUsd: 0, durationMs: 2000, turns: 0 }),
  row({ variant: 'triage', caseId: 1, costUsd: 1, durationMs: 500, turns: 5, fileRecall: 1, anyFileHit: true, refPrecision: 1 }),
  row({ variant: 'triage', caseId: 2, costUsd: 0.2, outcome: 'gated:needs_info', fileRecall: 0 }),
  row({ variant: 'legacy', caseId: 3, costUsd: 3, durationMs: 2000, turns: 10, fixFiles: [], scored: false }),
];

describe('summarize', () => {
  test('aggregates cost, time, turns, quality and outcomes per variant', () => {
    const [legacy, triage] = summarize(rows);

    expect(legacy!.variant).toBe('legacy');
    expect(legacy!.runs).toBe(4);
    expect(legacy!.scoredRuns).toBe(3);
    expect(legacy!.failed).toBe(1);
    expect(legacy!.totalUsd).toBe(9);
    expect(legacy!.meanUsd).toBe(2.25);
    expect(legacy!.meanDurationMs).toBe(2000);
    expect(legacy!.p90DurationMs).toBe(3000);
    expect(legacy!.meanTurns).toBe(10);
    // Unscored case 3 counts for cost but not for quality.
    expect(legacy!.meanRecall).toBeCloseTo(1 / 3);
    expect(legacy!.meanRecallInvestigated).toBe(0.5);
    expect(legacy!.anyHitRate).toBeCloseTo(1 / 3);
    expect(legacy!.meanPrecision).toBe(0.25);

    expect(triage!.gated).toEqual({ needs_info: 1 });
    expect(triage!.meanRecallInvestigated).toBe(1);
  });
});

describe('renderReport', () => {
  test('includes a summary row per variant and a per-case comparison', () => {
    const md = renderReport(rows);
    expect(md).toContain('| legacy |');
    expect(md).toContain('| triage |');
    expect(md).toContain('needs_info: 1');
    expect(md).toMatch(/\| 2 \|.*gated:needs_info/);
    expect(md).toMatch(/\| 3 \|.*n\/a/);
  });
});

describe('toCsv', () => {
  test('writes one line per row with quoted text fields', () => {
    const csv = toCsv([row({ title: 'has, comma "and quote"' })]);
    const [header, line] = csv.trim().split('\n');
    expect(header).toContain('variant,caseId');
    expect(line).toContain('"has, comma ""and quote"""');
  });
});
