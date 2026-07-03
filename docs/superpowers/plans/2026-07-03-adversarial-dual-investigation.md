# Adversarial Dual-Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-pass bug investigation with two independent concurrent investigation passes, reconciled by a structured-output judge, with a stronger-model tiebreak on disagreement — so a hallucinated root cause or wrong bug-validity call gets caught before it's posted to Azure DevOps.

**Architecture:** `processor.ts` calls a new `investigation-orchestrator.ts` instead of `investigator.ts` directly. The orchestrator runs Pass A and Pass B concurrently (same prompt/tools, both `config.claudeModel`), extracts a structured verdict from each report via a separate lightweight Messages API call (`config.claudeJudgeModel`), and asks a judge (also `config.claudeJudgeModel`) whether the two verdicts agree. On disagreement, a third pass runs on `config.claudeTiebreakModel` and majority vote (via two more judge calls) picks the final report. Every investigated bug gets one append-only validation-log line recording the outcome.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/claude-agent-sdk` (unchanged, for the three investigation passes), `@anthropic-ai/sdk` + `zod` (new: raw Messages API calls with `output_config.format` / `zodOutputFormat` for structured verdict extraction and judging — confirmed present in the installed `@anthropic-ai/sdk@0.78.0`).

## Global Constraints

- Existing investigation prompt (`src/prompts/investigate-bug.md`), tool permissions, and Bash denylist in `investigator.ts` are unchanged — only a `model` parameter is added to `investigateBug`.
- `processor.ts`'s post-processing (preamble-strip, footer-append, dry-run, HTML conversion) is unchanged — it still receives one final markdown string.
- All three model tiers (`CLAUDE_MODEL`, `CLAUDE_JUDGE_MODEL`, `CLAUDE_TIEBREAK_MODEL`) are `.env`-configurable via the existing Zod config pattern in `src/config/index.ts` — no hardcoded model strings outside config defaults.
- Follow the existing dependency-injection pattern (`ProcessorDeps`, `WatcherDeps`) for every new orchestration layer so it's unit-testable without hitting a real API.
- Match the existing test convention: pure prompt-building functions get unit tests; functions that call the SDK/API directly (`investigateBug`, `extractVerdict`, `judgeVerdicts`) are exercised only through their callers' mocked DI, not called for real in tests.

---

### Task 1: Add judge/tiebreak model config

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/types/index.ts`
- Test: `tests/config/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.claudeJudgeModel: string`, `AppConfig.claudeTiebreakModel: string` — consumed by Task 6 (orchestrator).

- [ ] **Step 1: Update the existing default-value test and add new tests**

`tests/config/config.test.ts` uses `describe`/`it` (not `describe`/`test`) and a module-level `const validEnv: Record<string, string> = {...}` fixture (not a function) — follow that exact convention, do not introduce `test(...)` or a `baseEnv()` helper.

First, update the existing assertion in the `"applies default values when optional vars are absent"` test (line 59) since the default is changing:

```typescript
    expect(config.claudeModel).toBe("claude-sonnet-5");
```

Then add new `it(...)` blocks inside the existing `describe("loadConfig", ...)` block:

```typescript
  it("defaults CLAUDE_JUDGE_MODEL to claude-haiku-4-5", () => {
    const config = loadConfig(validEnv);
    expect(config.claudeJudgeModel).toBe("claude-haiku-4-5");
  });

  it("defaults CLAUDE_TIEBREAK_MODEL to claude-opus-4-8", () => {
    const config = loadConfig(validEnv);
    expect(config.claudeTiebreakModel).toBe("claude-opus-4-8");
  });

  it("overrides CLAUDE_JUDGE_MODEL and CLAUDE_TIEBREAK_MODEL when set", () => {
    const env = {
      ...validEnv,
      CLAUDE_JUDGE_MODEL: "claude-haiku-3-5",
      CLAUDE_TIEBREAK_MODEL: "claude-opus-4-7",
    };
    const config = loadConfig(env);
    expect(config.claudeJudgeModel).toBe("claude-haiku-3-5");
    expect(config.claudeTiebreakModel).toBe("claude-opus-4-7");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config/config.test.ts`
Expected: FAIL — `claudeJudgeModel`/`claudeTiebreakModel` undefined, and the updated default-value assertion still sees `claude-sonnet-4-6`.

- [ ] **Step 3: Add the config fields**

In `src/types/index.ts`, extend `AppConfig`:

