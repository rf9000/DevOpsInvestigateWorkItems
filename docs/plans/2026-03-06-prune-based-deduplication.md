# Prune-Based Deduplication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `createdAfter` date filter with pruning-based deduplication so that work items assigned after creation are not missed, and the processed ID list stays bounded.

**Architecture:** Remove the `createdAfter` field from state and the WIQL date filter. Query all open items every cycle. After each cycle, prune `processedBugIds` to only contain IDs still returned by the query (open items). Add a `pruneProcessed(currentIds)` method to StateStore.

**Tech Stack:** Bun, TypeScript, Zod

---

### Task 1: Add `pruneProcessed` to StateStore (TDD)

**Files:**
- Test: `tests/state/state-store.test.ts`
- Modify: `src/state/state-store.ts`

**Step 1: Write the failing test**

Add to `tests/state/state-store.test.ts`:

```ts
it('pruneProcessed removes IDs not in the current set', () => {
  const dir = makeTmpDir();
  const store = new StateStore(dir);

  store.markProcessed(1);
  store.markProcessed(2);
  store.markProcessed(3);
  store.markProcessed(4);

  // Only 2 and 4 are still open
  store.pruneProcessed([2, 4, 5]);

  expect(store.isProcessed(1)).toBe(false);
  expect(store.isProcessed(2)).toBe(true);
  expect(store.isProcessed(3)).toBe(false);
  expect(store.isProcessed(4)).toBe(true);
  expect(store.processedCount).toBe(2);
});

it('pruneProcessed persists after save/load', () => {
  const dir = makeTmpDir();
  const store = new StateStore(dir);

  store.markProcessed(10);
  store.markProcessed(20);
  store.markProcessed(30);
  store.pruneProcessed([20]);
  store.save();

  const store2 = new StateStore(dir);
  expect(store2.isProcessed(10)).toBe(false);
  expect(store2.isProcessed(20)).toBe(true);
  expect(store2.isProcessed(30)).toBe(false);
  expect(store2.processedCount).toBe(1);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/state/state-store.test.ts`
Expected: FAIL — `store.pruneProcessed is not a function`

**Step 3: Implement `pruneProcessed` in StateStore**

Add to `src/state/state-store.ts` in the `StateStore` class:

```ts
pruneProcessed(currentIds: number[]): void {
  const currentSet = new Set(currentIds);
  const kept = this.state.processedBugIds.filter((id) => currentSet.has(id));
  this.state.processedBugIds = kept;
  this.processedSet = new Set(kept);
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/state/state-store.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/state/state-store.ts tests/state/state-store.test.ts
git commit -m "feat: add pruneProcessed method to StateStore"
```

---

### Task 2: Remove `createdAfter` from state and types

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/state/state-store.ts`
- Modify: `tests/state/state-store.test.ts` (if any test references `createdAfter`)

**Step 1: Remove `createdAfter` from `ProcessedState` interface**

In `src/types/index.ts`, remove the `createdAfter: string;` line from the `ProcessedState` interface.

**Step 2: Remove `createdAfter` from StateStore**

In `src/state/state-store.ts`:
- Remove the `todayDateStringUTCPlus1()` helper function
- Remove `createdAfter: todayDateStringUTCPlus1()` from the default state in `load()` (line 49)
- Remove `this.state.createdAfter = todayDateStringUTCPlus1();` from `save()` (line 56)
- Remove `createdAfter: todayDateStringUTCPlus1()` from `reset()` (line 99)
- Remove the `get createdAfter()` getter (lines 109-111)

**Step 3: Run all tests**

Run: `bun test`
Expected: All PASS (no tests reference `createdAfter` on StateStore directly)

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: Errors in `watcher.ts` and `azure-devops-client.ts` referencing `createdAfter` — these are fixed in the next tasks.

**Step 5: Commit**

```bash
git add src/types/index.ts src/state/state-store.ts
git commit -m "refactor: remove createdAfter from ProcessedState and StateStore"
```

---

### Task 3: Remove `createdAfter` from WIQL query

**Files:**
- Modify: `src/sdk/azure-devops-client.ts`
- Modify: `tests/sdk/azure-devops-client.test.ts`

**Step 1: Update `queryBugsUnderFeatures` signature**

In `src/sdk/azure-devops-client.ts`, remove the `createdAfter?: string` parameter from `queryBugsUnderFeatures` (line 117) and remove the `if (createdAfter)` block (lines 122-124).

**Step 2: Update tests — remove `createdAfter`-specific test if any, verify WIQL no longer contains CreatedDate**

In `tests/sdk/azure-devops-client.test.ts`, update the existing test "sends WIQL POST and extracts bug IDs from relations" to verify the query does NOT contain `CreatedDate`:

Add this assertion at the end of the test:
```ts
expect(body.query).not.toContain('CreatedDate');
```

**Step 3: Run SDK tests**

Run: `bun test tests/sdk/azure-devops-client.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/sdk/azure-devops-client.ts tests/sdk/azure-devops-client.test.ts
git commit -m "refactor: remove createdAfter date filter from WIQL query"
```

---

### Task 4: Update watcher to remove `createdAfter` usage and add pruning

**Files:**
- Modify: `src/services/watcher.ts`
- Modify: `tests/services/watcher.test.ts`

**Step 1: Update `WatcherDeps` interface**

In `src/services/watcher.ts`, remove the `createdAfter?: string` parameter from the `queryBugsUnderFeatures` signature in `WatcherDeps` (line 13).

**Step 2: Update `runPollCycle`**

In `src/services/watcher.ts`:
- In the first-run seeding block (line 41): remove `stateStore.createdAfter` from the call — just pass `config` and `config.featureWorkItemIds`.
- In the main query (lines 51-52): remove `stateStore.createdAfter` from the call and update the log message to remove the "created after" part.
- After `stateStore.save()` (line 85), add pruning: `stateStore.pruneProcessed(bugIds);` before the save call. The full sequence should be:
  1. Process bugs
  2. Prune: `stateStore.pruneProcessed(bugIds);`
  3. Save: `stateStore.save();`

**Step 3: Update watcher tests**

In `tests/services/watcher.test.ts`:

Update the "first run seeds existing items" test: the mock `queryBugsUnderFeatures` should now accept only `(config, featureIds)` — no third `createdAfter` argument.

Add a new test for pruning:

```ts
test('prunes processed IDs not returned by current query', async () => {
  const config = mockConfig();

  // Pre-populate with old processed IDs
  stateStore.markProcessed(100);
  stateStore.markProcessed(200);
  stateStore.save();

  // Current query only returns 200 and 300
  const deps = makeDeps({
    queryBugsUnderFeatures: mock(() => Promise.resolve([200, 300])),
    processBug: mock((cfg: AppConfig, bugId: number) =>
      Promise.resolve({ bugId, investigated: true }),
    ),
  });

  await runPollCycle(config, stateStore, deps);

  // 100 should be pruned (not in query results)
  expect(stateStore.isProcessed(100)).toBe(false);
  // 200 should remain (still in query results)
  expect(stateStore.isProcessed(200)).toBe(true);
  // 300 should be processed (new)
  expect(stateStore.isProcessed(300)).toBe(true);
});
```

**Step 4: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add src/services/watcher.ts tests/services/watcher.test.ts
git commit -m "feat: replace createdAfter filter with pruning-based deduplication"
```

---

### Task 5: Final verification

**Step 1: Run full test suite**

Run: `bun test`
Expected: All PASS

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Verify no stale `createdAfter` references remain**

Run: `grep -r "createdAfter" src/ tests/`
Expected: No matches
