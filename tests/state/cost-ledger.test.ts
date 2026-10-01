import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendCostRecord } from '../../src/state/cost-ledger.ts';
import type { CostRecord } from '../../src/types/index.ts';

function record(workItemId: number): CostRecord {
  return {
    at: '2026-10-01T00:00:00.000Z',
    workItemId,
    outcome: 'completed',
    costUsd: 1.25,
    perStage: {},
  };
}

describe('appendCostRecord', () => {
  test('creates missing directories and writes one JSON line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-ledger-test-'));
    const path = join(dir, 'nested', 'cost-ledger.jsonl');

    appendCostRecord(path, record(100));

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(record(100));
  });

  test('appends subsequent records rather than overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-ledger-test-'));
    const path = join(dir, 'cost-ledger.jsonl');

    appendCostRecord(path, record(100));
    appendCostRecord(path, record(101));

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).workItemId).toBe(101);
  });
});
