import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { AppConfig, ValidationLogEntry } from '../types/index.ts';

export function appendValidationLog(config: AppConfig, entry: ValidationLogEntry): void {
  const filePath = join(config.stateDir, 'validation-log.jsonl');
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}
