import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ShelfStore, ShelfEntry } from './shelf';
import { HistoryService, GitTag } from './history';
import { GitActions, GitOperation } from './git-actions';

export interface Change { path: string; originalPath?: string; index: string; worktree: string; conflict: boolean }
export interface Commit { hash: string; parents: string[]; author: string; date: string; refs: string; subject: string }
export interface Branch { name: string; current: boolean; remote: boolean; upstream: string; tracking: string; hash?: string; worktree?: string }
export interface Snapshot {
  root: string; name: string; branch: string; upstream: string; ahead: number; behind: number;
  changes: Change[]; commits: Commit[]; branches: Branch[]; remotes: string[]; merging: boolean;
  head: { hash: string; message: string } | null;
  shelves: ShelfEntry[];
  tags: GitTag[]; operation?: GitOperation;
}

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stderr: string) { super(stderr.trim() || `git ${args[0]} 执行失败`); }
}

export interface GitOptions { indexFile?: string; input?: string | Buffer; includeStdoutOnError?: boolean }

/** Keep bytes intact for data that will later be applied back to the repository. */
export function runGitBytes(cwd: string, args: string[], allowedCodes: number[] = [0], options: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Path-taking commands need literal pathspecs. Applying this globally
    // also affects Git's internal subprocesses (notably stash's clean step).
    const literal = ['add', 'restore', 'rm', 'commit', 'diff', 'ls-files', 'log'].includes(args[0]) ? ['--literal-pathspecs'] : [];
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) delete (env as NodeJS.ProcessEnv)[key];
    if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
    const child = execFile('git', [...literal, '-C', cwd, ...args], {
      encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
      env,
    }, (error, stdout, stderr) => {
      if (error && !(typeof error.code === 'number' && allowedCodes.includes(error.code))) reject(new GitError(args, [stderr.toString('utf8'), ...(options.includeStdoutOnError ? [stdout.toString('utf8')] : [])].filter(Boolean).join('\n') || error.message));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
  });
}

export async function runGit(cwd: string, args: string[], allowedCodes: number[] = [0], options: GitOptions = {}): Promise<string> {
  return (await runGitBytes(cwd, args, allowedCodes, options)).toString('utf8');
}

export function parseStatus(raw: string): Change[] {
  const records = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const index = record[0], worktree = record[1];
    const change: Change = { path: record.slice(3), index, worktree, conflict: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(index + worktree) };
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') change.originalPath = records[++i];
    // A staged deletion recreated on disk appears twice in porcelain v1.
    // Represent the combined file once, since commits include its working copy.
    const existing = changes.find(c => c.path === change.path);
    if (existing?.index === 'D' && index === '?') existing.worktree = 'M';
    else changes.push(change);
  }
  return changes;
}

export function parseLog(raw: string): Commit[] {
  const fields = raw.split('\0');
  const commits: Commit[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    commits.push({ hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], refs: fields[i + 4], subject: fields[i + 5] });
  }
  return commits;
}

export async function findRepository(resource: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(resource);
    const cwd = stat.isDirectory() ? resource : path.dirname(resource);
    // Remove only Git's output delimiter, not legal whitespace in the path.
    return (await runGit(cwd, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  } catch { return undefined; }
}

const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '.gradle', '.idea', '.vscode', 'build', 'dist', 'out', '.next', '__pycache__', 'Pods', 'oh_modules', '.hvigor']);
export async function discoverRepositories(roots: string[], depth: number): Promise<{ roots: string[]; truncated: boolean }> {
  const found = new Set<string>();
  const visited = new Set<string>();
  let count = 0, truncated = false;
  async function visit(dir: string, level: number): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);
    if (++count > 15_000) { truncated = true; return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.name === '.git')) {
      const root = await findRepository(dir);
      if (root) found.add(root);
    }
    if (level >= depth) return;
    // Also find nested repositories and submodules; do not follow directory symlinks.
    for (const entry of entries) {
      if (entry.isDirectory() && !excluded.has(entry.name)) await visit(path.join(dir, entry.name), level + 1);
    }
  }
  for (const root of roots) {
    const enclosing = await findRepository(root);
    if (enclosing) found.add(enclosing);
    await visit(root, 0);
  }
  return { roots: [...found].sort(), truncated };
}

