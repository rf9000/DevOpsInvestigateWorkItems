#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig } from '../config/index.ts';
import * as sdk from '../sdk/azure-devops-client.ts';
import type { BenchCase } from './collect.ts';
import { collectCases, repoNameFromRemote } from './collect.ts';
import type { BenchRow } from './run.ts';
import { runBench } from './run.ts';
import { renderReport, toCsv } from './report.ts';
import { VARIANTS } from './variants.ts';
import { createWorktree, originRemote, pruneWorktrees, resolveCommit } from './worktree.ts';

const HELP = `
Offline A/B benchmark: replay closed bugs against the code as it was before
their fix, and score each variant on cost and on whether it found the fixed files.

Usage:
  bun run bench:collect [--limit 20] [--ids 1,2,3] [--repo <name>] [--out bench/cases.json]
                        --ids: exactly these items; ones with no fix link run
                        at HEAD as unscored cases (cost and behavior only)
  bun run bench:run     [--variant legacy[,triage]] [--repeat 1] [--limit N]
                        [--cases 1,2,3] [--max-usd X] [--in bench/cases.json]
                        [--subscription]  use the claude.ai login, not ANTHROPIC_API_KEY
  bun run bench:report  <results.jsonl> [more.jsonl ...]

Variants: ${Object.keys(VARIANTS).join(', ')}
`.trim();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numberFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return n;
}

const command = process.argv[2];

switch (command) {
  case 'collect': {
    const config = loadConfig();
    const out = flag('out') ?? 'bench/cases.json';
    const repoName = flag('repo') ?? repoNameFromRemote((await originRemote(config.targetRepoPath)) ?? '');
    if (!repoName) {
      throw new Error('Could not read the repo name from the target repo origin remote; pass --repo <name>');
    }

    const ids = flag('ids')?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    console.log(ids
      ? `Collecting work items ${ids.join(', ')}; fixes must be in "${repoName}"...`
      : `Collecting closed bugs under features ${config.featureWorkItemIds.join(', ')} fixed in "${repoName}"...`);
    const { cases, skipped } = await collectCases(
      config,
      { limit: numberFlag('limit') ?? ids?.length ?? 20, repoName, ...(ids ? { ids } : {}) },
      {
        queryClosedBugs: sdk.queryClosedBugsUnderFeatures,
        getItems: sdk.getWorkItemsWithRelations,
        getRepositoryName: async (project, repoId) => (await sdk.getRepository(config, project, repoId)).name,
        getPullRequestBase: async (project, repoId, prId) =>
          (await sdk.getPullRequest(config, project, repoId, prId)).lastMergeTargetCommit?.commitId ?? null,
        getPullRequestFiles: (project, repoId, prId) => sdk.getPullRequestChangedFiles(config, project, repoId, prId),
        getCommitFiles: (project, repoId, sha) => sdk.getCommitChangedFiles(config, project, repoId, sha),
        resolveCommit: (ref) => resolveCommit(config.targetRepoPath, ref),
      },
    );

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(cases, null, 2) + '\n', 'utf-8');
    const unscored = cases.filter((c) => c.fixFiles.length === 0).length;
    if (unscored > 0) console.log(`${unscored} case(s) have no fix link and run unscored at HEAD.`);
    console.log(`Wrote ${cases.length} case(s) to ${out}. Review it by hand and drop cases that are not good tests.`);
    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.length}:`);
      for (const s of skipped) console.log(`  #${s.id}: ${s.reason}`);
    }
    break;
  }

  case 'run': {
    if (process.argv.includes('--subscription')) {
      // Without an API key the Agent SDK's Claude Code falls back to the
      // claude.ai login on this machine. CLAUDECODE is cleared so a run started
      // from inside a Claude Code session is not refused as a nested session.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDECODE;
      console.log('Auth: claude.ai subscription login (ANTHROPIC_API_KEY ignored). Costs below are API-equivalent, not billed.\n');
    }
    const config = loadConfig();
    const casesPath = flag('in') ?? 'bench/cases.json';
    if (!existsSync(casesPath)) throw new Error(`${casesPath} not found; run bench:collect first`);
    let cases = JSON.parse(readFileSync(casesPath, 'utf-8')) as BenchCase[];

    const only = flag('cases')?.split(',').map((s) => Number(s.trim()));
    if (only) cases = cases.filter((c) => only.includes(c.id));
    const limit = numberFlag('limit');
    if (limit !== undefined) cases = cases.slice(0, limit);

    const variants = (flag('variant') ?? 'legacy').split(',').map((s) => s.trim()).filter(Boolean);
    const repeat = numberFlag('repeat') ?? 1;
    const maxUsd = numberFlag('max-usd');
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join('bench', 'results', `${runId}-${variants.join('+')}.jsonl`);
    mkdirSync(dirname(outPath), { recursive: true });

    console.log(`Running ${cases.length} case(s) x ${repeat} repeat(s) x [${variants.join(', ')}]${maxUsd !== undefined ? `, budget $${maxUsd}` : ''}`);
    console.log(`Results: ${outPath}\n`);
    await pruneWorktrees(config.targetRepoPath);

    const result = await runBench(config, cases, { variants, repeat, runId, ...(maxUsd !== undefined ? { maxUsd } : {}) }, {
      variants: VARIANTS,
      createWorktree: (commit) => createWorktree(config.targetRepoPath, commit),
      appendRow: (row) => {
        appendFileSync(outPath, JSON.stringify(row) + '\n', 'utf-8');
        console.log(`  [${row.variant}] #${row.caseId} r${row.repeat}: ${row.outcome} | $${row.costUsd.toFixed(2)} | ${row.turns} turns | ${(row.durationMs / 1000).toFixed(0)}s | recall ${Math.round(row.fileRecall * 100)}%${row.error ? ` | ${row.error}` : ''}`);
      },
      now: () => Date.now(),
    });

    if (result.stoppedForBudget) console.log(`\nStopped: budget of $${maxUsd} reached.`);
    console.log(`\nTotal spend: $${result.totalUsd.toFixed(2)}\n`);
    console.log(renderReport(result.rows));
    break;
  }

  case 'report': {
    const files = process.argv.slice(3).filter((a) => !a.startsWith('--'));
    if (files.length === 0) throw new Error('Pass one or more results .jsonl files');
    const rows = files.flatMap((f) =>
      readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as BenchRow));
    console.log(renderReport(rows));
    const csvPath = files[0]!.replace(/\.jsonl$/, '') + '.csv';
    writeFileSync(csvPath, toCsv(rows), 'utf-8');
    console.log(`CSV: ${csvPath}`);
    break;
  }

  default:
    console.log(HELP);
}
