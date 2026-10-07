import { tmpdir } from 'os';
import { join } from 'path';
import type { Worktree } from './run.ts';

async function git(repoPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', '-C', repoPath, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Full SHA of `ref` in the local repo, or null when the commit is not there. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

export async function originRemote(repoPath: string): Promise<string | null> {
  const r = await git(repoPath, ['remote', 'get-url', 'origin']);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Check out `commit` into a detached worktree under the OS temp dir. The
 * target repo's own checkout is never touched; dispose removes the worktree.
 */
export async function createWorktree(repoPath: string, commit: string): Promise<Worktree> {
  const path = join(tmpdir(), 'devops-bench', `${commit.slice(0, 10)}-${Date.now()}`);
  const added = await git(repoPath, ['worktree', 'add', '--detach', path, commit]);
  if (added.code !== 0) {
    throw new Error(`git worktree add ${commit} failed: ${added.stderr}`);
  }
  return {
    path,
    dispose: async () => {
      const removed = await git(repoPath, ['worktree', 'remove', '--force', path]);
      if (removed.code !== 0) {
        console.error(`  Warning: could not remove worktree ${path}: ${removed.stderr}`);
      }
    },
  };
}

/**
 * Remove benchmark worktrees left behind by an interrupted run (Ctrl+C skips
 * dispose), then drop records of worktrees whose folders are gone. Only paths
 * under the bench temp folder are touched, never the user's own worktrees.
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  const benchRoot = join(tmpdir(), 'devops-bench').replace(/\\/g, '/').toLowerCase();
  const list = await git(repoPath, ['worktree', 'list', '--porcelain']);
  for (const line of list.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length).trim();
    if (path.replace(/\\/g, '/').toLowerCase().startsWith(`${benchRoot}/`)) {
      const removed = await git(repoPath, ['worktree', 'remove', '--force', path]);
      console.log(removed.code === 0
        ? `  Removed leftover bench worktree ${path}`
        : `  Warning: could not remove leftover worktree ${path}: ${removed.stderr}`);
    }
  }
  await git(repoPath, ['worktree', 'prune']);
}
