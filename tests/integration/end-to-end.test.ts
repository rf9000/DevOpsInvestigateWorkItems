import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';
import { queryBugsUnderFeatures, getWorkItem } from '../../src/sdk/azure-devops-client.ts';

const hasCredentials = Boolean(
  process.env.AZURE_DEVOPS_PAT &&
  process.env.AZURE_DEVOPS_ORG &&
  process.env.AZURE_DEVOPS_PROJECT &&
  process.env.FEATURE_WORK_ITEM_IDS &&
  process.env.TARGET_REPO_PATH,
);

describe.skipIf(!hasCredentials)('Integration: Bug Investigation', () => {
  test('can query bugs under feature IDs', async () => {
    const config = loadConfig();
    const bugIds = await queryBugsUnderFeatures(config, config.featureWorkItemIds);
    expect(Array.isArray(bugIds)).toBe(true);
    for (const id of bugIds) {
      expect(typeof id).toBe('number');
    }
  });

  test('can get work item details for a bug', async () => {
    const config = loadConfig();
    const bugIds = await queryBugsUnderFeatures(config, config.featureWorkItemIds);
    if (bugIds.length > 0) {
      const wi = await getWorkItem(config, bugIds[0]!);
      expect(wi.id).toBeNumber();
      expect(wi.fields).toBeDefined();
      expect(wi.fields['System.Title']).toBeString();
      expect(wi.fields['System.WorkItemType']).toBeString();
    }
  });
});
