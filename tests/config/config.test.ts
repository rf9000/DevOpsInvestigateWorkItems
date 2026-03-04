import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/config/index.ts";

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: "test-pat-token",
  AZURE_DEVOPS_ORG: "my-org",
  AZURE_DEVOPS_PROJECT: "my-project",
  FEATURE_WORK_ITEM_IDS: "12345,67890",
  TARGET_REPO_PATH: "C:/repos/my-repo",
};

describe("loadConfig", () => {
  it("returns correct AppConfig for valid env", () => {
    const config = loadConfig(validEnv);

    expect(config.pat).toBe("test-pat-token");
    expect(config.org).toBe("my-org");
    expect(config.orgUrl).toBe("https://dev.azure.com/my-org");
    expect(config.project).toBe("my-project");
    expect(config.featureWorkItemIds).toEqual([12345, 67890]);
    expect(config.targetRepoPath).toBe("C:/repos/my-repo");
  });

  it("throws when AZURE_DEVOPS_PAT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PAT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_ORG is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_ORG;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_PROJECT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PROJECT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when FEATURE_WORK_ITEM_IDS is missing", () => {
    const env = { ...validEnv };
    delete env.FEATURE_WORK_ITEM_IDS;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when TARGET_REPO_PATH is missing", () => {
    const env = { ...validEnv };
    delete env.TARGET_REPO_PATH;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("applies default values when optional vars are absent", () => {
    const config = loadConfig(validEnv);

    expect(config.pollIntervalMinutes).toBe(15);
    expect(config.maxInvestigationsPerDay).toBe(5);
    expect(config.claudeModel).toBe("claude-sonnet-4-6");
    expect(config.promptPath).toBe(".claude/commands/do-process-item.md");
    expect(config.skillsDir).toBe(".claude/commands");
    expect(config.stateDir).toBe(".state");
  });

  it("overrides defaults when optional vars are provided", () => {
    const env = {
      ...validEnv,
      POLL_INTERVAL_MINUTES: "30",
      MAX_INVESTIGATIONS_PER_DAY: "10",
      CLAUDE_MODEL: "claude-opus-4-6",
      PROMPT_PATH: "custom/prompt.md",
      SKILLS_DIR: "custom/skills",
      STATE_DIR: "/tmp/state",
    };

    const config = loadConfig(env);

    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.maxInvestigationsPerDay).toBe(10);
    expect(config.claudeModel).toBe("claude-opus-4-6");
    expect(config.promptPath).toBe("custom/prompt.md");
    expect(config.skillsDir).toBe("custom/skills");
    expect(config.stateDir).toBe("/tmp/state");
  });

  it("splits feature work item IDs and trims whitespace", () => {
    const env = {
      ...validEnv,
      FEATURE_WORK_ITEM_IDS: "111, 222, 333",
    };

    const config = loadConfig(env);
    expect(config.featureWorkItemIds).toEqual([111, 222, 333]);
  });

  it("handles single feature work item ID without commas", () => {
    const env = {
      ...validEnv,
      FEATURE_WORK_ITEM_IDS: "99999",
    };

    const config = loadConfig(env);
    expect(config.featureWorkItemIds).toEqual([99999]);
  });

  it("throws on non-numeric feature work item IDs", () => {
    const env = {
      ...validEnv,
      FEATURE_WORK_ITEM_IDS: "123,not-a-number",
    };

    expect(() => loadConfig(env)).toThrow("not a number");
  });

  it("derives orgUrl from org name", () => {
    const env = { ...validEnv, AZURE_DEVOPS_ORG: "contoso" };
    const config = loadConfig(env);
    expect(config.orgUrl).toBe("https://dev.azure.com/contoso");
  });
});
