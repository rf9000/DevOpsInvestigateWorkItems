import { existsSync } from 'fs';
import { join } from 'path';

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export function shouldPullRepo(lastPullAt: string | null): boolean {
  if (!lastPullAt) return true;
  const lastPull = new Date(lastPullAt).getTime();
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  return now - lastPull > twentyFourHours;
}

export async function pullRepo(repoPath: string): Promise<void> {
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const gitDir = join(repoPath, '.git');
  if (!existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  log(`Pulling latest changes in ${repoPath}...`);

  const proc = Bun.spawn(['git', '-C', repoPath, 'pull', '--ff-only'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`git pull failed (exit ${exitCode}): ${stderr}`);
  }

  log(`Repo pull complete: ${stdout.trim()}`);
}
