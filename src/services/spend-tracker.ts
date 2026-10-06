import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallSpend, StepSpend } from '../types/index.ts';

/** Receives the spend of one LLM call once the API has reported it. */
export type SpendSink = (call: CallSpend) => void;

/** Sums the spend of every LLM call one work item makes, grouped by step. */
export interface SpendTracker {
  add(step: string, call: CallSpend): void;
  totalUsd(): number;
  snapshot(): Record<string, StepSpend>;
}

export function createSpendTracker(): SpendTracker {
  const steps = new Map<string, StepSpend>();

  return {
    add(step, call) {
      const s = steps.get(step) ?? {
        usd: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        turns: 0,
        models: [],
      };
      s.usd += call.usd;
      s.calls += 1;
      s.inputTokens += call.inputTokens;
      s.outputTokens += call.outputTokens;
      s.cacheCreationInputTokens += call.cacheCreationInputTokens;
      s.cacheReadInputTokens += call.cacheReadInputTokens;
      s.turns += call.turns;
      for (const m of call.models) if (!s.models.includes(m)) s.models.push(m);
      steps.set(step, s);
    },

    totalUsd() {
      let total = 0;
      for (const s of steps.values()) total += s.usd;
      return total;
    },

    snapshot() {
      return Object.fromEntries(
        [...steps].map(([step, s]) => [step, { ...s, models: [...s.models] }]),
      );
    },
  };
}

type AgentUsage = Pick<ModelUsage, 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'>;

/**
 * Spend of one agent pass, from the SDK's `result` message. Tokens come from
 * `modelUsage`, not `usage`: `usage` covers the main loop only, while
 * `modelUsage` also counts subagent and internal calls.
 */
export function spendFromAgentResult(
  message: Pick<SDKResultMessage, 'total_cost_usd' | 'num_turns'> & { modelUsage: Record<string, AgentUsage> },
): CallSpend {
  const perModel = Object.values(message.modelUsage);
  const sum = (key: keyof AgentUsage) => perModel.reduce((n, u) => n + (u[key] ?? 0), 0);
  return {
    usd: message.total_cost_usd,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheCreationInputTokens: sum('cacheCreationInputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    turns: message.num_turns,
    models: Object.keys(message.modelUsage),
  };
}
