import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { CostRecord } from '../types/index.ts';

/**
 * Append one record to the JSONL cost ledger. Same format as DevOpsCoder's
 * ledger, so the dashboard reads both bots with one parser. Throws on I/O
 * errors; the caller decides whether that matters.
 */
export function appendCostRecord(path: string, record: CostRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}
