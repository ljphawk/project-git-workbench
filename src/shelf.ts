import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Repository } from './git';

export interface ShelfEntry {
  id: string; title: string; createdAt: string; branch: string; base: string;
  files: string[]; state: 'saved' | 'shelved'; restoredAt?: string;
}
interface Manifest extends ShelfEntry { version: 1 }

// The actual index stays locked while temporary indexes build/check changes.
// Shelf patches are durably saved BEFORE any working file is removed.
export class ShelfStore {
  constructor(private repo: Repository) {}

  private async gitPath(name: string): Promise<string> {
    const output = (await this.repo.run(['rev-parse', '--git-path', name])).trimEnd();
    return path.resolve(this.repo.root, output);
  }
  async directory(): Promise<string> { return this.gitPath('project-git-shelves'); }

  private validPath(file: unknown): file is string {
    return typeof file === 'string' && !!file && !path.isAbsolute(file) && !file.includes('\0') && !file.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git');
  }
  private checkId(id: string): void {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error('无效的 Shelf。');
  }
  private async read(id: string): Promise<{ dir: string; entry: Manifest }> {
    this.checkId(id);
    const dir = path.join(await this.directory(), id);
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('无效的 Shelf 目录。');
    const entry = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    if (entry.version !== 1 || entry.id !== id || typeof entry.title !== 'string' || !Array.isArray(entry.files) || !entry.files.length || !entry.files.every(f => this.validPath(f))) throw new Error('Shelf 数据损坏，请检查本地补丁备份。');
    return { dir, entry };
  }