```typescript
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  featureWorkItemIds: number[];
  targetRepoPath: string;
  maxInvestigationsPerDay: number;
  pollIntervalMinutes: number;
  claudeModel: string;
  claudeJudgeModel: string;
  claudeTiebreakModel: string;
  promptPath: string;
  assignedToFilter: string[];
  reinvestigateTag: string;
  stateDir: string;
  dryRun: boolean;
}
```

In `src/config/index.ts`, update the schema and the returned object:

```typescript
const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, "AZURE_DEVOPS_PAT is required"),
  AZURE_DEVOPS_ORG: z.string().min(1, "AZURE_DEVOPS_ORG is required"),
  AZURE_DEVOPS_PROJECT: z.string().min(1, "AZURE_DEVOPS_PROJECT is required"),
  FEATURE_WORK_ITEM_IDS: z.string().min(1, "FEATURE_WORK_ITEM_IDS is required"),
  TARGET_REPO_PATH: z.string().min(1, "TARGET_REPO_PATH is required"),
  MAX_INVESTIGATIONS_PER_DAY: z.coerce.number().default(5),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(15),
  CLAUDE_MODEL: z.string().default("claude-sonnet-5"),
  CLAUDE_JUDGE_MODEL: z.string().default("claude-haiku-4-5"),
  CLAUDE_TIEBREAK_MODEL: z.string().default("claude-opus-4-8"),
  PROMPT_PATH: z.string().default("src/prompts/investigate-bug.md"),
  ASSIGNED_TO_FILTER: z.string().optional(),
  REINVESTIGATE_TAG: z.string().default("agent investigate"),
  STATE_DIR: z.string().default(".state"),
});
```

And in the returned object inside `loadConfig`, add:

```typescript
    claudeModel: parsed.CLAUDE_MODEL,
    claudeJudgeModel: parsed.CLAUDE_JUDGE_MODEL,
    claudeTiebreakModel: parsed.CLAUDE_TIEBREAK_MODEL,
```

(inserted right after the existing `claudeModel: parsed.CLAUDE_MODEL,` line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config/config.test.ts`
Expected: PASS

- [ ] **Step 5: Update every other `AppConfig` test fixture in the repo**

Every file constructing a literal `AppConfig` will now fail to typecheck because the interface has two new required fields. Run `grep -rl "claudeModel:" tests/` — as of this writing that's `tests/services/processor.test.ts`, `tests/services/watcher.test.ts`, and `tests/sdk/azure-devops-client.test.ts` — and add `claudeJudgeModel: 'claude-haiku-4-5', claudeTiebreakModel: 'claude-opus-4-8',` next to each `claudeModel:` occurrence found (re-run the grep in case the file set has changed since this plan was written).

Run: `bun run typecheck`
Expected: PASS (no missing-property errors)

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/types/index.ts tests/config/config.test.ts tests/services/processor.test.ts tests/services/watcher.test.ts tests/sdk/azure-devops-client.test.ts
git commit -m "feat: add CLAUDE_JUDGE_MODEL and CLAUDE_TIEBREAK_MODEL config, bump default CLAUDE_MODEL to claude-sonnet-5"
```

---

### Task 2: Add verdict/judge/log types

**Files:**
- Modify: `src/types/index.ts`

**Interfaces:**
- Produces: `InvestigationVerdict`, `JudgeResult`, `ValidationLogEntry` — consumed by Tasks 3, 4, 5, 7.

- [ ] **Step 1: Replace the unused `InvestigationResult` type**

In `src/types/index.ts`, delete the existing unused block:

```typescript
/** Structured result from a bug investigation. */
export interface InvestigationResult {
  bugId: number;
  isValid: boolean | 'uncertain';
  rootCause: string;
  reproduction: string;
  fixSuggestion: string;
  ambiguities: string[];
}
```

Replace it with:

```typescript
/** Structured verdict extracted from one investigation pass's prose report. */
export interface InvestigationVerdict {
  isValid: 'yes' | 'no' | 'uncertain';
  rootCauseSummary: string;
  primaryCitation: { file: string; line?: number };
  suggestedFixSummary: string;
  confidence: 'high' | 'medium' | 'low';
}

/** Result of comparing two investigation verdicts. */
export interface JudgeResult {
  agree: boolean;
  reason: string;
}

/** One line of the append-only validation outcome log. */
export interface ValidationLogEntry {
  bugId: number;
  timestamp: string;
  verdictA: InvestigationVerdict;
  verdictB: InvestigationVerdict;
  judgeResult: JudgeResult;
  tieBreakUsed: boolean;
  tieBreakVerdict?: InvestigationVerdict;
  finalPass: 'A' | 'B' | 'tiebreak';
}
```

There is no test for this step alone — it's a pure type change, verified by Task 1's typecheck and every subsequent task's typecheck.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (nothing else in `src/` references `InvestigationResult` — confirmed via grep during design research)

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: replace unused InvestigationResult type with InvestigationVerdict, JudgeResult, ValidationLogEntry"
```

---

### Task 3: Verdict extraction module

**Files:**
- Create: `src/services/verdict-extractor.ts`
- Create: `tests/services/verdict-extractor.test.ts`

**Interfaces:**
- Consumes: `InvestigationVerdict` from `src/types/index.ts` (Task 2).
- Produces: `buildVerdictExtractionPrompt(report: string): string` and `extractVerdict(report: string, model: string): Promise<InvestigationVerdict>` — consumed by Task 6 (orchestrator).

- [ ] **Step 1: Write the failing test for the pure prompt builder**

Create `tests/services/verdict-extractor.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/verdict-extractor.test.ts`
Expected: FAIL with "Cannot find module '../../src/services/verdict-extractor.ts'"

- [ ] **Step 3: Write the implementation**

Create `src/services/verdict-extractor.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { InvestigationVerdict } from '../types/index.ts';

const VerdictSchema = z.object({
  isValid: z.enum(['yes', 'no', 'uncertain']),
  rootCauseSummary: z.string(),
  primaryCitation: z.object({
    file: z.string(),
    line: z.number().optional(),
  }),
  suggestedFixSummary: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export function buildVerdictExtractionPrompt(report: string): string {
  return [
    'Extract a structured verdict from the following bug investigation report.',
    'Base every field only on what the report actually states — do not infer beyond it.',
    'If the report does not clearly state a field, use your best reading of the report\'s intent.',
    '',
    '## Report',
    report,
  ].join('\n');
}

export async function extractVerdict(
  report: string,
  model: string,
): Promise<InvestigationVerdict> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildVerdictExtractionPrompt(report) }],
    output_config: { format: zodOutputFormat(VerdictSchema) },
  });

  if (!response.parsed_output) {
    throw new Error('Verdict extraction failed to produce structured output');
  }

  return response.parsed_output;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/services/verdict-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/verdict-extractor.ts tests/services/verdict-extractor.test.ts
