import { describe, test, expect, mock } from 'bun:test';
import type { AppConfig, ImageAttachment } from '../../src/types/index.ts';
import { processBug } from '../../src/services/processor.ts';
import type { ProcessorDeps } from '../../src/services/processor.ts';
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
    claudeModel: 'claude-sonnet-4-6',
    promptPath: './prompt.md',
    stateDir: '.state',
    dryRun: false,
  };
}

function makeDeps(overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    getWorkItem: mock(() =>
      Promise.resolve({
        id: 100,
        fields: {
          'System.Title': 'Login crashes on expired token',
          'System.Description': 'The login page crashes.',
          'Microsoft.VSTS.TCM.ReproSteps': '1. Login\n2. Wait\n3. Crash',
        },
        rev: 1,
        url: 'https://example.com/100',
      }),
    ),
    investigateBug: mock(() => Promise.resolve('### Bug Validity\nYes\n\n### Root Cause\nToken validation missing.')),
    addWorkItemComment: mock(() => Promise.resolve({ id: 1, text: 'comment' })),
    discoverTargetRepoSkills: mock(() => []),
    downloadAttachment: mock(() =>
      Promise.resolve({
        data: Buffer.from('fake-png-data'),
        mediaType: 'image/png' as const,
      }),
    ),
    ...overrides,
  };
}

describe('processBug', () => {
  test('successful investigation returns investigated=true', async () => {
    const config = mockConfig();
    const deps = makeDeps();

    const result = await processBug(config, 100, deps);

    expect(result).toEqual({ bugId: 100, investigated: true });
    expect(deps.getWorkItem).toHaveBeenCalledTimes(1);
    expect(deps.investigateBug).toHaveBeenCalledTimes(1);
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(1);
  });

  test('investigation failure returns investigated=false with error', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      investigateBug: mock(() =>
        Promise.reject(new Error('Claude API error')),
      ),
    });

    const result = await processBug(config, 100, deps);

    expect(result.bugId).toBe(100);
    expect(result.investigated).toBe(false);
    expect(result.error).toContain('Claude API error');
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(0);
  });

  test('getWorkItem failure returns investigated=false with error', async () => {
    const config = mockConfig();
    const deps = makeDeps({
      getWorkItem: mock(() =>
        Promise.reject(new Error('Work item not found')),
      ),
    });

    const result = await processBug(config, 999, deps);

    expect(result.bugId).toBe(999);
    expect(result.investigated).toBe(false);
    expect(result.error).toContain('Work item not found');
    expect(deps.investigateBug).toHaveBeenCalledTimes(0);
  });

  test('dry run investigates but does not post comment', async () => {
    const config = { ...mockConfig(), dryRun: true };
    const deps = makeDeps();

    const result = await processBug(config, 100, deps);

    expect(result).toEqual({ bugId: 100, investigated: true });
    expect(deps.investigateBug).toHaveBeenCalledTimes(1);
    expect(deps.addWorkItemComment).toHaveBeenCalledTimes(0);
  });

  test('passes correct context to investigateBug', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    expect(investigateMock).toHaveBeenCalledTimes(1);
    const context = investigateMock.mock.calls[0]![1] as {
      bugTitle: string;
      bugDescription: string;
      bugReproSteps: string;
    };
    expect(context.bugTitle).toBe('Login crashes on expired token');
    expect(context.bugDescription).toBe('The login page crashes.');
    expect(context.bugReproSteps).toBe('1. Login\n2. Wait\n3. Crash');
  });

  test('extracts images from HTML and passes them in context', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const downloadMock = mock(() =>
      Promise.resolve({
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mediaType: 'image/png' as const,
      }),
    );
    const deps = makeDeps({
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'Bug with screenshot',
            'System.Description':
              '<p>Error:</p><img src="https://dev.azure.com/org/_apis/wit/attachments/abc?fileName=err.png" alt="error">',
            'Microsoft.VSTS.TCM.ReproSteps': '<p>Steps</p>',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      investigateBug: investigateMock,
      downloadAttachment: downloadMock,
    });

    await processBug(config, 100, deps);

    expect(downloadMock).toHaveBeenCalledTimes(1);
    const context = investigateMock.mock.calls[0]![1] as InvestigationContext;
    expect(context.images).toHaveLength(1);
    expect(context.images[0]!.mediaType).toBe('image/png');
    expect(context.images[0]!.alt).toBe('error');
    expect(context.images[0]!.base64Data).toBe(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    );
  });

  test('strips HTML from description and repro steps', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'HTML bug',
            'System.Description': '<p>The <strong>login</strong> page crashes.</p>',
            'Microsoft.VSTS.TCM.ReproSteps': '<ol><li>Login</li><li>Wait</li></ol>',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    const context = investigateMock.mock.calls[0]![1] as InvestigationContext;
    expect(context.bugDescription).not.toContain('<p>');
    expect(context.bugDescription).not.toContain('<strong>');
    expect(context.bugDescription).toContain('login');
    expect(context.bugReproSteps).not.toContain('<ol>');
    expect(context.bugReproSteps).not.toContain('<li>');
  });

  test('continues investigation when image download fails', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      getWorkItem: mock(() =>
        Promise.resolve({
          id: 100,
          fields: {
            'System.Title': 'Bug with broken image',
            'System.Description':
              '<img src="https://dev.azure.com/org/_apis/wit/attachments/bad?fileName=x.png">',
            'Microsoft.VSTS.TCM.ReproSteps': '',
          },
          rev: 1,
          url: 'https://example.com/100',
        }),
      ),
      investigateBug: investigateMock,
      downloadAttachment: mock(() => Promise.reject(new Error('404 Not Found'))),
    });

    const result = await processBug(config, 100, deps);

    expect(result.investigated).toBe(true);
    const context = investigateMock.mock.calls[0]![1] as InvestigationContext;
    expect(context.images).toHaveLength(0);
  });

  test('discovers and passes target repo skills to investigation context', async () => {
    const config = mockConfig();
    const discovered = [
      { name: 'online-investigate', description: 'Investigates online.', skillDir: 'C:/fake/path' },
    ];
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      discoverTargetRepoSkills: mock(() => discovered),
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    expect(investigateMock).toHaveBeenCalledTimes(1);
    const context = investigateMock.mock.calls[0]![1] as InvestigationContext;
    expect(context.discoveredSkills).toEqual(discovered);
  });

  test('passes empty images array when no images in HTML', async () => {
    const config = mockConfig();
    const investigateMock = mock((_cfg: AppConfig, _ctx: unknown) => Promise.resolve('result'));
    const deps = makeDeps({
      investigateBug: investigateMock,
    });

    await processBug(config, 100, deps);

    const context = investigateMock.mock.calls[0]![1] as InvestigationContext;
    expect(context.images).toEqual([]);
  });
});
