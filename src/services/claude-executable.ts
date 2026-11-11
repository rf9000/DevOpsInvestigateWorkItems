/**
 * The Claude Code binary a session runs. The SDK does not read
 * CLAUDE_CODE_EXECUTABLE_PATH itself: unset, it runs the binary bundled in its
 * platform package, which the Docker image removes.
 */
export function claudeExecutableOption(
  env: Record<string, string | undefined> = process.env,
): { pathToClaudeCodeExecutable?: string } {
  const path = env.CLAUDE_CODE_EXECUTABLE_PATH;
  return path ? { pathToClaudeCodeExecutable: path } : {};
}
