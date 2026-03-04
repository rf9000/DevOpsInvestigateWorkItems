import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { ProcessedState } from '../types/index.ts';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayDateStringUTCPlus1(): string {
  const now = new Date();
  const utcPlus1 = new Date(now.getTime() + 60 * 60 * 1000);
  return utcPlus1.toISOString().slice(0, 10);
}

export class StateStore {
  private filePath: string;
  private state: ProcessedState;
  private processedSet: Set<number>;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'processed-bugs.json');
    this.state = this.load();
    this.processedSet = new Set(this.state.processedBugIds);
  }

  private load(): ProcessedState {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'processedBugIds' in parsed &&
          Array.isArray((parsed as ProcessedState).processedBugIds)
        ) {
          return parsed as ProcessedState;
        }
      }
    } catch {
      // file doesn't exist or is corrupted JSON — start fresh
    }
    return {
      processedBugIds: [],
      lastRunAt: '',
      dailyInvestigationCount: 0,
      dailyCountDate: '',
      createdAfter: todayDateStringUTCPlus1(),
    };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state.lastRunAt = new Date().toISOString();
    this.state.createdAfter = todayDateStringUTCPlus1();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  isProcessed(bugId: number): boolean {
    return this.processedSet.has(bugId);
  }

  markProcessed(bugId: number): void {
    if (!this.processedSet.has(bugId)) {
      this.processedSet.add(bugId);
      this.state.processedBugIds.push(bugId);
    }
  }

  canInvestigateToday(max: number): boolean {
    const today = todayISO();
    if (this.state.dailyCountDate !== today) {
      this.state.dailyInvestigationCount = 0;
      this.state.dailyCountDate = today;
    }
    return this.state.dailyInvestigationCount < max;
  }

  incrementDailyCount(): void {
    const today = todayISO();
    if (this.state.dailyCountDate !== today) {
      this.state.dailyInvestigationCount = 0;
      this.state.dailyCountDate = today;
    }
    this.state.dailyInvestigationCount++;
  }

  get dailyInvestigationCount(): number {
    return this.state.dailyInvestigationCount;
  }

  reset(): void {
    this.state = {
      processedBugIds: [],
      lastRunAt: '',
      dailyInvestigationCount: 0,
      dailyCountDate: '',
      createdAfter: todayDateStringUTCPlus1(),
    };
    this.processedSet = new Set();
    this.save();
  }

  get isFirstRun(): boolean {
    return this.state.lastRunAt === '';
  }

  get createdAfter(): string {
    return this.state.createdAfter;
  }

  get processedCount(): number {
    return this.state.processedBugIds.length;
  }
}
