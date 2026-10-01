import { describe, test, expect } from 'bun:test';
import {
  createSpendTracker,
  spendFromAgentResult,
  spendFromUsage,
} from '../../src/services/spend-tracker.ts';
import type { CallSpend } from '../../src/types/index.ts';

function call(overrides: Partial<CallSpend> = {}): CallSpend {
  return {
    usd: 0.5,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 40,
    turns: 5,
    models: ['claude-sonnet-5'],
    ...overrides,
  };
}

describe('createSpendTracker', () => {
  test('starts empty', () => {
    const tracker = createSpendTracker();
    expect(tracker.snapshot()).toEqual({});
    expect(tracker.totalUsd()).toBe(0);
  });

  test('sums calls into one step and counts them', () => {
    const tracker = createSpendTracker();
    tracker.add('extract', call());
    tracker.add('extract', call({ usd: 0.25, turns: 1 }));

    expect(tracker.snapshot()).toEqual({
      extract: {
        usd: 0.75,
        calls: 2,
        inputTokens: 20,
        outputTokens: 40,
        cacheCreationInputTokens: 60,
        cacheReadInputTokens: 80,
        turns: 6,
        models: ['claude-sonnet-5'],
      },
    });
  });

  test('keeps distinct models in first-seen order', () => {
    const tracker = createSpendTracker();
    tracker.add('judge', call({ models: ['b'] }));
    tracker.add('judge', call({ models: ['a', 'b'] }));

    expect(tracker.snapshot().judge!.models).toEqual(['b', 'a']);
  });

  test('totalUsd sums across steps', () => {
    const tracker = createSpendTracker();
    tracker.add('investigate:A', call({ usd: 1 }));
    tracker.add('investigate:B', call({ usd: 2 }));
    tracker.add('judge', call({ usd: 0 }));

    expect(tracker.totalUsd()).toBe(3);
  });

  test('snapshot is a copy, not live state', () => {
    const tracker = createSpendTracker();
    tracker.add('judge', call());
    const before = tracker.snapshot();
    tracker.add('judge', call());

    expect(before.judge!.calls).toBe(1);
  });
});

describe('spendFromAgentResult', () => {
  test('sums tokens across every model in modelUsage', () => {
    const spend = spendFromAgentResult({
      total_cost_usd: 1.5,
      num_turns: 12,
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationInputTokens: 300,
          cacheReadInputTokens: 400,
        },
        'claude-haiku-4-5': {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
        },
      },
    });

    expect(spend).toEqual({
      usd: 1.5,
      inputTokens: 101,
      outputTokens: 202,
      cacheCreationInputTokens: 303,
      cacheReadInputTokens: 404,
      turns: 12,
      models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    });
  });
});

describe('spendFromUsage', () => {
  test('records tokens with no USD price and treats null cache counts as 0', () => {
    const spend = spendFromUsage(
      {
        input_tokens: 50,
        output_tokens: 60,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 7,
      },
      'claude-haiku-4-5',
    );

    expect(spend).toEqual({
      usd: 0,
      inputTokens: 50,
      outputTokens: 60,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 7,
      turns: 0,
      models: ['claude-haiku-4-5'],
    });
  });
});
