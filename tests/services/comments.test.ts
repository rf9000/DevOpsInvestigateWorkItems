import { describe, test, expect } from 'bun:test';
import { formatCommentThread } from '../../src/services/comments.ts';
import type { WorkItemComment } from '../../src/types/index.ts';

const comment = (over: Partial<WorkItemComment> = {}): WorkItemComment => ({
  id: 1,
  text: '<p>Looks like a rounding bug.</p>',
  createdDate: '2026-09-01T10:00:00Z',
  createdBy: { displayName: 'Ada Lovelace' },
  ...over,
});

describe('formatCommentThread', () => {
  test('returns an empty string when there are no comments', () => {
    expect(formatCommentThread([])).toBe('');
  });

  test('renders author, date and stripped text', () => {
    const result = formatCommentThread([comment()]);

    expect(result).toContain('Ada Lovelace');
    expect(result).toContain('2026-09-01');
    expect(result).toContain('Looks like a rounding bug.');
    expect(result).not.toContain('<p>');
  });

  test('orders comments oldest first', () => {
    const result = formatCommentThread([
      comment({ id: 2, text: 'second', createdDate: '2026-09-02T10:00:00Z' }),
      comment({ id: 1, text: 'first', createdDate: '2026-09-01T10:00:00Z' }),
    ]);

    expect(result.indexOf('first')).toBeLessThan(result.indexOf('second'));
  });

  test('skips comments whose text is empty after stripping', () => {
    const result = formatCommentThread([
      comment({ id: 1, text: '<p></p>' }),
      comment({ id: 2, text: 'real content' }),
    ]);

    expect(result).toContain('real content');
    expect(result.split('---').filter((s) => s.trim()).length).toBe(1);
  });

  test('falls back to Unknown when the author is missing', () => {
    const result = formatCommentThread([comment({ createdBy: undefined })]);

    expect(result).toContain('Unknown');
  });
});
