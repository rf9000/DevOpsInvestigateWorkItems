import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  materializeAttachments,
  sanitizeAttachmentFileName,
  selectAttachmentRelations,
} from '../../src/services/attachments.ts';

describe('sanitizeAttachmentFileName', () => {
  test('keeps a plain filename unchanged', () => {
    expect(sanitizeAttachmentFileName('error-log.txt', new Set())).toBe('error-log.txt');
  });

  test('strips directory components from a traversal attempt', () => {
    expect(sanitizeAttachmentFileName('../../etc/passwd', new Set())).toBe('passwd');
  });

  test('strips windows-style directory components', () => {
    expect(sanitizeAttachmentFileName('..\\..\\windows\\system32\\cmd.exe', new Set())).toBe('cmd.exe');
  });

  test('de-duplicates a name already taken', () => {
    const taken = new Set(['screenshot.png']);
    expect(sanitizeAttachmentFileName('screenshot.png', taken)).toBe('screenshot-2.png');
  });

  test('de-duplicates repeatedly until free', () => {
    const taken = new Set(['a.txt', 'a-2.txt']);
    expect(sanitizeAttachmentFileName('a.txt', taken)).toBe('a-3.txt');
  });

  test('falls back to a placeholder for a dot-only name', () => {
    expect(sanitizeAttachmentFileName('..', new Set())).toBe('attachment');
  });

  test('falls back to a placeholder for an empty name', () => {
    expect(sanitizeAttachmentFileName('', new Set())).toBe('attachment');
  });
});

describe('selectAttachmentRelations', () => {
  const attached = (name: string, url = `https://ado/_apis/wit/attachments/${name}`) => ({
    rel: 'AttachedFile',
    url,
    attributes: { name },
  });

  test('keeps only AttachedFile relations', () => {
    const relations = [
      { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://ado/wit/workItems/1' },
      attached('error.log'),
      { rel: 'ArtifactLink', url: 'vstfs:///Build/Build/1' },
    ];

    const result = selectAttachmentRelations(relations, 20);

    expect(result).toEqual([{ url: attached('error.log').url, fileName: 'error.log' }]);
  });

  test('returns an empty array when there are no relations', () => {
    expect(selectAttachmentRelations(undefined, 20)).toEqual([]);
  });

  test('caps the number of attachments returned', () => {
    const relations = [attached('a.txt'), attached('b.txt'), attached('c.txt')];

    expect(selectAttachmentRelations(relations, 2)).toHaveLength(2);
  });

  test('skips relations with no url', () => {
    const relations = [{ rel: 'AttachedFile', url: '', attributes: { name: 'ghost.txt' } }];

    expect(selectAttachmentRelations(relations, 20)).toEqual([]);
  });

  test('falls back to a placeholder name when the attribute is missing', () => {
    const relations = [{ rel: 'AttachedFile', url: 'https://ado/_apis/wit/attachments/abc' }];

    expect(selectAttachmentRelations(relations, 20)).toEqual([
      { url: 'https://ado/_apis/wit/attachments/abc', fileName: 'attachment' },
    ]);
  });
});

describe('materializeAttachments', () => {
  function tmpDir(): string {
    return join(mkdtempSync(join(tmpdir(), 'ado-att-')), 'bug-1');
  }

  const bytes = (s: string) => Buffer.from(s, 'utf8');

  test('writes each attachment into the destination directory', async () => {
    const dir = tmpDir();
    const result = await materializeAttachments(
      [{ url: 'u1', fileName: 'error.log' }],
      dir,
      async () => bytes('boom'),
      { maxBytes: 1000 },
    );

    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]!.fileName).toBe('error.log');
    expect(result.saved[0]!.sizeBytes).toBe(4);
    expect(readFileSync(result.saved[0]!.localPath, 'utf8')).toBe('boom');
  });

  test('creates the destination directory when it does not exist', async () => {
    const dir = join(tmpDir(), 'nested', 'deeper');
    const result = await materializeAttachments(
      [{ url: 'u1', fileName: 'a.txt' }],
      dir,
      async () => bytes('x'),
      { maxBytes: 1000 },
    );

    expect(existsSync(result.saved[0]!.localPath)).toBe(true);
  });

  test('de-duplicates colliding filenames on disk', async () => {
    const dir = tmpDir();
    const result = await materializeAttachments(
      [
        { url: 'u1', fileName: 'shot.png' },
        { url: 'u2', fileName: 'shot.png' },
      ],
      dir,
      async () => bytes('data'),
      { maxBytes: 1000 },
    );

    expect(result.saved.map((a) => a.fileName)).toEqual(['shot.png', 'shot-2.png']);
    expect(readFileSync(join(dir, 'shot-2.png'), 'utf8')).toBe('data');
  });

  test('writes a traversal filename inside the destination directory', async () => {
    const dir = tmpDir();
    const result = await materializeAttachments(
      [{ url: 'u1', fileName: '../../escaped.txt' }],
      dir,
      async () => bytes('contained'),
      { maxBytes: 1000 },
    );

    expect(result.saved[0]!.localPath).toBe(join(dir, 'escaped.txt'));
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(true);
  });

  test('skips an attachment larger than maxBytes', async () => {
    const dir = tmpDir();
    const result = await materializeAttachments(
      [{ url: 'u1', fileName: 'huge.bin' }],
      dir,
      async () => bytes('way too many bytes'),
      { maxBytes: 4 },
    );

    expect(result.saved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.fileName).toBe('huge.bin');
    expect(result.skipped[0]!.reason).toContain('exceeds');
  });

  test('skips a failed download instead of throwing', async () => {
    const dir = tmpDir();
    const result = await materializeAttachments(
      [
        { url: 'bad', fileName: 'gone.txt' },
        { url: 'good', fileName: 'here.txt' },
      ],
      dir,
      async (url) => {
        if (url === 'bad') throw new Error('404 not found');
        return bytes('ok');
      },
      { maxBytes: 1000 },
    );

    expect(result.saved.map((a) => a.fileName)).toEqual(['here.txt']);
    expect(result.skipped[0]!.reason).toContain('404 not found');
  });
});
