import { describe, expect, test } from 'bun:test';
import { claudeExecutableOption } from '../../src/services/claude-executable.ts';

describe('claudeExecutableOption', () => {
  test('names the binary from CLAUDE_CODE_EXECUTABLE_PATH', () => {
    expect(claudeExecutableOption({ CLAUDE_CODE_EXECUTABLE_PATH: '/home/claude/.local/bin/claude' }))
      .toEqual({ pathToClaudeCodeExecutable: '/home/claude/.local/bin/claude' });
  });

  test('adds nothing when the variable is unset or empty, so the SDK default stays', () => {
    expect(claudeExecutableOption({})).toEqual({});
    expect(claudeExecutableOption({ CLAUDE_CODE_EXECUTABLE_PATH: '' })).toEqual({});
  });
});
