import { describe, test, expect } from 'bun:test';
import { shouldPullRepo } from '../../src/services/repo-sync.ts';

describe('shouldPullRepo', () => {
  test('returns true when lastPullAt is null', () => {
    expect(shouldPullRepo(null)).toBe(true);
  });

  test('returns true when last pull was more than 24 hours ago', () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    expect(shouldPullRepo(thirtyHoursAgo)).toBe(true);
  });

  test('returns false when last pull was less than 24 hours ago', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    expect(shouldPullRepo(oneHourAgo)).toBe(false);
  });

  test('returns false when last pull was just now', () => {
    const now = new Date().toISOString();
    expect(shouldPullRepo(now)).toBe(false);
  });

  test('returns true when last pull was exactly 24 hours ago', () => {
    const exactlyOneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(shouldPullRepo(exactlyOneDayAgo)).toBe(true);
  });
});
