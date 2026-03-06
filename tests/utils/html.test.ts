import { describe, test, expect } from 'bun:test';
import { extractImageUrls, stripHtmlToText } from '../../src/utils/html.ts';

describe('extractImageUrls', () => {
  test('extracts Azure DevOps attachment URLs', () => {
    const html = `<p>See screenshot:</p><img src="https://dev.azure.com/org/_apis/wit/attachments/abc-123?fileName=screenshot.png" alt="error screen">`;
    const result = extractImageUrls(html);
    expect(result).toEqual([
      {
        url: 'https://dev.azure.com/org/_apis/wit/attachments/abc-123?fileName=screenshot.png',
        alt: 'error screen',
      },
    ]);
  });

  test('ignores non-ADO image URLs', () => {
    const html = `<img src="https://example.com/cat.png" alt="cat"><img src="https://dev.azure.com/org/_apis/wit/attachments/xyz?fileName=bug.png">`;
    const result = extractImageUrls(html);
    expect(result).toHaveLength(1);
    expect(result[0]!.url).toContain('_apis/wit/attachments');
  });

  test('returns empty array for no images', () => {
    const html = '<p>No images here</p>';
    expect(extractImageUrls(html)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(extractImageUrls('')).toEqual([]);
  });

  test('respects limit parameter', () => {
    const imgs = Array.from(
      { length: 10 },
      (_, i) =>
        `<img src="https://dev.azure.com/org/_apis/wit/attachments/id-${i}?fileName=img${i}.png">`,
    ).join('');
    const html = `<div>${imgs}</div>`;

    expect(extractImageUrls(html)).toHaveLength(5); // default limit
    expect(extractImageUrls(html, 3)).toHaveLength(3);
    expect(extractImageUrls(html, 10)).toHaveLength(10);
  });

  test('defaults alt to empty string when missing', () => {
    const html = `<img src="https://dev.azure.com/org/_apis/wit/attachments/abc?fileName=x.png">`;
    const result = extractImageUrls(html);
    expect(result[0]!.alt).toBe('');
  });

  test('handles single-quoted attributes', () => {
    const html = `<img src='https://dev.azure.com/org/_apis/wit/attachments/abc?fileName=x.png' alt='test'>`;
    const result = extractImageUrls(html);
    expect(result).toHaveLength(1);
    expect(result[0]!.alt).toBe('test');
  });
});

describe('stripHtmlToText', () => {
  test('strips basic HTML tags', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    expect(stripHtmlToText(html)).toBe('Hello world');
  });

  test('converts <br> to newlines', () => {
    const html = 'Line 1<br>Line 2<br/>Line 3<br />Line 4';
    expect(stripHtmlToText(html)).toBe('Line 1\nLine 2\nLine 3\nLine 4');
  });

  test('converts block elements to newlines', () => {
    const html = '<div>Block 1</div><div>Block 2</div>';
    const result = stripHtmlToText(html);
    expect(result).toContain('Block 1');
    expect(result).toContain('Block 2');
    expect(result.split('\n').filter(Boolean)).toHaveLength(2);
  });

  test('decodes HTML entities', () => {
    const html = '&lt;script&gt; &amp; &quot;hello&quot; &#39;world&#39; &nbsp;';
    const result = stripHtmlToText(html);
    expect(result).toContain('<script>');
    expect(result).toContain('& "hello"');
    expect(result).toContain("'world'");
  });

  test('decodes numeric entities', () => {
    const html = '&#65;&#66;&#67;';
    expect(stripHtmlToText(html)).toBe('ABC');
  });

  test('removes <img> tags', () => {
    const html = '<p>See <img src="https://example.com/pic.png" alt="pic"> below</p>';
    expect(stripHtmlToText(html)).toBe('See  below');
  });

  test('collapses multiple blank lines', () => {
    const html = '<p>A</p><p></p><p></p><p></p><p>B</p>';
    const result = stripHtmlToText(html);
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toEqual(['A', 'B']);
  });

  test('handles empty string', () => {
    expect(stripHtmlToText('')).toBe('');
  });

  test('handles plain text without HTML', () => {
    expect(stripHtmlToText('Just plain text')).toBe('Just plain text');
  });
});
