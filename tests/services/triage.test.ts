import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig, CallSpend, CostRecord, WorkItemResponse } from '../../src/types/index.ts';
import { routeFor, toOutputSchema, triageResultSchema } from '../../src/services/triage-schemas.ts';
import type { InvestigationResult, TriageResult } from '../../src/services/triage-schemas.ts';
import { renderTriageReport } from '../../src/services/report-renderer.ts';
import { isBotComment, renderWorkItem } from '../../src/services/triager.ts';
import type { WorkItemContext } from '../../src/services/triager.ts';
import { renderTriageHints } from '../../src/services/deep-investigator.ts';
import { getWorkItemTool, searchTool } from '../../src/services/ado-tools.ts';
import type { AdoToolDeps } from '../../src/services/ado-tools.ts';
import { processBug, runTriagePipeline } from '../../src/services/processor.ts';
import type { ProcessorDeps, TriageDeps } from '../../src/services/processor.ts';
import { runStructuredAgent } from '../../src/services/agent-runner.ts';
import type { QueryFn } from '../../src/services/agent-runner.ts';

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'My Project',
    pat: 'pat',
    featureWorkItemIds: [1],
    targetRepoPath: 'C:/repos/banking',
    maxInvestigationsPerDay: 5,
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-opus-5-5',
    promptPath: './prompt.md',
    stateDir: '.state',
    costLogPath: '.state/cost-ledger.jsonl',
    dryRun: false,
    pipelineVariant: 'triage',
    triageModel: 'claude-sonnet-5-5',
    triagePromptPath: './triage.md',
    deepPromptPath: './deep.md',
    ...overrides,
  };
}

function triage(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    classification: 'bug',
    summary: 'Export drops the last line.',
    area: 'Remittance export',
    severityGuess: 'medium',
    completeness: 'sufficient',
    missingInfo: [],
    questionsForReporter: [],
    duplicates: [],
    likelyFiles: ['app/Export.Codeunit.al'],
    rationale: 'Clear defect report.',
    ...overrides,
  };
}

function investigation(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return {
    validity: 'valid',
    confidence: 'high',
    rootCause: 'Off-by-one in the loop.',
    codeReferences: [
      { path: 'app/Export.Codeunit.al', line: 42, note: 'loop bound' },
      { path: 'app/Line.Table.al', line: null, note: '' },
    ],
    reproduction: ['Create a suggestion', 'Export'],
    suggestedFix: 'Use `<=`.',
    risks: '',
    ambiguities: [],
    ...overrides,
  };
}

const spendCall: CallSpend = {
  usd: 0.1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 2, models: ['m'],
};

describe('routeFor', () => {
  test('a complete bug with no strong duplicate goes to the deep dive', () => {
    expect(routeFor(triage(), 'Bug')).toBe('investigate');
    expect(routeFor(triage({ classification: 'investigation' }), 'User Story')).toBe('investigate');
  });

  test('needs_info wins over everything else', () => {
    expect(routeFor(triage({ completeness: 'needs_info', duplicates: [{ id: 2, title: 't', confidence: 'high', reason: 'r' }] }), 'Bug'))
      .toBe('needs_info');
  });

  test('only a high-confidence duplicate gates the item', () => {
    expect(routeFor(triage({ duplicates: [{ id: 2, title: 't', confidence: 'medium', reason: 'r' }] }), 'Bug')).toBe('investigate');
    expect(routeFor(triage({ duplicates: [{ id: 2, title: 't', confidence: 'high', reason: 'r' }] }), 'Bug')).toBe('duplicate');
  });

  test('non-code classifications gate other work item types', () => {
    expect(routeFor(triage({ classification: 'feature_request' }), 'User Story')).toBe('feature_request');
    expect(routeFor(triage({ classification: 'not_a_bug' }), 'User Story')).toBe('not_a_bug');
  });

  test('a Bug work item is investigated whatever the classification', () => {
    for (const classification of ['feature_request', 'not_a_bug', 'config_or_data', 'question'] as const) {
      expect(routeFor(triage({ classification }), 'Bug')).toBe('investigate');
    }
  });
});

describe('toOutputSchema', () => {
  test('produces an object schema without the $schema marker', () => {
    const schema = toOutputSchema(triageResultSchema);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('classification');
  });
});

