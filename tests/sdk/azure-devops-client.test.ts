import { describe, test, expect, afterEach, mock } from 'bun:test';
import type { AppConfig } from '../../src/types/index.ts';
import {
  AzureDevOpsError,
  adoFetch,
  adoFetchWithRetry,
  getWorkItem,
  updateWorkItemField,
  queryBugsUnderFeatures,
  queryTaggedBugsUnderFeatures,
  queryTaggedWorkItems,
  removeTagFromWorkItem,
  addWorkItemComment,
  downloadAttachment,
  queryClosedBugsUnderFeatures,
  getWorkItemsWithRelations,
  getRepository,
  getPullRequest,
  getPullRequestChangedFiles,
  getCommitChangedFiles,
  getWorkItemComments,
  searchWorkItems,
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
    assignedToFilter: [],
    reinvestigateTag: 'agent investigate',
    pollIntervalMinutes: 5,
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    costLogPath: '.state/cost-ledger.jsonl',
    dryRun: false,
    pipelineVariant: 'legacy',
    triageModel: 'claude-sonnet-5-5',
    triagePromptPath: './triage.md',
    deepPromptPath: './deep.md',
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

    expect(result).toEqual([100, 200]);

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
    expect(body.query).not.toContain('CreatedDate');
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

  test('excludes Removed state in WIQL query', async () => {
    setMockFetch({ workItemRelations: [] });
    const config = mockConfig();

    await queryBugsUnderFeatures(config, [12345]);

    const call = mockFn.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { query: string };
    expect(body.query).toContain("'Removed'");
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

describe('queryTaggedBugsUnderFeatures', () => {
  test('WIQL omits AssignedTo filter, then batch-fetches tags to filter locally', async () => {
    const wiqlResponse = {
      workItemRelations: [
        { source: { id: 12345 }, target: { id: 100 }, rel: null },
        { source: { id: 12345 }, target: { id: 200 }, rel: null },
      ],
    };
    const batchResponse = {
      value: [
        { id: 100, fields: { 'System.Tags': 'agent investigate; priority' } },
        { id: 200, fields: { 'System.Tags': 'other-tag' } },
      ],
    };
    setSequentialMockFetch(
      { body: wiqlResponse },
      { body: batchResponse },
    );
    const config = { ...mockConfig(), assignedToFilter: ['Alice Smith'] };

    const result = await queryTaggedBugsUnderFeatures(config, [12345], 'agent investigate');

    expect(result).toEqual([100]);

    // Verify WIQL has no AssignedTo and no CONTAINS tag filter
    const wiqlCall = mockFn.mock.calls[0]!;
    const wiqlInit = wiqlCall[1] as RequestInit;
    const body = JSON.parse(wiqlInit.body as string) as { query: string };
    expect(body.query).not.toContain('AssignedTo');
    expect(body.query).not.toContain('CONTAINS');

    // Verify batch GET fetched tags
    const batchCall = mockFn.mock.calls[1]!;
    const batchUrl = batchCall[0] as string;
    expect(batchUrl).toContain('wit/workitems?ids=');
    expect(batchUrl).toContain('fields=System.Tags');
  });

  test('returns empty array when no items under features', async () => {
    setMockFetch({ workItemRelations: [] });
    const config = mockConfig();

    const result = await queryTaggedBugsUnderFeatures(config, [12345], 'agent investigate');
    expect(result).toEqual([]);

    // Only one call (WIQL), no batch fetch needed
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when no items have the tag', async () => {
    const wiqlResponse = {
      workItemRelations: [
        { source: { id: 12345 }, target: { id: 100 }, rel: null },
      ],
    };
    const batchResponse = {
      value: [
        { id: 100, fields: { 'System.Tags': 'unrelated-tag' } },
      ],
    };
    setSequentialMockFetch(
      { body: wiqlResponse },
      { body: batchResponse },
    );
    const config = mockConfig();

    const result = await queryTaggedBugsUnderFeatures(config, [12345], 'agent investigate');
    expect(result).toEqual([]);
  });

  test('tag matching is case-insensitive', async () => {
    const wiqlResponse = {
      workItemRelations: [
        { source: { id: 12345 }, target: { id: 100 }, rel: null },
      ],
    };
    const batchResponse = {
      value: [
        { id: 100, fields: { 'System.Tags': 'Agent Investigate; other' } },
      ],
    };
    setSequentialMockFetch(
      { body: wiqlResponse },
      { body: batchResponse },
    );
    const config = mockConfig();

    const result = await queryTaggedBugsUnderFeatures(config, [12345], 'agent investigate');
    expect(result).toEqual([100]);
  });
});

describe('queryTaggedWorkItems', () => {
  test('uses flat WIQL query with CONTAINS, then batch-fetches for exact match', async () => {
    const wiqlResponse = {
      workItems: [
        { id: 100 },
        { id: 200 },
        { id: 300 },
      ],
    };
    const batchResponse = {
      value: [
        { id: 100, fields: { 'System.Tags': 'agent investigate; priority' } },
        { id: 200, fields: { 'System.Tags': 'other-tag' } },
        { id: 300, fields: { 'System.Tags': 'Agent Investigate' } },
      ],
    };
    setSequentialMockFetch(
      { body: wiqlResponse },
      { body: batchResponse },
    );
    const config = mockConfig();

    const result = await queryTaggedWorkItems(config, 'agent investigate');

    expect(result).toEqual([100, 300]);

    // Verify flat WIQL (not WorkItemLinks)
    const wiqlCall = mockFn.mock.calls[0]!;
    const wiqlInit = wiqlCall[1] as RequestInit;
    const body = JSON.parse(wiqlInit.body as string) as { query: string };
    expect(body.query).toContain('FROM WorkItems');
    expect(body.query).not.toContain('WorkItemLinks');
    expect(body.query).toContain("CONTAINS 'agent investigate'");
  });

  test('returns empty array when no items match CONTAINS', async () => {
    setMockFetch({ workItems: [] });
    const config = mockConfig();

    const result = await queryTaggedWorkItems(config, 'agent investigate');
    expect(result).toEqual([]);

    // Only one call (WIQL), no batch fetch needed
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('filters out substring matches via exact tag check', async () => {
    const wiqlResponse = {
      workItems: [{ id: 100 }],
    };
    const batchResponse = {
      value: [
        { id: 100, fields: { 'System.Tags': 'do not agent investigate this' } },
      ],
    };
    setSequentialMockFetch(
      { body: wiqlResponse },
      { body: batchResponse },
    );
    const config = mockConfig();

    const result = await queryTaggedWorkItems(config, 'agent investigate');
    expect(result).toEqual([]);
  });

  test('is not scoped to any feature IDs', async () => {
    setMockFetch({ workItems: [] });
    const config = mockConfig();

    await queryTaggedWorkItems(config, 'agent investigate');

    const wiqlCall = mockFn.mock.calls[0]!;
    const wiqlInit = wiqlCall[1] as RequestInit;
    const body = JSON.parse(wiqlInit.body as string) as { query: string };
    // Should NOT reference Source or feature IDs
    expect(body.query).not.toContain('[Source]');
    expect(body.query).not.toContain('12345');
  });
});

describe('removeTagFromWorkItem', () => {
  test('fetches work item, removes target tag, and updates field', async () => {
    // First call: getWorkItem, second call: updateWorkItemField
    setSequentialMockFetch(
      {
        body: {
          id: 100,
          fields: { 'System.Tags': 'agent investigate; priority; urgent' },
          rev: 3,
          url: 'https://example.com/100',
        },
      },
      {
        body: {
          id: 100,
          fields: { 'System.Tags': 'priority; urgent' },
          rev: 4,
          url: 'https://example.com/100',
        },
      },
    );
    const config = mockConfig();

    await removeTagFromWorkItem(config, 100, 'agent investigate');

    expect(mockFn).toHaveBeenCalledTimes(2);

    // Verify the PATCH call uses "replace" (not "add" which merges tags)
    const patchCall = mockFn.mock.calls[1]!;
    const init = patchCall[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string }>;
    expect(body[0]!.op).toBe('replace');
    expect(body[0]!.path).toBe('/fields/System.Tags');
    expect(body[0]!.value).toBe('priority; urgent');
  });

  test('handles case-insensitive tag removal', async () => {
    setSequentialMockFetch(
      {
        body: {
          id: 100,
          fields: { 'System.Tags': 'Agent Investigate; other-tag' },
          rev: 3,
          url: 'https://example.com/100',
        },
      },
      {
        body: {
          id: 100,
          fields: { 'System.Tags': 'other-tag' },
          rev: 4,
          url: 'https://example.com/100',
        },
      },
    );
    const config = mockConfig();

    await removeTagFromWorkItem(config, 100, 'agent investigate');

    const patchCall = mockFn.mock.calls[1]!;
    const init = patchCall[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string }>;
    expect(body[0]!.value).toBe('other-tag');
  });

  test('sets empty tags when removing the only tag', async () => {
    setSequentialMockFetch(
      {
        body: {
          id: 100,
          fields: { 'System.Tags': 'agent investigate' },
          rev: 3,
          url: 'https://example.com/100',
        },
      },
      {
        body: {
          id: 100,
          fields: { 'System.Tags': '' },
          rev: 4,
          url: 'https://example.com/100',
        },
      },
    );
    const config = mockConfig();

    await removeTagFromWorkItem(config, 100, 'agent investigate');

    const patchCall = mockFn.mock.calls[1]!;
    const init = patchCall[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string }>;
    expect(body[0]!.value).toBe('');
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

describe('downloadAttachment', () => {
  function setMockBinaryFetch(
    body: ArrayBuffer,
    contentType: string,
    status = 200,
  ) {
    mockFn = mock(() =>
      Promise.resolve(
        new Response(body, {
          status,
          statusText: status >= 400 ? 'Error' : 'OK',
          headers: { 'Content-Type': contentType },
        }),
      ),
    );
    globalThis.fetch = mockFn as unknown as typeof fetch;
  }

  const attachmentUrl =
    'https://dev.azure.com/org/_apis/wit/attachments/abc-123?fileName=screenshot.png';

  test('downloads attachment with correct auth header', async () => {
    const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    setMockBinaryFetch(pngData.buffer as ArrayBuffer, 'image/png');
    const config = mockConfig();

    const result = await downloadAttachment(config, attachmentUrl, [0]);

    expect(result.mediaType).toBe('image/png');
    expect(result.data).toBeInstanceOf(Buffer);
    expect(result.data.length).toBe(4);

    const call = mockFn.mock.calls[0]!;
    const url = call[0] as string;
    expect(url).toBe(attachmentUrl);

    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const expectedAuth =
      'Basic ' + Buffer.from(':test-pat-token').toString('base64');
    expect(headers['Authorization']).toBe(expectedAuth);
  });

  test('infers media type from file extension when Content-Type is generic', async () => {
    const data = new Uint8Array([0xff, 0xd8]);
    setMockBinaryFetch(
      data.buffer as ArrayBuffer,
      'application/octet-stream',
    );
    const config = mockConfig();

    const jpgUrl =
      'https://dev.azure.com/org/_apis/wit/attachments/abc?fileName=photo.jpg';
    const result = await downloadAttachment(config, jpgUrl, [0]);
    expect(result.mediaType).toBe('image/jpeg');
  });

  test('throws on unsupported media type', async () => {
    const data = new Uint8Array([0x25, 0x50]);
    setMockBinaryFetch(data.buffer as ArrayBuffer, 'application/pdf');
    const config = mockConfig();

    const pdfUrl =
      'https://dev.azure.com/org/_apis/wit/attachments/abc?fileName=doc.pdf';
    try {
      await downloadAttachment(config, pdfUrl, [0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).message).toContain('Unsupported media type');
    }
  });

  test('throws on 404', async () => {
    setMockBinaryFetch(new ArrayBuffer(0), 'image/png', 404);
    const config = mockConfig();

    try {
      await downloadAttachment(config, attachmentUrl, [0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzureDevOpsError);
      expect((err as AzureDevOpsError).statusCode).toBe(404);
    }
  });

  test('retries on 500 and succeeds', async () => {
    let callIndex = 0;
    mockFn = mock(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve(
          new Response('', { status: 500, statusText: 'Error' }),
        );
      }
      const data = new Uint8Array([0x89, 0x50]);
      return Promise.resolve(
        new Response(data.buffer as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    });
    globalThis.fetch = mockFn as unknown as typeof fetch;
    const config = mockConfig();

    const result = await downloadAttachment(config, attachmentUrl, [0, 0]);
    expect(result.mediaType).toBe('image/png');
    expect(mockFn).toHaveBeenCalledTimes(2);
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

describe('queryClosedBugsUnderFeatures', () => {
  test('queries resolved/closed bugs under features and drops the feature ids', async () => {
    setMockFetch({
      workItemRelations: [
        { target: { id: 12345 } },
        { target: { id: 700 } },
        { target: { id: 701 } },
        { target: { id: 700 } },
      ],
    });

    const result = await queryClosedBugsUnderFeatures(mockConfig(), [12345]);

    expect(result).toEqual([700, 701]);
    const body = JSON.parse((mockFn.mock.calls[0]![1] as RequestInit).body as string) as { query: string };
    expect(body.query).toContain("[Target].[System.WorkItemType] = 'Bug'");
    expect(body.query).toContain("[Target].[System.State] IN ('Resolved', 'Closed')");
  });
});

describe('getWorkItemsWithRelations', () => {
  test('batch-fetches with relations expanded, in chunks of 200', async () => {
    setMockFetch({ value: [{ id: 1, fields: {}, rev: 1, url: 'u', relations: [] }] });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);

    const result = await getWorkItemsWithRelations(mockConfig(), ids);

    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(String(mockFn.mock.calls[0]![0])).toContain('$expand=relations');
    expect(result).toHaveLength(2);
  });

  test('returns empty array without calling the API for no ids', async () => {
    setMockFetch({ value: [] });
    expect(await getWorkItemsWithRelations(mockConfig(), [])).toEqual([]);
    expect(mockFn).toHaveBeenCalledTimes(0);
  });
});

describe('git helpers', () => {
  test('getRepository uses the given project instead of the configured one', async () => {
    setMockFetch({ id: 'repo-guid', name: 'Continia Banking' });

    const repo = await getRepository(mockConfig(), 'proj-guid', 'repo-guid');

    expect(repo.name).toBe('Continia Banking');
    expect(String(mockFn.mock.calls[0]![0])).toBe(
      'https://dev.azure.com/my-org/proj-guid/_apis/git/repositories/repo-guid?api-version=7.0',
    );
  });

  test('getPullRequestChangedFiles reads the last iteration and drops folders', async () => {
    setSequentialMockFetch(
      { body: { value: [{ id: 1 }, { id: 3 }, { id: 2 }] } },
      {
        body: {
          changeEntries: [
            { item: { path: '/app/src/A.al' } },
            { item: { path: '/app/src', isFolder: true } },
            { item: { path: '/app/src/B.al', gitObjectType: 'blob' } },
            { item: { path: '/app/tree', gitObjectType: 'tree' } },
          ],
        },
      },
    );

    const files = await getPullRequestChangedFiles(mockConfig(), 'p', 'r', 42);

    expect(files).toEqual(['/app/src/A.al', '/app/src/B.al']);
    expect(String(mockFn.mock.calls[1]![0])).toContain('pullRequests/42/iterations/3/changes');
  });

  test('getPullRequest returns the merge target commit', async () => {
    setMockFetch({ status: 'completed', lastMergeTargetCommit: { commitId: 'abc' } });

    const pr = await getPullRequest(mockConfig(), 'p', 'r', 42);

    expect(pr.lastMergeTargetCommit?.commitId).toBe('abc');
  });

  test('getCommitChangedFiles returns blob paths', async () => {
    setMockFetch({
      changes: [
        { item: { path: '/x/A.cs', gitObjectType: 'blob' } },
        { item: { path: '/x', gitObjectType: 'tree' } },
      ],
    });

    const files = await getCommitChangedFiles(mockConfig(), 'p', 'r', 'sha1');

    expect(files).toEqual(['/x/A.cs']);
    expect(String(mockFn.mock.calls[0]![0])).toContain('commits/sha1/changes');
  });
});

describe('WIQL escaping', () => {
  test('queryTaggedWorkItems escapes single quotes in the tag', async () => {
    setMockFetch({ workItems: [] });

    await queryTaggedWorkItems(mockConfig(), "bob's tag");

    const body = JSON.parse((mockFn.mock.calls[0]![1] as RequestInit).body as string) as { query: string };
    expect(body.query).toContain("CONTAINS 'bob''s tag'");
  });
});

describe('rejected credentials', () => {
  test('a sign-in redirect throws a 401 naming the PAT instead of parsing HTML', async () => {
    mockFn = mock(() =>
      Promise.resolve(
        new Response('<html>Object moved</html>', {
          status: 302,
          headers: { Location: 'https://spsprodweu1.vssps.visualstudio.com/_signin?realm=x' },
        }),
      ),
    );
    globalThis.fetch = mockFn as unknown as typeof fetch;

    const err = await getWorkItem(mockConfig(), 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AzureDevOpsError);
    expect((err as AzureDevOpsError).statusCode).toBe(401);
    expect((err as AzureDevOpsError).message).toContain('AZURE_DEVOPS_PAT');
    expect((err as AzureDevOpsError).message).not.toContain('realm');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});

describe('getWorkItemComments', () => {
  test('returns the newest comments oldest first, as plain text', async () => {
    setMockFetch({
      comments: [
        { text: '<p>second</p>', createdDate: '2026-01-02', createdBy: { displayName: 'Bo' } },
        { text: '<p>first</p>', createdDate: '2026-01-01', createdBy: { displayName: 'Ann' } },
      ],
    });

    const result = await getWorkItemComments(mockConfig(), 7, 10);

    expect(result.map((c) => [c.author, c.text])).toEqual([['Ann', 'first'], ['Bo', 'second']]);
    expect(String(mockFn.mock.calls[0]![0])).toContain('wit/workitems/7/comments?$top=10&order=desc');
  });
});

describe('searchWorkItems', () => {
  test('requires every keyword, excludes the item, applies the cutoff and keeps WIQL order', async () => {
    setSequentialMockFetch(
      { body: { workItems: [{ id: 9 }, { id: 8 }] } },
      {
        body: {
          value: [
            { id: 8, fields: { 'System.Title': 'B', 'System.WorkItemType': 'Bug', 'System.State': 'Closed', 'System.CreatedDate': 'c8' } },
            { id: 9, fields: { 'System.Title': "A's", 'System.WorkItemType': 'User Story', 'System.State': 'New', 'System.CreatedDate': 'c9' } },
          ],
        },
      },
    );

    const result = await searchWorkItems(mockConfig(), ["O'Brien", 'export', ' '], { excludeId: 5, createdBefore: '2026-01-01T00:00:00Z' });

    expect(result.map((r) => r.id)).toEqual([9, 8]);
    expect(result[0]).toEqual({ id: 9, title: "A's", type: 'User Story', state: 'New', createdDate: 'c9' });
    expect(String(mockFn.mock.calls[0]![0])).toContain('timePrecision=true');
    const body = JSON.parse((mockFn.mock.calls[0]![1] as RequestInit).body as string) as { query: string };
    expect(body.query).toContain('[System.Id] <> 5');
    expect(body.query).toContain("[System.CreatedDate] < '2026-01-01T00:00:00Z'");
    expect(body.query).toContain("[System.Title] CONTAINS 'O''Brien'");
    expect(body.query).toContain("[System.Description] CONTAINS WORDS 'export'");
    expect(body.query).not.toContain("CONTAINS ' '");
  });

  test('no keywords means no API call', async () => {
    setMockFetch({});
    expect(await searchWorkItems(mockConfig(), ['  '], { excludeId: 1 })).toEqual([]);
    expect(mockFn).toHaveBeenCalledTimes(0);
  });
});
