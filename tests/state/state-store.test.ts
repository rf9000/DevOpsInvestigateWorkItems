import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateStore } from '../../src/state/state-store.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-store-test-'));
}

describe('StateStore', () => {
  it('save + load roundtrip preserves processed bugs', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(101);
    store.markProcessed(202);
    store.markProcessed(303);
    store.save();

    const store2 = new StateStore(dir);

    expect(store2.isProcessed(101)).toBe(true);
    expect(store2.isProcessed(202)).toBe(true);
    expect(store2.isProcessed(303)).toBe(true);
    expect(store2.processedCount).toBe(3);
  });

  it('starts empty when the state file does not exist', () => {
    const dir = makeTmpDir();
    const subDir = join(dir, 'nonexistent', 'nested');
    const store = new StateStore(subDir);

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(1)).toBe(false);
  });

  it('starts fresh when the state file contains corrupt JSON', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'processed-bugs.json');
    writeFileSync(filePath, '{{not valid json!!!', 'utf-8');

    const store = new StateStore(dir);

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(1)).toBe(false);
  });

  it('does not duplicate when marking the same bug twice', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(42);
    store.markProcessed(42);

    expect(store.processedCount).toBe(1);
  });

  it('isProcessed returns false for unprocessed IDs', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(1);

    expect(store.isProcessed(1)).toBe(true);
    expect(store.isProcessed(2)).toBe(false);
    expect(store.isProcessed(999)).toBe(false);
  });

  it('reset clears all state and persists the empty state', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(10);
    store.markProcessed(20);
    store.save();

    store.reset();

    expect(store.processedCount).toBe(0);
    expect(store.isProcessed(10)).toBe(false);
    expect(store.isProcessed(20)).toBe(false);

    const store2 = new StateStore(dir);
    expect(store2.processedCount).toBe(0);
  });

  it('processedCount returns the correct count', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    expect(store.processedCount).toBe(0);

    store.markProcessed(1);
    expect(store.processedCount).toBe(1);

    store.markProcessed(2);
    expect(store.processedCount).toBe(2);

    store.markProcessed(3);
    expect(store.processedCount).toBe(3);
  });

  it('canInvestigateToday returns true when under limit', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    expect(store.canInvestigateToday(5)).toBe(true);
  });

  it('canInvestigateToday returns false when at limit', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    for (let i = 0; i < 5; i++) {
      store.incrementDailyCount();
    }

    expect(store.canInvestigateToday(5)).toBe(false);
  });

  it('incrementDailyCount increments the counter', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    expect(store.dailyInvestigationCount).toBe(0);
    store.incrementDailyCount();
    expect(store.dailyInvestigationCount).toBe(1);
    store.incrementDailyCount();
    expect(store.dailyInvestigationCount).toBe(2);
  });

  it('daily count persists across save/load', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.incrementDailyCount();
    store.incrementDailyCount();
    store.incrementDailyCount();
    // Trigger date to be set by calling canInvestigateToday
    store.canInvestigateToday(10);
    store.save();

    const store2 = new StateStore(dir);
    // The count should persist (assuming same day)
    expect(store2.dailyInvestigationCount).toBe(3);
  });

  it('pruneProcessed removes IDs not in the current set', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(1);
    store.markProcessed(2);
    store.markProcessed(3);
    store.markProcessed(4);

    store.pruneProcessed([2, 4, 5]);

    expect(store.isProcessed(1)).toBe(false);
    expect(store.isProcessed(2)).toBe(true);
    expect(store.isProcessed(3)).toBe(false);
    expect(store.isProcessed(4)).toBe(true);
    expect(store.processedCount).toBe(2);
  });

  it('pruneProcessed persists after save/load', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.markProcessed(10);
    store.markProcessed(20);
    store.markProcessed(30);
    store.pruneProcessed([20]);
    store.save();

    const store2 = new StateStore(dir);
    expect(store2.isProcessed(10)).toBe(false);
    expect(store2.isProcessed(20)).toBe(true);
    expect(store2.isProcessed(30)).toBe(false);
    expect(store2.processedCount).toBe(1);
  });

  it('reset clears daily count', () => {
    const dir = makeTmpDir();
    const store = new StateStore(dir);

    store.incrementDailyCount();
    store.save();

    store.reset();

    expect(store.dailyInvestigationCount).toBe(0);
  });
});
