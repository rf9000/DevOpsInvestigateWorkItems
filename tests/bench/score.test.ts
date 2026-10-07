import { describe, test, expect } from 'bun:test';
import { normalizePath, extractCodeRefs, scoreRefs } from '../../src/bench/score.ts';

describe('normalizePath', () => {
  test('lowercases, uses forward slashes, strips leading ./ and / and line suffixes', () => {
    expect(normalizePath(String.raw`.\Base-App\Bank\Bank.Table.al:6`)).toBe('base-app/bank/bank.table.al');
    expect(normalizePath('/app/src/X.al:360-366')).toBe('app/src/x.al');
    expect(normalizePath('`app/X.cs`')).toBe('app/x.cs');
  });
});

describe('extractCodeRefs', () => {
  test('finds backticked paths, including paths with spaces', () => {
    const md = String.raw`See ${'`'}base-application\Bank Account\Codeunits\BankAccComSetup.Codeunit.al:360-366${'`'} and ${'`'}SWEDBankExport.Codeunit.al:106${'`'}.`;
    expect(extractCodeRefs(md)).toEqual([
      'base-application/bank account/codeunits/bankacccomsetup.codeunit.al',
      'swedbankexport.codeunit.al',
    ]);
  });

  test('finds bare paths without spaces outside backticks and deduplicates', () => {
    const md = 'Root cause in base-application/Bank/Bank.Table.al:6, also base-application/Bank/Bank.Table.al again (src/Foo.cs).';
    expect(extractCodeRefs(md)).toEqual(['base-application/bank/bank.table.al', 'src/foo.cs']);
  });

  test('ignores things that are not source files', () => {
    expect(extractCodeRefs('Version 1.2.3 and e.g. some text, `CTS-CB Bank Code`')).toEqual([]);
  });
});

describe('scoreRefs', () => {
  const fix = ['/base-application/Bank/Bank.Table.al', '/base-application/Export/SWEDBankExport.Codeunit.al'];

  test('matches full, relative, basename-only and absolute refs', () => {
    const s = scoreRefs(
      ['bank.table.al', 'c:/temp/devops-bench/1/base-application/export/swedbankexport.codeunit.al', 'other/x.al'],
      fix,
    );
    expect(s.fileRecall).toBe(1);
    expect(s.anyFileHit).toBe(true);
    expect(s.refPrecision).toBeCloseTo(2 / 3);
    expect(s.matchedFixFiles).toHaveLength(2);
  });

  test('does not match on a partial file name', () => {
    const s = scoreRefs(['table.al'], fix);
    expect(s.fileRecall).toBe(0);
    expect(s.anyFileHit).toBe(false);
  });

  test('empty refs give zero recall and null precision', () => {
    const s = scoreRefs([], fix);
    expect(s.fileRecall).toBe(0);
    expect(s.refPrecision).toBeNull();
  });
});