git commit -m "feat: add verdict extraction from investigation reports via structured output"
```

---

### Task 4: Judge module

**Files:**
- Create: `src/services/judge.ts`
- Create: `tests/services/judge.test.ts`

**Interfaces:**
- Consumes: `InvestigationVerdict`, `JudgeResult` from `src/types/index.ts` (Task 2).
- Produces: `buildJudgePrompt(verdictA: InvestigationVerdict, verdictB: InvestigationVerdict): string` and `judgeVerdicts(verdictA: InvestigationVerdict, verdictB: InvestigationVerdict, model: string): Promise<JudgeResult>` — consumed by Task 6 (orchestrator).

- [ ] **Step 1: Write the failing test for the pure prompt builder**

Create `tests/services/judge.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildJudgePrompt } from '../../src/services/judge.ts';
import type { InvestigationVerdict } from '../../src/types/index.ts';

function verdict(overrides: Partial<InvestigationVerdict> = {}): InvestigationVerdict {
  return {
    isValid: 'yes',
    rootCauseSummary: 'Missing null check in auth.ts',
    primaryCitation: { file: 'src/auth.ts', line: 42 },
    suggestedFixSummary: 'Add a guard clause before dereferencing the token.',
    confidence: 'high',
    ...overrides,
  };
}

