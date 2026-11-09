import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Repository } from './git';
import { HistoryService, GitRef } from './history';

export interface GitOperation { type: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am'; conflicts: boolean }
export interface BranchPullPlan { branch: string; full: string; hash: string; upstream: string; remote: string; remoteRef: string }
export interface BranchPullResult { branch: string; status: 'fast-forward' | 'up-to-date' | 'local-ahead' }
export class GitActions {
  constructor(private repo: Repository) {}

  async operation(): Promise<GitOperation | undefined> {
    const gitDir = (await this.repo.run(['rev-parse', '--absolute-git-dir'])).replace(/\n$/, '');
    const exists = (name: string) => fs.access(path.join(gitDir, name)).then(() => true, () => false);
    const [merge, rebase, apply, cherry, revert] = await Promise.all(['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(exists));
    let type: GitOperation['type'] | undefined;
    if (rebase) type = 'rebase';
    else if (apply) type = await exists('rebase-apply/applying') ? 'am' : 'rebase';
    else if (cherry) type = 'cherry-pick';
    else if (revert) type = 'revert';
    else if (merge) type = 'merge';
    return type ? { type, conflicts: !!(await this.repo.run(['ls-files', '--unmerged', '-z'])) } : undefined;
  }

  async assertReady(clean = true): Promise<void> {
    if (await this.operation()) throw new Error('请先完成或中止正在进行的 Git 操作。');
    if (clean && (await this.repo.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) throw new Error('请先 Commit、Shelve 或 Stash 当前修改，再执行此操作。');
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.assertReady(false);
    const branch = (await this.repo.branches()).find(ref => !ref.remote && ref.name === oldName);
    if (!branch) throw new Error('本地分支不存在，请刷新。');
    await this.repo.run(['check-ref-format', '--branch', newName]);
    await this.repo.run(['branch', '-m', '--', oldName, newName]);
  }

  async checkout(ref: GitRef): Promise<void> {
    await this.assertReady(false);
    const selected = await new HistoryService(this.repo).resolve(ref);
    if (ref.kind === 'local') { await this.repo.run(['switch', '--no-guess', '--', ref.name!]); return; }
    if (ref.kind !== 'remote') throw new Error('标签请使用“检出提交（Detached HEAD）”或从这里新建分支。');
    const remotes = (await this.repo.run(['remote'])).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
    const remote = remotes.find(name => ref.name!.startsWith(`${name}/`));
    if (!remote) throw new Error('无法确定远程分支所属的 remote。');
    const local = ref.name!.slice(remote.length + 1);
    const existing = (await this.repo.branches()).find(branch => !branch.remote && branch.name === local);
    if (existing) {
      const upstream = (await this.repo.run(['for-each-ref', '--format=%(upstream)', `refs/heads/${local}`])).trim();
      if (upstream !== selected.full) throw new Error(`本地分支 ${local} 已存在且未跟踪此远程分支，请从这里新建一个不同名称的分支。`);
      await this.repo.run(['switch', '--no-guess', '--', local]);
    } else await this.repo.run(['switch', '-c', local, '--track', selected.full]);
  }

  async branchPullPlan(ref: GitRef): Promise<BranchPullPlan> {
    await this.assertReady(false);
    if (ref?.kind !== 'local') throw new Error('请选择需要更新的本地分支。');
    const selected = await new HistoryService(this.repo).resolve(ref);
    const branch = (await this.repo.branches()).find(branch => !branch.remote && branch.name === ref.name);
    if (!branch) throw new Error('本地分支已变化，请刷新。');
    if (branch.current) throw new Error('该分支已是当前分支，请使用顶部 Pull。');
    if (branch.worktree) throw new Error('该分支正在其他 Worktree 中检出，请到对应 Worktree 执行 Pull。');
    const fields = (await this.repo.run(['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', selected.full])).replace(/\n$/, '').split('\0');
    const merges = (await this.repo.run(['config', '--get-all', `branch.${ref.name}.merge`], [0, 1])).split('\n').filter(Boolean);
    if (fields[0] !== selected.full || !fields[1] || !fields[2] || !fields[3] || merges.length !== 1) throw new Error('该分支尚未设置唯一的上游分支，请先设置上游。');
    if (!fields[3].startsWith('refs/heads/') || (fields[2] !== '.' && !fields[1].startsWith('refs/remotes/'))) throw new Error('该分支的上游映射不支持后台 Pull，请检出该分支后使用顶部 Pull。');
    const symbolic = await Promise.all([selected.full, ...(fields[2] === '.' ? [] : [fields[1]])].map(full => this.repo.run(['symbolic-ref', '--quiet', full], [0, 1])));
    if (symbolic.some(value => value.trim())) throw new Error('目标分支或上游是符号引用，不支持后台 Pull，请检查引用配置。');
    return { branch: branch.name, full: selected.full, hash: selected.hash, upstream: fields[1], remote: fields[2], remoteRef: fields[3] };
  }

  async pullBranch(ref: GitRef, expected?: BranchPullPlan): Promise<BranchPullResult> {
    const plan = await this.branchPullPlan(ref);
    if (expected && JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error('确认期间目标分支或上游配置已变化，请刷新后重试。');
    const temporary = `refs/project-git/pull/${randomUUID()}`;
    const options = ['fetch', '--atomic', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap='];
    try {
      // Pin the fetched tip separately from FETCH_HEAD and concurrent Fetch.
      // Explicit refspecs ignore broad configured fetch mappings.
      await this.repo.run([...options, '--', plan.remote, `${plan.remoteRef}:${temporary}`, ...(plan.remote === '.' ? [] : [`+${plan.remoteRef}:${plan.upstream}`])]);
      const fetched = (await this.repo.run(['rev-parse', '--verify', `${temporary}^{commit}`])).trim();
      if (JSON.stringify(await this.branchPullPlan(ref)) !== JSON.stringify(plan)) throw new Error('获取期间目标分支或上游配置已变化，未更新本地分支。');
      if (fetched === plan.hash) return { branch: plan.branch, status: 'up-to-date' };
      const ancestor = (from: string, to: string) => this.repo.run(['merge-base', '--is-ancestor', from, to]).then(() => true, () => false);
      if (await ancestor(fetched, plan.hash)) return { branch: plan.branch, status: 'local-ahead' };
      if (!await ancestor(plan.hash, fetched)) throw new Error('本地分支与上游历史已分叉，未更新本地分支。请检出该分支后处理 Merge 或 Rebase。');
      // Git enforces fast-forward and refuses branches checked out in any
      // worktree. Never bypass that guard with update-head-ok or force.
      await this.repo.run([...options, '--', '.', `${temporary}:${plan.full}`]);
      return { branch: plan.branch, status: 'fast-forward' };
    } finally {
      await this.repo.run(['update-ref', '-d', temporary]).catch(() => {});
    }
  }

  async merge(hash: string, label: string): Promise<void> {
    await new HistoryService(this.repo).requireCommit(hash);
    await this.assertReady();
    await this.repo.run(['merge', '--no-edit', '-m', `Merge branch '${label}'`, '--', hash]);
  }

  async createTag(name: string, hash: string, message?: string): Promise<void> {
    await this.assertReady(false);
    await new HistoryService(this.repo).requireCommit(hash);
    await this.repo.run(['check-ref-format', `refs/tags/${name}`]);
    await this.repo.run(['tag', ...(message?.trim() ? ['-a', '-m', message] : []), '--', name, hash]);
  }

  async deleteTag(name: string, expectedHash?: string): Promise<void> {
    await this.assertReady(false);
    const tag = (await new HistoryService(this.repo).tags()).find(tag => tag.name === name);
    if (!tag) throw new Error('标签不存在，请刷新。');
    if (expectedHash && tag.hash !== expectedHash) throw new Error('确认期间标签已变化，请刷新后重试。');
    await this.repo.run(['update-ref', '-d', `refs/tags/${name}`, tag.hash]);
  }

  async pushTag(name: string, remote: string, expectedHash?: string): Promise<void> {
    await this.assertReady(false);
    const tag = (await new HistoryService(this.repo).tags()).find(tag => tag.name === name);
    if (!tag) throw new Error('标签不存在，请刷新。');
    if (expectedHash && tag.hash !== expectedHash) throw new Error('确认期间标签已变化，已取消推送，请刷新后重试。');
    if (!(await this.repo.run(['remote'])).split('\n').filter(Boolean).includes(remote)) throw new Error('Remote 不存在，请刷新后重试。');
    // Push the tag object itself, retaining annotated tag metadata/signatures.
    // Pin its hash, disable mirror/follow-tags/submodule pushes, and never force.
    await this.repo.run(['-c', `remote.${remote}.mirror=false`, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${tag.hash}:refs/tags/${tag.name}`], undefined, { includeStdoutOnError: true });
  }

  async deleteRemoteBranch(ref: GitRef, expectedHash?: string): Promise<void> {
    await this.assertReady(false);
    if (ref.kind !== 'remote' || !ref.name) throw new Error('请选择远程分支。');
    const selected = await new HistoryService(this.repo).resolve(ref);
    if (expectedHash && selected.hash !== expectedHash) throw new Error('确认期间远程跟踪分支已变化，请刷新后重试。');
    const remotes = (await this.repo.run(['remote'])).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
    const remote = remotes.find(name => ref.name!.startsWith(`${name}/`));
    if (!remote) throw new Error('无法确定该分支所属的 remote。');
    const branch = ref.name.slice(remote.length + 1);
    if (!branch || branch === 'HEAD') throw new Error('不能删除远程 HEAD。');
    // Explicit deletion refspec and lease prevent an implicit mirror push or
    // deletion of a branch that advanced after the last Fetch.
    await this.repo.run(['-c', `remote.${remote}.mirror=false`, 'push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${selected.hash}`, '--', remote, `:refs/heads/${branch}`]);
  }

  async checkoutCommit(hash: string): Promise<void> {
    await new HistoryService(this.repo).requireCommit(hash);
    await this.assertReady();
    await this.repo.run(['switch', '--detach', hash]);
  }

  async rebaseOnto(hash: string): Promise<void> {
    await new HistoryService(this.repo).requireCommit(hash);
    await this.assertReady();
    if (!(await this.repo.run(['symbolic-ref', '--quiet', 'HEAD'], [0, 1])).trim()) throw new Error('请先检出本地分支，再执行 Rebase。');
    await this.repo.run(['rebase', hash]);
  }

  async applyCommit(kind: 'cherry-pick' | 'revert', hash: string, mainline?: number): Promise<void> {
    if (!['cherry-pick', 'revert'].includes(kind)) throw new Error('无效操作。');
    const details = await new HistoryService(this.repo).details(hash);
    if (details.parents.length > 1 && (!Number.isInteger(mainline) || mainline! < 1 || mainline! > details.parents.length)) throw new Error('合并提交需要选择一个主线父提交。');
    await this.assertReady();
    await this.repo.run([kind, '--no-edit', ...(details.parents.length > 1 ? ['-m', String(mainline)] : []), hash]);
  }

  async resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('无效 Reset 模式。');
    await new HistoryService(this.repo).requireCommit(hash);
    await this.assertReady();
    await this.repo.run(['reset', `--${mode}`, hash]);
  }

  async finishOperation(action: 'continue' | 'abort' | 'skip', expected: GitOperation['type']): Promise<void> {
    const operation = await this.operation();
    if (!operation || operation.type !== expected || !['continue', 'abort', 'skip'].includes(action)) throw new Error('Git 操作状态已变化，请刷新后重试。');
    if (action === 'skip' && operation.type === 'merge') throw new Error('Merge 不支持跳过提交。');
    if (action === 'continue' && operation.conflicts) throw new Error('请先解决冲突并暂存，再继续。');
    if (operation.type === 'merge' && action === 'continue') await this.repo.run(['-c', 'core.editor=true', 'commit', '--no-edit']);
    else await this.repo.run(['-c', 'core.editor=true', operation.type, `--${action}`]);
  }
}
