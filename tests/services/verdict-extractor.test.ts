import { describe, test, expect } from 'bun:test';
import { buildVerdictExtractionPrompt } from '../../src/services/verdict-extractor.ts';

describe('buildVerdictExtractionPrompt', () => {
  test('includes the full report text', () => {
    const report = '### Bug Validity\nYes\n\n### Root Cause\nMissing null check in auth.ts:42.';
    const prompt = buildVerdictExtractionPrompt(report);
    expect(prompt).toContain(report);
  });

  test('instructs extraction of a structured verdict', () => {
    const prompt = buildVerdictExtractionPrompt('some report');
    expect(prompt.toLowerCase()).toContain('extract');
  });
});