describe('buildJudgePrompt', () => {
  test('includes both verdicts', () => {
    const a = verdict();
    const b = verdict({ isValid: 'no' });
    const prompt = buildJudgePrompt(a, b);
    expect(prompt).toContain('auth.ts');
    expect(prompt).toContain('"isValid": "yes"');
    expect(prompt).toContain('"isValid": "no"');
  });

  test('asks whether the verdicts agree', () => {
    const prompt = buildJudgePrompt(verdict(), verdict());
    expect(prompt.toLowerCase()).toContain('agree');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/services/judge.test.ts`
Expected: FAIL with "Cannot find module '../../src/services/judge.ts'"

- [ ] **Step 3: Write the implementation**

Create `src/services/judge.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { InvestigationVerdict, JudgeResult } from '../types/index.ts';

const JudgeResultSchema = z.object({
  agree: z.boolean(),
  reason: z.string(),
});

export function buildJudgePrompt(
  verdictA: InvestigationVerdict,
  verdictB: InvestigationVerdict,
): string {
  return [
    'Two independent investigators each analyzed the same bug report and produced the structured verdicts below.',
    'Decide whether they materially agree: the bug-validity call must match, and the root cause must point at the same underlying issue',
    '(citing the same file, or the same logical cause even if line numbers differ slightly). Minor wording differences do not count as disagreement.',
    '',
    '## Verdict A',
    JSON.stringify(verdictA, null, 2),
    '',
    '## Verdict B',
    JSON.stringify(verdictB, null, 2),
    '',
    'Do they agree? Provide a brief reason either way.',
  ].join('\n');
}

export async function judgeVerdicts(
  verdictA: InvestigationVerdict,
  verdictB: InvestigationVerdict,
  model: string,
): Promise<JudgeResult> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: buildJudgePrompt(verdictA, verdictB) }],
    output_config: { format: zodOutputFormat(JudgeResultSchema) },
  });

  if (!response.parsed_output) {
    throw new Error('Judge failed to produce structured output');
  }

  return response.parsed_output;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/services/judge.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/judge.ts tests/services/judge.test.ts