export class Repository {
  constructor(public readonly root: string) {}
  run(args: string[], codes?: number[], options?: GitOptions): Promise<string> { return runGit(this.root, args, codes, options); }
  runBytes(args: string[], codes?: number[], options?: GitOptions): Promise<Buffer> { return runGitBytes(this.root, args, codes, options); }

  async snapshot(limit = 150): Promise<Snapshot> {
    const [raw, branch, upstream, tracking, commits, branches, remotes, mergeHead, head, shelves, tags, operation] = await Promise.all([
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
      this.run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => '0\t0'),
      this.log(limit), this.branches(), this.run(['remote']),
      this.run(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], [0, 1]),
      this.head(),
      new ShelfStore(this).list(),
      new HistoryService(this).tags(), new GitActions(this).operation(),
    ]);
    const [ahead, behind] = tracking.trim().split(/\s+/).map(Number);
    return {
      root: this.root, name: path.basename(this.root), branch: branch.trim() || 'detached HEAD', upstream: upstream.trim(),
      ahead: ahead || 0, behind: behind || 0, changes: parseStatus(raw), commits, branches,
      remotes: remotes.trim().split('\n').filter(Boolean), merging: !!mergeHead.trim(), head, shelves, tags, operation,
    };
  }

  async head(): Promise<{ hash: string; message: string } | null> {
    if (!(await this.run(['rev-parse', '--verify', 'HEAD']).catch(() => ''))) return null;
    const raw = await this.run(['log', '-1', '--no-patch', '--no-notes', '--no-show-signature', '--no-color', '--format=%H%x00%B']);
    const separator = raw.indexOf('\0');
    return { hash: raw.slice(0, separator), message: raw.slice(separator + 1).trimEnd() };
  }

  async log(limit: number): Promise<Commit[]> {
    return (await new HistoryService(this).query({ limit })).commits;
  }

  async branches(): Promise<Branch[]> {
    const fields = (await this.run(['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)%00%(worktreepath)%00', 'refs/heads/', 'refs/remotes/'])).split('\0');
    const branches: Branch[] = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const ref = fields[i].replace(/^\n/, ''), head = fields[i + 1], upstream = fields[i + 2], tracking = fields[i + 3], hash = fields[i + 4], worktree = fields[i + 5];
      const remote = ref.startsWith('refs/remotes/'), name = ref.replace(/^refs\/(heads|remotes)\//, '');
      if (remote && name.endsWith('/HEAD')) continue;
      branches.push({ name, current: head === '*', remote, upstream, tracking, hash, worktree });
    }
    return branches;
  }

  async validatePaths(paths: string[]): Promise<Change[]> {
    if (!paths.length || paths.some(p => typeof p !== 'string' || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('请选择有效的仓库内文件。');
    const changes = parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    return [...new Set(paths)].map(p => {
      const change = changes.find(c => c.path === p);
      if (!change) throw new Error(`文件状态已变化，请刷新后重试：${p}`);
      return change;
    });
  }

  async stage(paths: string[]): Promise<void> {
    const changes = (await this.validatePaths(paths)).filter(c => c.index === '?' || c.worktree !== ' ');
    if (!changes.length) return;
    // An index rename already records the old path's deletion; adding that old
    // nonexistent path again fails. Only stage the destination in this case.
    await this.run(['add', '--', ...changes.flatMap(c => c.originalPath && c.index === ' ' ? [c.originalPath, c.path] : [c.path])]);
  }

  async unstage(paths: string[]): Promise<void> {
    const changes = (await this.validatePaths(paths)).filter(c => c.index !== ' ' && c.index !== '?');
    if (!changes.length) return;
    const files = changes.flatMap(c => c.originalPath ? [c.originalPath, c.path] : [c.path]);
    const head = await this.run(['rev-parse', '--verify', 'HEAD']).catch(() => '');
    if (head) await this.run(['restore', '--staged', '--', ...files]);
    else await this.run(['rm', '--cached', '--', ...files]);
  }

  async commit(paths: string[], message: string, options: { amend?: boolean; expectedHead?: string } = {}): Promise<void> {
    if (!message.trim()) throw new Error('请填写提交信息。');
    if (options.amend) {
      const head = await this.head();
      if (!head) throw new Error('当前仓库还没有提交，无法 Amend。');
      if (options.expectedHead !== head.hash) throw new Error('最后一次提交已变化，请刷新后重新勾选 Amend commit。');
    }
    const changes = options.amend && !paths.length ? [] : await this.validatePaths(paths);
    const all = parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (all.some(c => c.conflict)) throw new Error('仓库存在未解决的冲突，请先解决冲突并暂存。');
    if ((await this.run(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], [0, 1])).trim()) throw new Error('合并进行中，请使用 VS Code 源代码管理完成合并提交。');
    const renames = changes.filter(change => change.originalPath);
    const ignoreCase = renames.length > 0 && (await this.run(['config', '--bool', '--get', 'core.ignorecase'], [0, 1])).trim() === 'true';
    const pathKey = (value: string) => ignoreCase ? value.toLowerCase() : value;
    const selectedPaths = new Set(paths.map(pathKey));
    for (const change of renames) {
      const original = pathKey(change.originalPath!);
      // A recreated source may be ignored, so status alone is insufficient.
      // Also fail closed if core.ignorecase disagrees with the filesystem.
      if ((change.index === 'R' || change.worktree === 'R') && !selectedPaths.has(original)) {
        try {
          await fs.lstat(path.join(this.root, change.originalPath!));
          throw new Error(`重命名的原路径另有内容，请一并勾选或先处理该路径：${change.originalPath}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (all.some(other => {
        const candidate = pathKey(other.path);
        return (candidate === original || candidate.startsWith(`${original}/`)) && !selectedPaths.has(candidate);
      })) {
        throw new Error(`重命名的原路径另有修改，请一并勾选或先处理该文件：${change.originalPath}`);
      }
    }
    const files = changes.flatMap(c => c.originalPath ? [c.originalPath, c.path] : [c.path]);
    // --only ensures staged changes in unchecked files never leak into this commit.
    const newFiles = changes.filter(c => c.index === '?' || c.index === 'A').map(c => c.path);
    if (newFiles.length) await this.run(['add', '--', ...newFiles]);
    await this.run(['commit', ...(options.amend ? ['--amend'] : []), '--only', '-m', message, '--', ...files]);
  }

  async discardChanges(paths: string[]): Promise<Change[]> {
    const changes = await this.validatePaths(paths);
    if (changes.some(c => ![' ', '?'].includes(c.index) || c.conflict)) throw new Error('只能丢弃未暂存的已跟踪更改和未跟踪文件；请先取消暂存或处理冲突。');
    const canonicalRoot = await fs.realpath(this.root);
    for (const change of changes) {
      const file = path.resolve(this.root, change.path);
      const relative = path.relative(this.root, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || change.path.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('不能丢弃仓库外或 Git 内部路径。');
      // Do not traverse a parent symlink into an unchecked file or another repo.
      let parent = canonicalRoot;
      for (const part of path.dirname(relative).split(path.sep).filter(part => part !== '.')) {
        parent = path.join(parent, part);
        const stat = await fs.lstat(parent).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && change.index === ' ') return undefined;
          throw error;
        });
        if (!stat) break; // Git restore can recreate a deleted tracked parent.
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`路径经过符号链接或非目录，请在实际所属仓库操作：${change.path}`);
      }
      const stat = await fs.lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && change.index === ' ') return undefined;
        throw error;
      });
      if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`仅支持文件或符号链接，不能递归删除目录或嵌套仓库：${change.path}`);
    }
    return changes;
  }

  async discard(paths: string[], expected?: Change[]): Promise<void> {
    const changes = await this.discardChanges(paths);
    if (expected && JSON.stringify(changes) !== JSON.stringify(expected)) throw new Error('确认期间文件状态已变化，请刷新后重新选择。');
    const tracked = changes.filter(c => c.index === ' ');
    if (tracked.length) await this.run(['restore', '--worktree', '--', ...tracked.map(c => c.path)]);
    // Unlink exact leaf paths only. Never use recursive removal, a wildcard or
    // repository-wide clean; unlinking a symlink leaves its target untouched.
    const canonicalRoot = await fs.realpath(this.root);
    for (const change of changes.filter(c => c.index === '?')) {
      const current = parseStatus(await this.run(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', change.path])).find(c => c.path === change.path);
      if (current?.index !== '?') throw new Error('文件状态已变化，已停止删除，请刷新检查已完成的操作。');
      if (await fs.realpath(path.dirname(path.join(this.root, change.path))) !== path.resolve(canonicalRoot, path.dirname(change.path))) throw new Error('路径已变化，已停止删除，请刷新检查。');
      await fs.unlink(path.join(this.root, change.path));
    }
  }

  async switchBranch(name: string): Promise<void> {
    const branch = (await this.branches()).find(b => b.name === name);
    if (!branch) throw new Error('分支已变化，请刷新后重试。');
    if (branch.remote) await this.run(['switch', '--track', name]);
    else await this.run(['switch', '--', name]);
  }

  async createBranch(name: string, start?: string): Promise<void> {
    await this.run(['check-ref-format', '--branch', name]);
    if (start && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(start)) throw new Error('无效的起始提交。');
    await this.run(['switch', '-c', name, ...(start ? [start] : [])]);
  }

  async deleteBranch(name: string): Promise<void> {
    const branch = (await this.branches()).find(b => b.name === name && !b.remote && !b.current);
    if (!branch) throw new Error('只能删除非当前的本地分支。');
    await this.run(['branch', '-d', '--', name]);
  }

  async mergeBranch(name: string): Promise<void> {
    if (!(await this.branches()).some(b => b.name === name)) throw new Error('分支不存在。');
    if (parseStatus(await this.run(['status', '--porcelain=v1', '-z'])).length) throw new Error('请先提交或 Stash 工作区更改，再合并分支。');
    await this.run(['merge', '--no-edit', '--', name]);
  }

  async commitFiles(hash: string): Promise<Change[]> {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('无效提交。');
    const firstParent = (await this.run(['rev-list', '--parents', '-n', '1', hash, '--'])).trim().split(' ')[1];
    const revisions = firstParent ? [firstParent, hash] : [hash];
    const fields = (await this.run(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', ...revisions, '--'])).split('\0');
    const files = new Map<string, Change>();
    for (let i = 0; i + 1 < fields.length; i += 2) files.set(fields[i + 1], { path: fields[i + 1], index: fields[i], worktree: ' ', conflict: false });
    return [...files.values()];
  }

  async stash(): Promise<void> { await this.run(['stash', 'push', '--include-untracked', '-m', 'Project Git: saved changes']); }
  async stashes(): Promise<{ ref: string; hash: string; subject: string }[]> {
    return (await this.run(['stash', 'list', '--format=%H%x00%gd%x00%s'])).trimEnd().split('\n').filter(Boolean).map(r => {
      const [hash, ref, subject] = r.split('\0'); return { hash, ref, subject };
    });
  }
  async applyStash(hash: string): Promise<void> {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('无效的 Stash 标识，请重新选择。');
    await this.run(['stash', 'apply', hash]);
  }
}