describe('renderTriageReport', () => {
  test('an investigated bug renders the header, sections and code references', () => {
    const md = renderTriageReport(mockConfig(), triage(), 'investigate', investigation());
    expect(md).toContain('**Bug · severity: medium · area: Remittance export**');
    expect(md).toContain('### Bug Validity\nYes (high confidence)');
    expect(md).toContain('- `app/Export.Codeunit.al:42`: loop bound');
    expect(md).toContain('- `app/Line.Table.al`');
    expect(md).toContain('1. Create a suggestion\n2. Export');
    expect(md).toContain('### Ambiguities & Doubts\nNone identified.');
    expect(md).not.toContain('### Risks');
    expect(md).not.toContain('Not investigated');
  });

  test('needs_info lists the questions and skips the investigation', () => {
    const md = renderTriageReport(mockConfig(), triage({
      completeness: 'needs_info',
      questionsForReporter: ['Which bank?'],
      missingInfo: ['Bank format'],
    }), 'needs_info');
    expect(md).toContain('### Questions for the reporter');
    expect(md).toContain('- Which bank?');
    expect(md).toContain('- Bank format');
    expect(md).not.toContain('### Root Cause');
  });

  test('a duplicate links the other work item and says why it was not investigated', () => {
    const md = renderTriageReport(mockConfig(), triage({
      duplicates: [{ id: 77, title: 'Same bug', confidence: 'high', reason: 'Same error' }],
    }), 'duplicate');
    expect(md).toContain('### Possible duplicate');
    expect(md).toContain('[#77 Same bug](https://dev.azure.com/my-org/My%20Project/_workitems/edit/77)');
    expect(md).toContain('*Not investigated in the code: Clear defect report.*');
  });
});

describe('renderWorkItem', () => {
  const ctx: WorkItemContext = {
    id: 5, type: 'Bug', title: 'T', description: 'D', reproSteps: '',
    comments: [
      { author: 'Ann', createdDate: '2026-01-02T10:00:00Z', text: 'It fails for SEPA' },
      { author: 'Svc', createdDate: '2026-01-01T10:00:00Z', text: 'Report... If you want the agent to investigate again, tag it' },
    ],
    images: [], discoveredSkills: [],
  };

  test('includes fields and comments, marking the bot', () => {
    const text = renderWorkItem(ctx);
    expect(text).toContain('## Work item #5 (Bug)');
    expect(text).toContain('**Description:**\nD');
    expect(text).not.toContain('Reproduction Steps');
    expect(text).toContain('- Ann (2026-01-02): It fails for SEPA');
    expect(text).toContain('- [bot] (2026-01-01)');
    expect(isBotComment(ctx.comments[0]!)).toBe(false);
  });

  test('triage hints carry likely files and medium-confidence related items', () => {
    const hints = renderTriageHints(triage({ duplicates: [{ id: 9, title: 'Near', confidence: 'medium', reason: '' }] }));
    expect(hints).toContain('Likely files: app/Export.Codeunit.al');
    expect(hints).toContain('#9 Near');
  });
});

function toolDeps(overrides: Partial<AdoToolDeps> = {}): AdoToolDeps {
  return {
    searchWorkItems: mock(() => Promise.resolve([
      { id: 8, title: 'Older bug', type: 'Bug', state: 'Closed', createdDate: '2025-05-01T00:00:00Z' },
    ])),
    getWorkItem: mock((_c: AppConfig, id: number) => Promise.resolve({
      id, rev: 1, url: '',
      fields: {
        'System.Title': 'Older bug', 'System.WorkItemType': 'Bug', 'System.State': 'Closed',
        'System.CreatedDate': '2025-05-01T00:00:00Z', 'System.Description': '<p>Breaks</p>',
      },
    } as WorkItemResponse)),
    getWorkItemComments: mock(() => Promise.resolve([{ author: 'Bo', createdDate: '2025-05-02T00:00:00Z', text: 'Fixed in PR 12' }])),
    ...overrides,
  };
}