  async list(): Promise<ShelfEntry[]> {
    let names: string[];
    try { names = await fs.readdir(await this.directory()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const entries: ShelfEntry[] = [];
    for (const id of names.filter(n => /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(n))) {
      // Surface damaged shelves rather than silently hiding a backup.
      entries.push((await this.read(id)).entry);
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async assertIdle(): Promise<void> {
    const changes = (await this.repo.snapshot(1)).changes;
    if (changes.some(c => c.conflict)) throw new Error('请先解决仓库冲突，再使用 Shelf。');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      try { await fs.access(await this.gitPath(name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('合并、Rebase 或其他 Git 操作进行中，请完成后再使用 Shelf。');
    }
  }

  private async fingerprint(files: string[]): Promise<string[]> {
    return Promise.all(files.map(async file => {
      const full = path.join(this.repo.root, file);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) return `link:${await fs.readlink(full)}`;
        if (!stat.isFile()) throw new Error(`Shelf 暂不支持目录或子模块：${file}`);
        return `${stat.mode & 0o111}:${createHash('sha256').update(await fs.readFile(full)).digest('hex')}`;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
    }));
  }

  private async transaction<T>(action: (tx: { dir: string; index: string; publish: () => Promise<void> }) => Promise<T>): Promise<T> {
    const directory = await this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const actualIndex = await this.gitPath('index'), lockPath = `${actualIndex}.lock`;
    let lock: FileHandle | undefined;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('仓库正在执行另一个 Git 操作，请稍后重试 Shelf。');
      throw error;
    }
    let temp = '', published = false;
    try {
      temp = await fs.mkdtemp(path.join(directory, '.transaction-'));
      const index = path.join(temp, 'index');
      const indexStat = await fs.stat(actualIndex);
      await fs.copyFile(actualIndex, index);
      // Git uses the index mtime to detect racily clean entries. A fresh copy
      // with a newer mtime can make Git reuse changed worktree bytes in a
      // cached diff while retaining the original staged blob in its header.
      // Date precision rounds down, conservatively retaining that detection.
      await fs.utimes(index, indexStat.atime, indexStat.mtime);
      const mode = indexStat.mode & 0o777;
      return await action({ dir: temp, index, publish: async () => {
        await lock!.writeFile(await fs.readFile(index));
        await lock!.chmod(mode); await lock!.sync();
        await lock!.close(); lock = undefined;
        await fs.rename(lockPath, actualIndex); published = true;
      } });
    } finally {
      if (lock) await lock.close();
      if (!published) await fs.unlink(lockPath).catch(() => {});
      if (temp) await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async shelve(paths: string[], title: string): Promise<ShelfEntry> {
    if (!title.trim()) throw new Error('请填写 Shelf 名称。');
    if (!await this.repo.head()) throw new Error('请先完成仓库的第一次提交，再使用 Shelve Changes。');
    return this.transaction(async tx => {
      await this.assertIdle();
      const head = await this.repo.head();
      if (!head) throw new Error('请先完成仓库的第一次提交，再使用 Shelve Changes。');
      const changes = await this.repo.validatePaths(paths);
      const all = (await this.repo.snapshot(1)).changes;
      for (const c of changes) if (c.originalPath && all.some(other => other.path === c.originalPath) && !paths.includes(c.originalPath)) throw new Error(`重命名的原路径另有修改，请一并勾选：${c.originalPath}`);
      const files = [...new Set(changes.flatMap(c => c.originalPath ? [c.originalPath, c.path] : [c.path]))];
      if (!files.every(f => this.validPath(f))) throw new Error('所选文件路径无效。');
      const before = await this.fingerprint(files);
      const stageInfo = await this.repo.run(['ls-files', '--stage', '-z', '--', ...files], undefined, { indexFile: tx.index });
      if (stageInfo.split('\0').some(s => s.startsWith('160000 '))) throw new Error('Shelf 暂不支持子模块改动，请进入子模块仓库操作。');

      const workingIndex = path.join(tx.dir, 'working-index');
      const options = { indexFile: workingIndex };
      await this.repo.run(['read-tree', head.hash], undefined, options);
      const tracked = new Set((await this.repo.run(['ls-files', '-z', '--', ...files], undefined, options)).split('\0').filter(Boolean));
      const workingFiles = files.filter((f, i) => tracked.has(f) || before[i] !== 'missing');
      if (workingFiles.length) await this.repo.run(['add', '-A', '--', ...workingFiles], undefined, options);
      const tree = (await this.repo.run(['write-tree'], undefined, options)).trim();
      const diffOptions = ['--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--line-prefix='];
      const workingPatch = await this.repo.runBytes(['diff', ...diffOptions, head.hash, tree, '--', ...files]);
      const indexPatch = await this.repo.runBytes(['diff', ...diffOptions, '--cached', head.hash, '--', ...files], undefined, { indexFile: tx.index });
      if (!workingPatch.length && !indexPatch.length) throw new Error('所选文件没有可搁置的改动。');
      const branch = (await this.repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim() || 'detached HEAD';
      const entry: Manifest = { version: 1, id: randomUUID(), title: title.trim(), createdAt: new Date().toISOString(), branch, base: head.hash, files, state: 'saved' };
      const dir = path.join(await this.directory(), entry.id);
      // Publish the complete backup directory in one rename before cleaning.
      const pending = path.join(tx.dir, 'shelf');
      await fs.mkdir(pending);
      const backupFiles: [string, string | Buffer][] = [['worktree.patch', workingPatch], ['index.patch', indexPatch], ['manifest.json', JSON.stringify(entry, null, 2)]];
      for (const [file, content] of backupFiles) {
        const handle = await fs.open(path.join(pending, file), 'wx', 0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      }
      await fs.rename(pending, dir);
      try {
        if (JSON.stringify(before) !== JSON.stringify(await this.fingerprint(files)) || (await this.repo.head())?.hash !== head.hash) throw new Error('保存期间文件或 HEAD 已变化，未清理工作区。');
        // Track new files only in the temporary index so restore can remove them.
        // Leave missing indexed additions present until restore handles them.
        const existing = files.filter((_, i) => before[i] !== 'missing');
        if (existing.length) await this.repo.run(['add', '--', ...existing], undefined, { indexFile: tx.index });
        if (JSON.stringify(before) !== JSON.stringify(await this.fingerprint(files))) throw new Error('文件刚刚被修改，未清理工作区。');
        await this.repo.run(['restore', `--source=${head.hash}`, '--staged', '--worktree', '--', ...files], undefined, { indexFile: tx.index });
        await tx.publish();
        entry.state = 'shelved';
        await this.writeManifest(dir, entry);
        return entry;
      } catch (error) {
        throw new Error(`Shelf 已保存，工作区清理未全部完成；请保留 Shelf 并检查文件。\n备份：${dir}\n${error instanceof Error ? error.message : error}`);
      }
    });
  }

  private async writeManifest(dir: string, entry: Manifest): Promise<void> {
    const temp = path.join(dir, `manifest-${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    await fs.rename(temp, path.join(dir, 'manifest.json'));
  }

  async unshelve(id: string): Promise<void> {
    const { dir, entry } = await this.read(id);
    try {
      await this.transaction(async tx => {
        await this.assertIdle();
        const working = path.join(dir, 'worktree.patch'), staged = path.join(dir, 'index.patch');
        const hasWorking = (await fs.stat(working)).size > 0, hasIndex = (await fs.stat(staged)).size > 0;
        const options = { indexFile: tx.index };
        // Both checks happen before any real index or working file is changed.
        if (hasWorking) await this.repo.run(['apply', '--check', '--binary', '--whitespace=nowarn', '--', working], undefined, options);
        if (hasIndex) await this.repo.run(['apply', '--cached', '--check', '--binary', '--whitespace=nowarn', '--', staged], undefined, options);
        if (hasIndex) await this.repo.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '--', staged], undefined, options);
        if (hasWorking) await this.repo.run(['apply', '--binary', '--whitespace=nowarn', '--', working], undefined, options);
        await tx.publish();
        entry.restoredAt = new Date().toISOString();
        await this.writeManifest(dir, entry);
      });
    } catch (error) {
      throw new Error(`恢复未完成，Shelf 备份已保留。请处理目标文件的冲突，或切回原分支后重试。\n${error instanceof Error ? error.message : error}`);
    }
  }

  async patch(id: string): Promise<string> {
    const { dir, entry } = await this.read(id);
    const [working, staged] = await Promise.all(['worktree.patch', 'index.patch'].map(f => fs.readFile(path.join(dir, f), 'utf8')));
    return `# Shelf: ${entry.title}\n# Branch: ${entry.branch}\n# Base: ${entry.base}\n\n# Working tree changes (relative to base)\n${working || '# No working tree changes\n'}\n# Staged changes (relative to base)\n${staged || '# No staged changes\n'}`;
  }

  async delete(id: string): Promise<void> {
    const { dir } = await this.read(id);
    await fs.rm(dir, { recursive: true });
  }
}
