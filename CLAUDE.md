# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DevOpsPullTemplate is a GitHub template repository for Azure DevOps automation projects. It provides production-ready scaffolding for pulling data from Azure DevOps, processing it (optionally with AI), and tracking state.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for environment config
- **AI:** @anthropic-ai/claude-agent-sdk for Claude integration
- **Testing:** Bun's built-in test framework

## Key Patterns

- **Dependency injection** via interfaces on all services for testability
- **Exponential backoff retry** on Azure DevOps API calls (5xx/network errors)
- **JSON state store** with Set-based O(1) lookups
- **Polling watcher** with graceful SIGINT/SIGTERM shutdown

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher
- `bun run once` — single poll cycle
- `bun run bench:run --variant legacy,triage` — compare pipelines on `bench/cases*.json`

## Pipelines

`PIPELINE_VARIANT` picks the pipeline. `legacy` (`investigator.ts` + `investigate-bug.md`) is the frozen benchmark baseline: do not edit it. `triage` runs `triager.ts` (cheap model, ADO duplicate search tools) and then `deep-investigator.ts` only when `routeFor` returns `investigate`; both stages return structured JSON rendered by `report-renderer.ts`.

## File Layout

- `src/config/` — Zod env validation
- `src/prompts/` — AI prompt templates (legacy investigation prompt; triage and deep-dive prompts)
- `src/sdk/` — Azure DevOps REST client
- `src/services/` — business logic (processor, watcher, skill discovery, triage pipeline)
- `src/bench/` — offline A/B benchmark: replays closed bugs at their pre-fix commit and scores cost and fix-file recall
- `src/state/` — JSON persistence
- `src/types/` — shared interfaces
- `tests/` — mirrors src/ structure