describe('ADO tools', () => {
  test('search excludes the current item and passes the replay cutoff', async () => {
    const deps = toolDeps();
    const out = await searchTool(mockConfig(), { currentId: 5, replay: { createdBefore: '2026-01-01T00:00:00Z' } }, ['export'], deps);
    expect(out).toBe('#8 [Bug, Closed, created 2025-05-01] Older bug');
    expect(deps.searchWorkItems).toHaveBeenCalledWith(mockConfig(), ['export'], { excludeId: 5, createdBefore: '2026-01-01T00:00:00Z' });
  });

  test('get_work_item shows comments outside replays', async () => {
    const out = await getWorkItemTool(mockConfig(), { currentId: 5 }, 8, toolDeps());
    expect(out).toContain('Type: Bug | State: Closed');
    expect(out).toContain('Description:\nBreaks');
    expect(out).toContain('Bo (2025-05-02): Fixed in PR 12');
  });

  test('a replay hides comments and items created after the bug', async () => {
    const deps = toolDeps();
    const scope = { currentId: 5, replay: { createdBefore: '2025-06-01T00:00:00Z' } };
    expect(await getWorkItemTool(mockConfig(), scope, 8, deps)).not.toContain('Fixed in PR');
    expect(deps.getWorkItemComments).not.toHaveBeenCalled();

    const later = await getWorkItemTool(mockConfig(), { currentId: 5, replay: { createdBefore: '2025-04-01T00:00:00Z' } }, 8, deps);
    expect(later).toBe('Work item #8 is not available.');
  });

  test('the current item is never fetched', async () => {
    const deps = toolDeps();
    expect(await getWorkItemTool(mockConfig(), { currentId: 5 }, 5, deps)).toContain('already in the prompt');
    expect(deps.getWorkItem).not.toHaveBeenCalled();
  });
});

function processorDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    getWorkItem: mock(() => Promise.resolve({
      id: 100, rev: 1, url: '',
      fields: {
        'System.Title': 'Export drops line', 'System.WorkItemType': 'Bug',
        'System.CreatedDate': '2026-02-01T08:00:00Z', 'System.Description': 'Last line missing',
      },
    })),
    investigateBug: mock(() => Promise.reject(new Error('legacy path must not run'))),
    addWorkItemComment: mock(() => Promise.resolve({})),
    discoverTargetRepoSkills: mock(() => []),
    downloadAttachment: mock(() => Promise.reject(new Error('no images'))),
    recordCost: mock((_c: AppConfig, _e: CostRecord) => {}),
    ...overrides,
  };
}

function triageDeps(result: TriageResult, overrides: Partial<TriageDeps> = {}): TriageDeps {
  return {
    getWorkItemComments: mock(() => Promise.resolve([{ author: 'Ann', createdDate: '2026-02-02', text: 'Only SEPA' }])),
    triage: mock(async (_c, _ctx, _s, onSpend) => { onSpend?.(spendCall); return result; }),
    investigateDeep: mock(async (_c, _ctx, _t, onSpend) => { onSpend?.({ ...spendCall, usd: 1 }); return investigation(); }),
    ...overrides,
  };
}

describe('runTriagePipeline', () => {
  test('an investigated bug spends on both stages and refs come from the deep dive', async () => {
    const tDeps = triageDeps(triage());
    const run = await runTriagePipeline(mockConfig(), 100, {}, processorDeps(), tDeps);

    expect(run.outcome).toBe('completed');
    expect(run.route).toBe('investigate');
    expect(run.codeRefs).toEqual(['app/Export.Codeunit.al', 'app/Line.Table.al']);
    expect(Object.keys(run.spend.snapshot()).sort()).toEqual(['investigate', 'triage']);
    expect(run.spend.totalUsd()).toBeCloseTo(1.1);
    expect(run.markdown).toContain('### Root Cause');
    expect(run.markdown).toContain('`agent investigate`');

    const ctx = (tDeps.triage as ReturnType<typeof mock>).mock.calls[0]![1] as WorkItemContext;
    expect(ctx.comments).toHaveLength(1);
    expect(ctx.type).toBe('Bug');
  });

  test('a gated item skips the deep dive and scores triage hints', async () => {
    const tDeps = triageDeps(triage({ completeness: 'needs_info', questionsForReporter: ['Which bank?'] }));
    const run = await runTriagePipeline(mockConfig(), 100, {}, processorDeps(), tDeps);

    expect(run.route).toBe('needs_info');
    expect(tDeps.investigateDeep).not.toHaveBeenCalled();
    expect(Object.keys(run.spend.snapshot())).toEqual(['triage']);
    expect(run.codeRefs).toEqual(['app/Export.Codeunit.al']);
  });

  test('a replay reads no comments and scopes tools to before the bug was created', async () => {
    const tDeps = triageDeps(triage());
    await runTriagePipeline(mockConfig(), 100, { replay: true }, processorDeps(), tDeps);

    expect(tDeps.getWorkItemComments).not.toHaveBeenCalled();
    const [, ctx, scope] = (tDeps.triage as ReturnType<typeof mock>).mock.calls[0]!;
    expect((ctx as WorkItemContext).comments).toEqual([]);
    expect(scope).toEqual({ currentId: 100, replay: { createdBefore: '2026-02-01T08:00:00Z' } });
  });

  test('a Bug that triage calls a feature request still gets the deep dive', async () => {
    const tDeps = triageDeps(triage({ classification: 'feature_request' }));
    const run = await runTriagePipeline(mockConfig(), 100, {}, processorDeps(), tDeps);
    expect(run.route).toBe('investigate');
    expect(tDeps.investigateDeep).toHaveBeenCalledTimes(1);
  });

  test('a comment fetch failure does not stop triage', async () => {
    const tDeps = triageDeps(triage(), { getWorkItemComments: mock(() => Promise.reject(new Error('403'))) });
    const run = await runTriagePipeline(mockConfig(), 100, {}, processorDeps(), tDeps);
    expect(run.outcome).toBe('completed');
  });

  test('a deep dive failure fails the run but keeps the triage spend', async () => {
    const tDeps = triageDeps(triage(), { investigateDeep: mock(() => Promise.reject(new Error('max turns'))) });
    const run = await runTriagePipeline(mockConfig(), 100, {}, processorDeps(), tDeps);
    expect(run.outcome).toBe('failed');
    expect(run.error).toBe('max turns');
    expect(run.spend.totalUsd()).toBeCloseTo(0.1);
  });
});

