import { describe, test, expect, afterEach, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import {
  AzureDevOpsError,
  adoFetch,
  adoFetchWithRetry,
  getWorkItem,
  updateWorkItemField,
  queryBugsUnderFeatures,
  addWorkItemComment,
} from '../../src/sdk/azure-devops-client.ts';

const originalFetch = globalThis.fetch;
let mockFn: ReturnType<typeof mock>;

function mockConfig(): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat-token',
    featureWorkItemIds: [12345],
    targetRepoPath: 'C:/repos/my-repo',
    maxInvestigationsPerDay: 5,
    skillsDir: '.claude/commands',
    assignedToFilter: [],
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function setMockFetch(body: unknown, status = 200, statusText = 'OK') {
  mockFn = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

function setSequentialMockFetch(
  ...responses: Array<{ body: unknown; status?: number }>
) {
  let callIndex = 0;
  mockFn = mock(() => {
    const r = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        statusText: r.status && r.status >= 400 ? 'Error' : 'OK',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('adoFetch', () => {
  test('builds the correct URL and auth header', async () => {
    setMockFetch({ hello: 'world' });
    const config = mockConfig();

    const result = await adoFetch<{ hello: string }>(config, 'some/path');

    expect(result).toEqual({ hello: 'world' });
    expect(mockFn).toHaveBeenCalledTimes(1);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toBe(
      'https://dev.azure.com/my-org/my-project/_apis/some/path',
    );

    const headers = init.headers as Record<string, string>;
    const expectedAuth =
      'Basic ' + Buffer.from(':test-pat-token').toString('base64');
    expect(headers['Authorization']).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('throws AzureDevOpsError on non-ok response', async () => {
    setMockFetch({ message: 'Not Found' }, 404, 'Not Found');
    const config = mockConfig();

    try {
      await adoFetch(config, 'missing/resource');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      const adoErr = err as AzureDevOpsError;
      expect(adoErr.statusCode).toBe(404);
      expect(adoErr.name).toBe('AzureDevOpsError');
    }
  });
});

describe('adoFetchWithRetry', () => {
  test('retries on 500 and eventually succeeds', async () => {
    setSequentialMockFetch(
      { body: { error: 'Internal Server Error' }, status: 500 },
      { body: { ok: true }, status: 200 },
    );
    const config = mockConfig();

    const result = await adoFetchWithRetry<{ ok: boolean }>(
      config,
      'test/path',
      undefined,
      [0, 0, 0],
    );

    expect(result).toEqual({ ok: true });
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  test('does not retry on 404', async () => {
    setSequentialMockFetch(
      { body: { error: 'Not Found' }, status: 404 },
      { body: { ok: true }, status: 200 },
    );
    const config = mockConfig();

    try {
      await adoFetchWithRetry(config, 'test/path', undefined, [0, 0, 0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).statusCode).toBe(404);
    }

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting retries on 500', async () => {
    setSequentialMockFetch(
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
      { body: { error: 'fail' }, status: 500 },
    );
    const config = mockConfig();

    try {
      await adoFetchWithRetry(config, 'test/path', undefined, [0, 0, 0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).statusCode).toBe(500);
    }

    expect(mockFn).toHaveBeenCalledTimes(4);
  });
});

describe('getWorkItem', () => {
  test('builds correct URL and returns work item directly', async () => {
    const workItem = {
      id: 100,
      fields: { 'System.Title': 'Some work item' },
      rev: 3,
      url: 'https://example.com/100',
    };
    setMockFetch(workItem);
    const config = mockConfig();

    const result = await getWorkItem(config, 100);

    expect(result).toEqual(workItem);
    const url = mockFn.mock.calls[0]![0] as string;
    expect(url).toContain('wit/workitems/100');
    expect(url).toContain('$expand=all');
    expect(url).toContain('api-version=7.0');
  });
});

describe('updateWorkItemField', () => {
  test('sends PATCH with json-patch body and correct content-type', async () => {
    const updated = {
      id: 100,
      fields: { 'Custom.Field': 'New value' },
      rev: 4,
      url: 'https://example.com/100',
    };
    setMockFetch(updated);
    const config = mockConfig();

    const result = await updateWorkItemField(
      config,
      100,
      'Custom.Field',
      'New value',
    );

    expect(result).toEqual(updated);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toContain('wit/workitems/100');
    expect(url).toContain('api-version=7.0');
    expect(init.method).toBe('PATCH');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json-patch+json');

    const body = JSON.parse(init.body as string) as Array<{
      op: string;
      path: string;
      value: string;
    }>;
    expect(body).toEqual([
      { op: 'add', path: '/fields/Custom.Field', value: 'New value' },
    ]);
  });
});

describe('queryBugsUnderFeatures', () => {
  test('sends WIQL POST and extracts bug IDs from relations', async () => {
    const wiqlResponse = {
      workItemRelations: [
        { source: { id: 12345 }, target: { id: 100 }, rel: 'System.LinkTypes.Hierarchy-Forward' },
        { source: { id: 12345 }, target: { id: 200 }, rel: 'System.LinkTypes.Hierarchy-Forward' },
        { source: null, target: { id: 12345 }, rel: null },
      ],
    };
    setMockFetch(wiqlResponse);
    const config = mockConfig();

    const result = await queryBugsUnderFeatures(config, [12345, 67890]);

    expect(result).toEqual([100, 200, 12345]);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toContain('wit/wiql');
    expect(url).toContain('api-version=7.0');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).toContain('12345,67890');
    expect(body.query).toContain("'Bug', 'User Story'");
    expect(body.query).toContain('NOT IN');
  });

  test('deduplicates bug IDs', async () => {
    const wiqlResponse = {
      workItemRelations: [
        { source: { id: 12345 }, target: { id: 100 }, rel: null },
        { source: { id: 67890 }, target: { id: 100 }, rel: null },
      ],
    };
    setMockFetch(wiqlResponse);
    const config = mockConfig();

    const result = await queryBugsUnderFeatures(config, [12345, 67890]);

    expect(result).toEqual([100]);
  });

  test('returns empty array when no relations found', async () => {
    setMockFetch({ workItemRelations: [] });
    const config = mockConfig();

    const result = await queryBugsUnderFeatures(config, [12345]);

    expect(result).toEqual([]);
  });

  test('includes AssignedTo filter in WIQL when configured', async () => {
    setMockFetch({ workItemRelations: [] });
    const config = { ...mockConfig(), assignedToFilter: ['Alice Smith', 'Bob Jones'] };

    await queryBugsUnderFeatures(config, [12345]);

    const call = mockFn.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).toContain("[Target].[System.AssignedTo] IN ('Alice Smith', 'Bob Jones')");
  });

  test('omits AssignedTo filter when not configured', async () => {
    setMockFetch({ workItemRelations: [] });
    const config = mockConfig();

    await queryBugsUnderFeatures(config, [12345]);

    const call = mockFn.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).not.toContain('AssignedTo');
  });
});

describe('addWorkItemComment', () => {
  test('sends POST with comment text', async () => {
    const commentResponse = { id: 1, text: '<p>Investigation result</p>' };
    setMockFetch(commentResponse);
    const config = mockConfig();

    const result = await addWorkItemComment(config, 100, '<p>Investigation result</p>');

    expect(result).toEqual(commentResponse);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toContain('wit/workitems/100/comments');
    expect(url).toContain('api-version=7.0-preview.4');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe('<p>Investigation result</p>');
  });
});

describe('error handling', () => {
  test('404 throws AzureDevOpsError with statusCode', async () => {
    setMockFetch({ message: 'Resource not found' }, 404, 'Not Found');
    const config = mockConfig();

    try {
      await getWorkItem(config, 99999);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      const adoErr = err as AzureDevOpsError;
      expect(adoErr.statusCode).toBe(404);
      expect(adoErr.name).toBe('AzureDevOpsError');
      expect(adoErr.message).toContain('404');
    }
  });
});
