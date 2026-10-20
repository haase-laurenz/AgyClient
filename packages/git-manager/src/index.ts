import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitWorktreeInfo {
  worktreePath: string;
  head: string;
  branch: string;
  isMain: boolean;
  changedFilesCount: number;
}

export interface GitDiffResult {
  worktreePath: string;
  branch: string;
  changedFiles: Array<{
    status: string;
    path: string;
  }>;
  diffStat: string;
  diffPatch: string;
}

export interface MergeConflictCheckResult {
  canMergeCleanly: boolean;
  hasConflicts: boolean;
  conflictingFiles: string[];
  details: string;
}

export class GitWorktreeManager {
  private runGit(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 20000,
    });
    return {
      status: res.status ?? 1,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  }

  public isGitRepo(repoPath: string): boolean {
    if (!fs.existsSync(repoPath)) return false;
    const res = this.runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return res.status === 0 && res.stdout === 'true';
  }

  public getCurrentBranch(repoPath: string): string {
    const res = this.runGit(repoPath, ['branch', '--show-current']);
    return res.stdout || 'main';
  }

  public hasCommits(repoPath: string): boolean {
    const res = this.runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return res.status === 0;
  }

  /**
   * Ensures the repository is initialized and has at least one commit so worktrees can be branched.
   */
  public ensureRepoReadyForWorktrees(repoPath: string): void {
    if (!this.isGitRepo(repoPath)) {
      this.runGit(repoPath, ['init', '-b', 'main']);
    }
    if (!this.hasCommits(repoPath)) {
      this.runGit(repoPath, ['config', 'user.name', 'AgyClient']);
      this.runGit(repoPath, ['config', 'user.email', 'agyclient@local']);
      this.runGit(repoPath, ['commit', '--allow-empty', '-m', 'chore: initial commit for AgyClient worktrees']);
    }
  }

  /**
   * Lists all worktrees registered in the repository.
   */
  public listWorktrees(repoPath: string): GitWorktreeInfo[] {
    if (!this.isGitRepo(repoPath)) {
      return [];
    }
    const res = this.runGit(repoPath, ['worktree', 'list', '--porcelain']);
    if (res.status !== 0 || !res.stdout) {
      return [];
    }

    const blocks = res.stdout.split(/\r?\n\r?\n/);
    const mainResolved = path.resolve(repoPath).toLowerCase();
    const list: GitWorktreeInfo[] = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      let wtPath = '';
      let head = '';
      let branch = 'detached';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = path.resolve(line.slice('worktree '.length).trim());
        } else if (line.startsWith('HEAD ')) {
          head = line.slice('HEAD '.length).trim().slice(0, 8);
        } else if (line.startsWith('branch ')) {
          branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        }
      }

      if (wtPath) {
        let changedCount = 0;
        if (fs.existsSync(wtPath)) {
          const statusRes = this.runGit(wtPath, ['status', '--porcelain']);
          if (statusRes.status === 0 && statusRes.stdout) {
            changedCount = statusRes.stdout.split(/\r?\n/).filter(Boolean).length;
          }
        }
        list.push({
          worktreePath: wtPath,
          head,
          branch,
          isMain: wtPath.toLowerCase() === mainResolved,
          changedFilesCount: changedCount,
        });
      }
    }

    return list;
  }

  /**
   * Creates an isolated Git worktree inside `<repoPath>/.worktrees/<slug>` on branch `agy/<slug>`.
   */
  public createWorktree(
    repoPath: string,
    taskSlug: string,
    baseBranch?: string
  ): GitWorktreeInfo {
    this.ensureRepoReadyForWorktrees(repoPath);

    const sanitizedSlug = taskSlug
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `agent-${Date.now()}`;

    const branchName = `agy/${sanitizedSlug}`;
    const worktreesRoot = path.join(repoPath, '.worktrees');
    fs.mkdirSync(worktreesRoot, { recursive: true });
    const targetPath = path.join(worktreesRoot, sanitizedSlug);

    if (fs.existsSync(targetPath)) {
      const existing = this.listWorktrees(repoPath).find(
        (w) => path.resolve(w.worktreePath).toLowerCase() === path.resolve(targetPath).toLowerCase()
      );
      if (existing) {
        return existing;
      }
    }

    const base = baseBranch || this.getCurrentBranch(repoPath);
    const branchCheck = this.runGit(repoPath, ['rev-parse', '--verify', branchName]);
    const args =
      branchCheck.status === 0
        ? ['worktree', 'add', targetPath, branchName]
        : ['worktree', 'add', '-b', branchName, targetPath, base];

    const addRes = this.runGit(repoPath, args);
    if (addRes.status !== 0) {
      throw new Error(`Failed to create Git worktree: ${addRes.stderr || addRes.stdout}`);
    }

    const headRes = this.runGit(targetPath, ['rev-parse', '--short', 'HEAD']);
    return {
      worktreePath: targetPath,
      head: headRes.stdout || '',
      branch: branchName,
      isMain: false,
      changedFilesCount: 0,
    };
  }

  /**
   * Inspects uncommitted and committed diffs inside a worktree or repository.
   */
  public getWorktreeDiff(worktreePath: string, baseBranch?: string): GitDiffResult {
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path does not exist: ${worktreePath}`);
    }

    const branch = this.getCurrentBranch(worktreePath);
    const statusRes = this.runGit(worktreePath, ['status', '--porcelain']);
    const changedFiles = (statusRes.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim() || 'M',
        path: line.slice(3).trim(),
      }));

    const diffTarget = baseBranch || 'HEAD';
    const statRes = this.runGit(worktreePath, ['diff', '--stat', diffTarget]);
    const patchRes = this.runGit(worktreePath, ['diff', diffTarget]);

    return {
      worktreePath,
      branch,
      changedFiles,
      diffStat: statRes.stdout,
      diffPatch: patchRes.stdout.slice(0, 50_000),
    };
  }

  /**
   * Stages and commits all pending changes inside a worktree so they can be conflict-checked and merged.
   */
  public commitWorktreeChanges(worktreePath: string, message: string): { committed: boolean; commitHash: string } {
    this.runGit(worktreePath, ['add', '-A']);
    const status = this.runGit(worktreePath, ['status', '--porcelain']);
    if (!status.stdout) {
      const head = this.runGit(worktreePath, ['rev-parse', '--short', 'HEAD']);
      return { committed: false, commitHash: head.stdout };
    }

    this.runGit(worktreePath, ['config', 'user.name', 'AgyClient Agent']);
    this.runGit(worktreePath, ['config', 'user.email', 'agent@agyclient.local']);
    const commitRes = this.runGit(worktreePath, ['commit', '-m', message]);
    if (commitRes.status !== 0) {
      throw new Error(`Failed to commit worktree changes: ${commitRes.stderr || commitRes.stdout}`);
    }
    const head = this.runGit(worktreePath, ['rev-parse', '--short', 'HEAD']);
    return { committed: true, commitHash: head.stdout };
  }

  /**
   * Performs a non-destructive in-memory conflict check between `sourceBranch` and `targetBranch`
   * using `git merge-tree --write-tree`.
   */
  public checkMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch?: string
  ): MergeConflictCheckResult {
    const target = targetBranch || this.getCurrentBranch(repoPath);
    const res = this.runGit(repoPath, ['merge-tree', '--write-tree', target, sourceBranch]);

    if (res.status === 0) {
      return {
        canMergeCleanly: true,
        hasConflicts: false,
        conflictingFiles: [],
        details: `Branch "${sourceBranch}" can be cleanly integrated into "${target}".`,
      };
    }

    const conflictingFiles: string[] = [];
    for (const line of (res.stdout + '\n' + res.stderr).split(/\r?\n/)) {
      const match = /CONFLICT \([^)]+\): Merge conflict in (.+)/.exec(line);
      if (match && match[1]) {
        conflictingFiles.push(match[1].trim());
      }
    }

    return {
      canMergeCleanly: false,
      hasConflicts: true,
      conflictingFiles,
      details: res.stdout || res.stderr || 'Merge conflict detected between branches.',
    };
  }

  /**
   * Selectively integrates a worktree branch into the main repository after verifying zero conflicts.
   */
  public integrateWorktreeBranch(
    repoPath: string,
    worktreePath: string,
    commitMessage?: string
  ): {
    merged: boolean;
    branch: string;
    conflictCheck: MergeConflictCheckResult;
    output: string;
  } {
    const branch = this.getCurrentBranch(worktreePath);
    this.commitWorktreeChanges(
      worktreePath,
      commitMessage || `feat(agy): integrate changes from ${branch}`
    );

    const targetBranch = this.getCurrentBranch(repoPath);
    const conflictCheck = this.checkMergeConflicts(repoPath, branch, targetBranch);

    if (conflictCheck.hasConflicts) {
      return {
        merged: false,
        branch,
        conflictCheck,
        output: conflictCheck.details,
      };
    }

    const mergeRes = this.runGit(repoPath, ['merge', '--no-ff', '-m', `Merge agent branch ${branch}`, branch]);
    return {
      merged: mergeRes.status === 0,
      branch,
      conflictCheck,
      output: mergeRes.stdout || mergeRes.stderr,
    };
  }

  /**
   * Removes an isolated worktree directory cleanly.
   */
  public removeWorktree(repoPath: string, worktreePath: string, force = false): void {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    const res = this.runGit(repoPath, args);
    if (res.status !== 0) {
      throw new Error(`Failed to remove worktree: ${res.stderr || res.stdout}`);
    }
  }
}