describe('processBug with PIPELINE_VARIANT=triage', () => {
  test('posts the rendered triage comment and records the variant', async () => {
    const deps = processorDeps({
      getWorkItem: mock(() => Promise.resolve({
        id: 100, rev: 1, url: '',
        fields: { 'System.Title': 'How do I export?', 'System.WorkItemType': 'User Story', 'System.CreatedDate': '2026-02-01T08:00:00Z' },
      })),
    });
    const result = await processBug(mockConfig(), 100, deps, triageDeps(triage({ classification: 'question' })));

    expect(result).toEqual({ bugId: 100, investigated: true });
    expect(deps.investigateBug).not.toHaveBeenCalled();
    const html = (deps.addWorkItemComment as ReturnType<typeof mock>).mock.calls[0]![2] as string;
    expect(html).toContain('Not investigated in the code');
    const record = (deps.recordCost as ReturnType<typeof mock>).mock.calls[0]![1] as CostRecord;
    expect(record.variant).toBe('triage');
    expect(record.outcome).toBe('completed');
  });
});

function fakeQuery(messages: unknown[]): QueryFn {
  return (() => (async function* () { for (const m of messages) yield m; })()) as unknown as QueryFn;
}

function resultMessage(subtype: string, structured?: unknown) {
  return {
    type: 'result', subtype, total_cost_usd: 0.5, num_turns: 3,
    modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } },
    usage: {}, structured_output: structured,
  };
}

describe('runStructuredAgent', () => {
  const base = {
    label: 'triage', model: 'm', systemPrompt: 's', userPrompt: 'u', images: [], cwd: '.', maxTurns: 5,
    tools: ['Read'], schema: triageResultSchema,
  };

  test('returns the validated structured output and records spend', async () => {
    const spent: CallSpend[] = [];
    const out = await runStructuredAgent({ ...base, onSpend: (c) => spent.push(c) }, fakeQuery([resultMessage('success', triage())]));
    expect(out).toEqual(triage());
    expect(spent).toHaveLength(1);
    expect(spent[0]!.usd).toBe(0.5);
  });

  test('throws on a non-success result after recording spend', async () => {
    const spent: CallSpend[] = [];
    await expect(runStructuredAgent({ ...base, onSpend: (c) => spent.push(c) },
      fakeQuery([resultMessage('error_max_structured_output_retries')]))).rejects.toThrow('error_max_structured_output_retries');
    expect(spent).toHaveLength(1);
  });

  test('an API error reported as a success result throws the error text', async () => {
    const msg = { ...resultMessage('success'), is_error: true, result: 'API Error: 400 model not supported' };
    await expect(runStructuredAgent(base, fakeQuery([msg]))).rejects.toThrow('API Error: 400 model not supported');
  });

  test('throws when the output does not match the schema', async () => {
    await expect(runStructuredAgent(base, fakeQuery([resultMessage('success', { classification: 'nope' })])))
      .rejects.toThrow('does not match the schema');
  });
});
