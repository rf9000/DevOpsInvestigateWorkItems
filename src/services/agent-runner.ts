import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { z } from 'zod';
import type { ImageAttachment } from '../types/index.ts';
import { denyDestructiveBash } from './investigator.ts';
import { spendFromAgentResult } from './spend-tracker.ts';
import type { SpendSink } from './spend-tracker.ts';
import { toOutputSchema } from './triage-schemas.ts';

export interface StructuredAgentOptions<T> {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  images: ImageAttachment[];
  cwd: string;
  maxTurns: number;
  tools: string[];
  mcpServers?: Record<string, McpServerConfig>;
  schema: z.ZodType<T>;
  onSpend?: SpendSink;
  /** Prefix for the cost log line, e.g. "triage". */
  label: string;
}

export type QueryFn = typeof query;

function userMessage(text: string, images: ImageAttachment[]): SDKUserMessage {
  const blocks: ContentBlockParam[] = [{ type: 'text', text }];
  for (const img of images) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64Data } });
  }
  return { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: '' };
}

/**
 * One read-only agent pass whose answer is JSON matching `schema`. The SDK
 * validates the output against the schema and retries; this function parses it
 * again with zod so callers get a typed value or an error, never prose.
 */
export async function runStructuredAgent<T>(
  options: StructuredAgentOptions<T>,
  queryFn: QueryFn = query,
): Promise<T> {
  let prompt: string | AsyncIterable<SDKUserMessage>;
  if (options.images.length > 0) {
    const msg = userMessage(options.userPrompt, options.images);
    prompt = (async function* () { yield msg; })();
  } else {
    prompt = options.userPrompt;
  }

  let output: unknown;
  let subtype: string | undefined;
  let apiError: string | undefined;

  for await (const message of queryFn({
    prompt,
    options: {
      model: options.model,
      maxTurns: options.maxTurns,
      tools: options.tools,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [denyDestructiveBash] }] },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: options.systemPrompt },
      settingSources: ['project'],
      cwd: options.cwd,
      outputFormat: { type: 'json_schema', schema: toOutputSchema(options.schema) },
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    },
  })) {
    if (message.type === 'result') {
      const models = Object.keys(message.modelUsage).join(', ') || 'unknown';
      console.log(`  [${options.label}] Cost: $${message.total_cost_usd.toFixed(4)} | ${message.num_turns} turns | ${models}`);
      // Failed passes still cost money, so record spend first.
      options.onSpend?.(spendFromAgentResult(message));
      subtype = message.subtype;
      if (message.subtype === 'success' && message.is_error) apiError = message.result;
      else if (message.subtype === 'success') output = message.structured_output;
    }
  }

  if (apiError !== undefined) {
    throw new Error(`${options.label} agent hit a Claude API error: ${apiError}`);
  }
  if (subtype !== 'success') {
    throw new Error(`${options.label} agent ended with ${subtype ?? 'no result'}`);
  }
  const parsed = options.schema.safeParse(output);
  if (!parsed.success) {
    throw new Error(`${options.label} agent returned output that does not match the schema: ${parsed.error.message}`);
  }
  return parsed.data;
}