git commit -m "feat: add judge module to compare two investigation verdicts"
```

---

### Task 5: Parameterize `investigateBug` by model

**Files:**
- Modify: `src/services/investigator.ts:91-133`

**Interfaces:**
- Produces: `investigateBug(config: AppConfig, context: InvestigationContext, model: string): Promise<string>` — consumed by Task 6 (orchestrator). This is a breaking signature change; `processor.ts` no longer calls this function directly after Task 8, but until then nothing else calls it, so this task is safe in isolation.

- [ ] **Step 1: Change the signature and the one call site inside the function**

In `src/services/investigator.ts`, change:

```typescript
export async function investigateBug(
  config: AppConfig,
  context: InvestigationContext,
): Promise<string> {
```

to:

```typescript
export async function investigateBug(
  config: AppConfig,
  context: InvestigationContext,
  model: string,
): Promise<string> {
```

And inside the `query({ ... options: { model: config.claudeModel, ...` block, change `model: config.claudeModel` to `model`.

- [ ] **Step 2: Run typecheck to confirm no other call sites break yet**

Run: `bun run typecheck`
Expected: FAIL — `src/services/processor.ts` still calls `deps.investigateBug(config, context)` with two args via `ProcessorDeps`'s type signature, which will now mismatch `inv.investigateBug`'s three-arg signature when processor.ts's `defaultDeps.investigateBug = inv.investigateBug` is type-checked.

This is expected and resolved by Task 8 in the same work session — do not leave the tree in this broken state between sessions. If you must pause here, also apply Task 8's `processor.ts` change before committing.

- [ ] **Step 3: Commit (only after Task 8 is also applied, so typecheck passes)**

```bash
git add src/services/investigator.ts
git commit -m "feat: parameterize investigateBug by model so it can run at Sonnet, Haiku, or Opus tier"
```

---

### Task 6: Investigation orchestrator

**Files:**
- Create: `src/services/investigation-orchestrator.ts`
- Create: `tests/services/investigation-orchestrator.test.ts`

**Interfaces:**
- Consumes: `investigateBug` (Task 5), `extractVerdict` (Task 3), `judgeVerdicts` (Task 4), `appendValidationLog` (Task 7 — write this task's test against a mocked version first, then wire the real one in once Task 7 exists), `InvestigationContext` from `investigator.ts`.
- Produces: `runInvestigation(config: AppConfig, bugId: number, context: InvestigationContext, deps?: OrchestratorDeps): Promise<string>` and the `OrchestratorDeps` interface — consumed by Task 8 (`processor.ts`).

Do Task 7 (`appendValidationLog`) before this task if working sequentially — the default-deps wiring in Step 3 below imports it directly. If working out of order, stub `src/state/validation-log.ts` with a no-op `export function appendValidationLog(): void {}` first and let Task 7 replace it.

- [ ] **Step 1: Write the failing tests**

Create `tests/services/investigation-orchestrator.test.ts`:

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { runInvestigation } from '../../src/services/investigation-orchestrator.ts';
import type { OrchestratorDeps } from '../../src/services/investigation-orchestrator.ts';
import type { AppConfig, InvestigationVerdict, JudgeResult } from '../../src/types/index.ts';
import type { InvestigationContext } from '../../src/services/investigator.ts';

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    featureWorkItemIds: [12345],
    targetRepoPath: 'C:/repos/my-repo',
    maxInvestigationsPerDay: 5,
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-5',
    claudeJudgeModel: 'claude-haiku-4-5',
    claudeTiebreakModel: 'claude-opus-4-8',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function mockContext(): InvestigationContext {
  return {
    bugTitle: 'Login crashes',
    bugDescription: 'desc',
    bugReproSteps: 'steps',
    discoveredSkills: [],
    images: [],
  };
}

function verdict(overrides: Partial<InvestigationVerdict> = {}): InvestigationVerdict {
  return {
    isValid: 'yes',
    rootCauseSummary: 'Missing null check',
    primaryCitation: { file: 'src/auth.ts', line: 42 },
    suggestedFixSummary: 'Add a guard clause',
    confidence: 'high',
    ...overrides,
  };
}

describe('runInvestigation', () => {
  test('agreement: posts pass A report, no tiebreak', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: true, reason: 'match' }));
    const appendValidationLog = mock(() => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug).toHaveBeenCalledTimes(2);
    expect(judgeVerdicts).toHaveBeenCalledTimes(1);
    expect(result).toBe('report from claude-sonnet-5');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(false);
    expect(logEntry.finalPass).toBe('A');
  });

  test('disagreement resolved by tiebreak agreeing with pass B', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    let judgeCall = 0;
    const judgeVerdicts = mock((): Promise<JudgeResult> => {
      judgeCall++;
      // 1st call: A vs B -> disagree. 2nd call: A vs tiebreak -> disagree. 3rd call: B vs tiebreak -> agree.
      if (judgeCall === 3) return Promise.resolve({ agree: true, reason: 'tiebreak matches B' });
      return Promise.resolve({ agree: false, reason: 'mismatch' });
    });
    const appendValidationLog = mock(() => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug).toHaveBeenCalledTimes(3);
    expect(investigateBug.mock.calls[2]![2]).toBe('claude-opus-4-8');
    expect(judgeVerdicts).toHaveBeenCalledTimes(3);
    // Tiebreak agreed with pass B, so pass B's own report is posted (per the
    // design: "if Opus agrees with A or B, post that agreeing pass's report") —
    // NOT the tiebreak's own report. Pass A/B both ran on config.claudeModel.
    expect(result).toBe('report from claude-sonnet-5');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(true);
    expect(logEntry.finalPass).toBe('B');
  });

  test('true 3-way split posts the tiebreak (Opus) report', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: false, reason: 'all differ' }));
    const appendValidationLog = mock(() => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    const result = await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(result).toBe('report from claude-opus-4-8');

    const logEntry = appendValidationLog.mock.calls[0]![1] as { tieBreakUsed: boolean; finalPass: string };
    expect(logEntry.tieBreakUsed).toBe(true);
    expect(logEntry.finalPass).toBe('tiebreak');
  });

  test('pass A and pass B both run on config.claudeModel', async () => {
    const investigateBug = mock((_c: AppConfig, _ctx: InvestigationContext, model: string) =>
      Promise.resolve(`report from ${model}`),
    );
    const extractVerdict = mock(() => Promise.resolve(verdict()));
    const judgeVerdicts = mock((): Promise<JudgeResult> => Promise.resolve({ agree: true, reason: 'match' }));
    const appendValidationLog = mock(() => {});

    const deps: OrchestratorDeps = { investigateBug, extractVerdict, judgeVerdicts, appendValidationLog };
    await runInvestigation(mockConfig(), 100, mockContext(), deps);

    expect(investigateBug.mock.calls[0]![2]).toBe('claude-sonnet-5');
    expect(investigateBug.mock.calls[1]![2]).toBe('claude-sonnet-5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/services/investigation-orchestrator.test.ts`
Expected: FAIL with "Cannot find module '../../src/services/investigation-orchestrator.ts'"

- [ ] **Step 3: Write the implementation**

Create `src/services/investigation-orchestrator.ts`:

```typescript
import type {
  AppConfig,
  InvestigationVerdict,
  JudgeResult,
  ValidationLogEntry,
} from '../types/index.ts';
import type { InvestigationContext } from './investigator.ts';
import * as inv from './investigator.ts';
import * as ext from './verdict-extractor.ts';
import * as jdg from './judge.ts';
import { appendValidationLog as writeValidationLog } from '../state/validation-log.ts';

export interface OrchestratorDeps {
  investigateBug: (
    config: AppConfig,
    context: InvestigationContext,
    model: string,
  ) => Promise<string>;

  extractVerdict: (report: string, model: string) => Promise<InvestigationVerdict>;

  judgeVerdicts: (
    verdictA: InvestigationVerdict,
    verdictB: InvestigationVerdict,
    model: string,
  ) => Promise<JudgeResult>;

  appendValidationLog: (config: AppConfig, entry: ValidationLogEntry) => void;
}

const defaultDeps: OrchestratorDeps = {
  investigateBug: inv.investigateBug,
  extractVerdict: ext.extractVerdict,
  judgeVerdicts: jdg.judgeVerdicts,
  appendValidationLog: writeValidationLog,
};

interface Pass {
  report: string;
  verdict: InvestigationVerdict;
}

async function runPass(
  config: AppConfig,
  context: InvestigationContext,
  model: string,
  deps: OrchestratorDeps,
): Promise<Pass> {
  const report = await deps.investigateBug(config, context, model);
  const verdict = await deps.extractVerdict(report, config.claudeJudgeModel);
  return { report, verdict };
}

export async function runInvestigation(
  config: AppConfig,
  bugId: number,
  context: InvestigationContext,
  deps: OrchestratorDeps = defaultDeps,
): Promise<string> {
  const [passA, passB] = await Promise.all([
    runPass(config, context, config.claudeModel, deps),
    runPass(config, context, config.claudeModel, deps),
  ]);

  const abJudgment = await deps.judgeVerdicts(passA.verdict, passB.verdict, config.claudeJudgeModel);

  if (abJudgment.agree) {
    deps.appendValidationLog(config, {
      bugId,
      timestamp: new Date().toISOString(),
      verdictA: passA.verdict,
      verdictB: passB.verdict,
      judgeResult: abJudgment,
      tieBreakUsed: false,
      finalPass: 'A',
    });
    return passA.report;
  }

  const tiebreak = await runPass(config, context, config.claudeTiebreakModel, deps);
  const aVsTiebreak = await deps.judgeVerdicts(passA.verdict, tiebreak.verdict, config.claudeJudgeModel);
  const bVsTiebreak = await deps.judgeVerdicts(passB.verdict, tiebreak.verdict, config.claudeJudgeModel);

  let finalPass: 'A' | 'B' | 'tiebreak';
  let finalReport: string;
  if (aVsTiebreak.agree) {
    finalPass = 'A';
    finalReport = passA.report;
  } else if (bVsTiebreak.agree) {
    finalPass = 'B';
    finalReport = passB.report;
  } else {
    finalPass = 'tiebreak';
    finalReport = tiebreak.report;
  }

  deps.appendValidationLog(config, {
    bugId,
    timestamp: new Date().toISOString(),
    verdictA: passA.verdict,
    verdictB: passB.verdict,
    judgeResult: abJudgment,
    tieBreakUsed: true,
    tieBreakVerdict: tiebreak.verdict,
    finalPass,
  });

  return finalReport;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/services/investigation-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/investigation-orchestrator.ts tests/services/investigation-orchestrator.test.ts
git commit -m "feat: add investigation orchestrator running dual passes with judge and tiebreak"
```

---

### Task 7: Validation outcome log

**Files:**
- Create: `src/state/validation-log.ts`
- Create: `tests/state/validation-log.test.ts`

**Interfaces:**
- Consumes: `ValidationLogEntry` from `src/types/index.ts` (Task 2).
- Produces: `appendValidationLog(config: AppConfig, entry: ValidationLogEntry): void` — consumed by Task 6 (orchestrator, already imports this by name; if Task 6 was done first with a stub, replace the stub file's contents with this implementation).

- [ ] **Step 1: Write the failing tests**

Create `tests/state/validation-log.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendValidationLog } from '../../src/state/validation-log.ts';
import type { AppConfig, ValidationLogEntry } from '../../src/types/index.ts';

function mockConfig(stateDir: string): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    featureWorkItemIds: [12345],
    targetRepoPath: 'C:/repos/my-repo',
    maxInvestigationsPerDay: 5,
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-5',
    claudeJudgeModel: 'claude-haiku-4-5',
    claudeTiebreakModel: 'claude-opus-4-8',
    promptPath: './prompt.md',
    stateDir,
    dryRun: false,
  };
}

function entry(bugId: number): ValidationLogEntry {
  return {
    bugId,
    timestamp: '2026-07-03T00:00:00.000Z',
    verdictA: {
      isValid: 'yes',
      rootCauseSummary: 'x',
      primaryCitation: { file: 'a.ts' },
      suggestedFixSummary: 'y',
      confidence: 'high',
    },
    verdictB: {
      isValid: 'yes',
      rootCauseSummary: 'x',
      primaryCitation: { file: 'a.ts' },
      suggestedFixSummary: 'y',
      confidence: 'high',
    },
    judgeResult: { agree: true, reason: 'match' },
    tieBreakUsed: false,
    finalPass: 'A',
  };
}

describe('appendValidationLog', () => {
  test('creates the state directory and writes one JSON line', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'validation-log-test-'));
    const config = mockConfig(stateDir);

    appendValidationLog(config, entry(100));

    const contents = readFileSync(join(stateDir, 'validation-log.jsonl'), 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry(100));
  });

  test('appends subsequent entries rather than overwriting', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'validation-log-test-'));
    const config = mockConfig(stateDir);

    appendValidationLog(config, entry(100));
    appendValidationLog(config, entry(101));

    const contents = readFileSync(join(stateDir, 'validation-log.jsonl'), 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).bugId).toBe(101);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/state/validation-log.test.ts`
Expected: FAIL with "Cannot find module '../../src/state/validation-log.ts'"

- [ ] **Step 3: Write the implementation**

Create `src/state/validation-log.ts`:

```typescript
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { AppConfig, ValidationLogEntry } from '../types/index.ts';

export function appendValidationLog(config: AppConfig, entry: ValidationLogEntry): void {
  const filePath = join(config.stateDir, 'validation-log.jsonl');
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/state/validation-log.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/validation-log.ts tests/state/validation-log.test.ts
git commit -m "feat: log dual-investigation validation outcomes to an append-only JSONL file"
```

---

### Task 8: Wire the orchestrator into `processor.ts`

**Files:**
- Modify: `src/services/processor.ts:1-59, 118-119`
- Modify: `tests/services/processor.test.ts` (every occurrence of `investigateBug` in `ProcessorDeps` usage)

**Interfaces:**
- Consumes: `runInvestigation` from `investigation-orchestrator.ts` (Task 6).
- Produces: `ProcessorDeps.runInvestigation` — this replaces `ProcessorDeps.investigateBug`, which is now unused.

- [ ] **Step 1: Update `ProcessorDeps` and `defaultDeps`**

In `src/services/processor.ts`, change the import block:

```typescript
import type { InvestigationContext } from './investigator.ts';
import type { AttachmentDownload } from '../sdk/azure-devops-client.ts';
import type { DiscoveredSkill } from './skill-loader.ts';

import { marked } from 'marked';
import * as sdk from '../sdk/azure-devops-client.ts';
import * as orchestrator from './investigation-orchestrator.ts';
import * as sl from './skill-loader.ts';
import { extractImageUrls, stripHtmlToText } from '../utils/html.ts';

export interface ProcessorDeps {
  getWorkItem: (
    config: AppConfig,
    workItemId: number,
  ) => Promise<WorkItemResponse>;

  runInvestigation: (
    config: AppConfig,
    bugId: number,
    context: InvestigationContext,
  ) => Promise<string>;

  addWorkItemComment: (
    config: AppConfig,
    workItemId: number,
    commentHtml: string,
  ) => Promise<unknown>;

  discoverTargetRepoSkills: (targetRepoPath: string) => DiscoveredSkill[];

  downloadAttachment: (
    config: AppConfig,
    attachmentUrl: string,
  ) => Promise<AttachmentDownload>;
}

const defaultDeps: ProcessorDeps = {
  getWorkItem: sdk.getWorkItem,
  runInvestigation: orchestrator.runInvestigation,
  addWorkItemComment: sdk.addWorkItemComment,
  discoverTargetRepoSkills: sl.discoverTargetRepoSkills,
  downloadAttachment: sdk.downloadAttachment,
};
```

(Remove the old `import * as inv from './investigator.ts';` line entirely — `processor.ts` no longer calls `investigator.ts` directly.)

- [ ] **Step 2: Update the call site**

Change:

```typescript
    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.investigateBug(config, context);
```

to:

```typescript
    log(`  Bug #${bugId}: Starting investigation...`);
    const output = await deps.runInvestigation(config, bugId, context);
```

- [ ] **Step 3: Update `tests/services/processor.test.ts`**

Read the file first (already read during design research — every mock and assertion referencing `investigateBug` needs renaming to `runInvestigation`). Specifically:

- In `makeDeps()`, rename the `investigateBug: mock(...)` key to `runInvestigation: mock(...)`.
- Every other test's `deps: makeDeps({ investigateBug: mock(...) })` override becomes `deps: makeDeps({ runInvestigation: mock(...) })`.
- Every assertion like `expect(deps.investigateBug).toHaveBeenCalledTimes(1)` becomes `expect(deps.runInvestigation).toHaveBeenCalledTimes(1)`.
- The test `'passes correct context to investigateBug'` — the mock function signature receives `(config, bugId, context)` now instead of `(config, context)`, so update any test reading `investigateMock.mock.calls[0]![1]` (previously the context, the second arg) to `investigateMock.mock.calls[0]![2]` (now the third arg, since `bugId` is inserted as the second argument). Check every test that indexes into `.mock.calls[0]!` for this function and shift the index from `[1]` to `[2]`.
- Rename the local variable `investigateMock` is fine to leave as-is (it's just a local name), but its calls now take three args — update any place that does `investigateMock.mock.calls[0]![1]` to `[2]` per the previous point.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/services/processor.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS — this also resolves Task 5's intentionally-broken intermediate state.

- [ ] **Step 6: Commit**

```bash
git add src/services/processor.ts tests/services/processor.test.ts
git commit -m "feat: wire the dual-investigation orchestrator into processor.ts, replacing the single-pass investigateBug call"
```

---

### Task 9: Move `@anthropic-ai/sdk` to runtime dependencies

**Files:**
- Modify: `package.json`

**Interfaces:** None — packaging only.

- [ ] **Step 1: Move the dependency**

In `package.json`, move `"@anthropic-ai/sdk": "^0.78.0"` out of `devDependencies` and into `dependencies` (it's now imported at runtime by `verdict-extractor.ts` and `judge.ts`, not just for types):

```json
{
  "name": "devops-pull-template",
  "version": "0.1.0",
  "type": "module",
  "module": "src/cli/index.ts",
  "scripts": {
    "start": "bun run src/cli/index.ts watch",
    "once": "bun run src/cli/index.ts run-once",
    "run-bug": "bun run src/cli/index.ts run-bug",
    "test": "bun test --preload ./tests/setup.ts tests/**/*.test.ts",
    "test:unit": "bun test --preload ./tests/setup.ts ./tests/config/ ./tests/sdk/ ./tests/state/ ./tests/services/",
    "test:integration": "bun test --preload ./tests/setup.ts tests/integration/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@anthropic-ai/sdk": "^0.78.0",
    "marked": "^17.0.4",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Reinstall to confirm the lockfile is consistent**

Run: `bun install`
Expected: no errors; lockfile updates (dependency was already installed, this just reclassifies it)

- [ ] **Step 3: Run full verification**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: move @anthropic-ai/sdk to runtime dependencies (now used by verdict extraction and judge)"
```

---

## Final Verification (after all tasks)

- [ ] `bun run typecheck` — PASS
- [ ] `bun test` — PASS (full suite, all existing + new tests)
- [ ] Manual dry-run check: set `DRY_RUN=true` (or however the CLI's dry-run flag is wired — check `src/cli/index.ts` and `src/config/index.ts` for the exact mechanism, since `dryRun` isn't currently sourced from an env var in `loadConfig` and may be a CLI flag instead) and run `bun run src/cli/index.ts run-bug <a-real-work-item-id>` against a real work item in a target repo. Confirm in the console output:
  - Two investigation passes run (look for two "Cost: $..." log lines from `investigator.ts`'s `query()` usage logging before the judge step).
  - A judge decision is made.
  - If you want to exercise the tiebreak path, temporarily point `CLAUDE_MODEL` at two different models for passes A/B by testing with a genuinely ambiguous bug, or add a temporary `console.log` in the orchestrator to confirm the disagreement branch is reachable — remove any temporary debug logging before committing.
  - `.state/validation-log.jsonl` gets one new line after the run, with `verdictA`, `verdictB`, `judgeResult`, and `finalPass` populated.

## Next steps after this ships

This was scoped as the first of four brainstormed improvements (see `docs/plans/` brainstorm context). Once this is live and `.state/validation-log.jsonl` has real data on how often the two passes disagree, revisit: richer bug classification taxonomy (beyond yes/no/uncertain), proving the suggested fix (sandboxed apply + test run), and skill/multi-agent orchestration for coverage.
