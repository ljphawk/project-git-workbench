import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Repository, runGit } from '../src/git';
import { ShelfStore } from '../src/shelf';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pg-shelf-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function init(name: string) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    const repo = new Repository(dir);
    await repo.run(['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Shelf Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['core.filemode', 'true']]) await repo.run(['config', key, value]);
    for (const file of ['a.txt', 'b.txt', 'deleted.txt']) await fs.writeFile(path.join(dir, file), `${file}\n`);
    await repo.run(['add', '.']); await repo.run(['commit', '-m', 'initial']);
    return repo;
  }
  const repo = await init('android');
  const store = new ShelfStore(repo);
  return { root, repo, store, init, file: (name: string) => path.join(repo.root, name) };
}

test('shelve and unshelve preserve selected staged/unstaged/new/deleted files and leave other repos and files intact', async t => {
  const { repo, store, init, file } = await fixture(t);
  const other = await init('web'), originalHead = (await repo.head())!.hash;
  await fs.writeFile(file('a.txt'), 'staged a\n'); await repo.stage(['a.txt']);
  await fs.writeFile(file('a.txt'), 'working a\n');
  await fs.writeFile(file('b.txt'), 'unchecked staged\n'); await repo.stage(['b.txt']);
  await fs.writeFile(file('new.txt'), 'new content\n'); await fs.unlink(file('deleted.txt'));
  const before = await repo.run(['status', '--porcelain=v1', '-z']);
  const entry = await store.shelve(['a.txt', 'new.txt', 'deleted.txt'], '需求写到一半');
  assert.equal(entry.state, 'shelved');
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(await fs.readFile(file('deleted.txt'), 'utf8'), 'deleted.txt\n');
  await assert.rejects(fs.access(file('new.txt')));
  assert.deepEqual((await repo.snapshot()).changes.map(c => c.path), ['b.txt']);
  assert.equal(await repo.run(['show', ':b.txt']), 'unchecked staged\n');
  assert.equal((await repo.head())!.hash, originalHead);
  assert.equal((await repo.stashes()).length, 0);
  assert.equal((await new ShelfStore(other).list()).length, 0);
  await store.unshelve(entry.id);
  assert.equal(await repo.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal(await repo.run(['show', ':a.txt']), 'staged a\n');
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'working a\n');
  assert.equal(await fs.readFile(file('new.txt'), 'utf8'), 'new content\n');
  await assert.rejects(fs.access(file('deleted.txt')));
  assert.ok((await store.list())[0].restoredAt, 'restoring must retain the backup');
  assert.match(await store.patch(entry.id), /working a/);
  await store.delete(entry.id); assert.equal((await store.list()).length, 0);
});

test('staged-only changes are saved even when the working file matches HEAD', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'intermediate staged version\n'); await repo.stage(['a.txt']);
  await fs.writeFile(file('a.txt'), 'a.txt\n');
  const before = await repo.run(['status', '--porcelain=v1', '-z']);
  const shelf = await store.shelve(['a.txt'], 'staged only');
  assert.equal((await repo.snapshot()).changes.length, 0);
  await store.unshelve(shelf.id);
  assert.equal(await repo.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(await repo.run(['show', ':a.txt']), 'intermediate staged version\n');
});

test('binary patches, executable bits and literal unicode/newline filenames round-trip', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('binary.bin'), Buffer.from([0, 1, 2, 3]));
  await repo.run(['add', '--', 'binary.bin']); await repo.run(['commit', '-m', 'binary']);
  const bytes = Buffer.from([0, 255, 128, 10, 13, 4]), name = '--新 [1]\n文件.bin';
  await fs.writeFile(file('binary.bin'), bytes); await fs.chmod(file('a.txt'), 0o755);
  await fs.writeFile(file(name), bytes);
  // User diff presentation settings must not make saved patches unapplicable.
  await repo.run(['config', 'color.ui', 'always']); await repo.run(['config', 'diff.noprefix', 'true']);
  const shelf = await store.shelve(['binary.bin', 'a.txt', name], 'binary');
  assert.deepEqual(await fs.readFile(file('binary.bin')), Buffer.from([0, 1, 2, 3]));
  await store.unshelve(shelf.id);
  assert.deepEqual(await fs.readFile(file('binary.bin')), bytes);
  assert.deepEqual(await fs.readFile(file(name)), bytes);
  assert.ok((await fs.stat(file('a.txt'))).mode & 0o111);
});

test('staged renames preserve their old/new names and staged/working versions', async t => {
  const { repo, store, file } = await fixture(t);
  await repo.run(['mv', 'a.txt', 'renamed.txt']);
  await fs.writeFile(file('renamed.txt'), 'after rename\n');
  const before = await repo.run(['status', '--porcelain=v1', '-z']);
  const shelf = await store.shelve(['renamed.txt'], 'rename');
  await assert.rejects(fs.access(file('renamed.txt')));
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'a.txt\n');
  await store.unshelve(shelf.id);
  assert.equal(await repo.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal(await repo.run(['show', ':renamed.txt']), 'a.txt\n');
  assert.equal(await fs.readFile(file('renamed.txt'), 'utf8'), 'after rename\n');
});

test('a working-tree conflict rejects restore atomically and retains the shelf for retry', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'shelved\n'); await fs.writeFile(file('b.txt'), 'shelved b\n');
  const shelf = await store.shelve(['a.txt', 'b.txt'], 'conflict');
  await fs.writeFile(file('a.txt'), 'new work must survive\n');
  const before = await repo.run(['status', '--porcelain=v1', '-z']);
  await assert.rejects(store.unshelve(shelf.id), /备份已保留/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'new work must survive\n');
  assert.equal(await fs.readFile(file('b.txt'), 'utf8'), 'b.txt\n');
  assert.equal(await repo.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal((await store.list()).length, 1);
  await repo.discard(['a.txt']); await store.unshelve(shelf.id);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'shelved\n');
});

test('an index conflict is checked before any working-tree patch is applied', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'shelved staged\n'); await repo.stage(['a.txt']);
  const shelf = await store.shelve(['a.txt'], 'index conflict');
  await fs.writeFile(file('a.txt'), 'new staged\n'); await repo.stage(['a.txt']);
  await fs.writeFile(file('a.txt'), 'a.txt\n');
  const index = await repo.run(['write-tree']);
  await assert.rejects(store.unshelve(shelf.id), /备份已保留/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(await repo.run(['write-tree']), index);
});

test('new file name collisions are never overwritten during restore', async t => {
  const { store, file } = await fixture(t);
  await fs.writeFile(file('new.txt'), 'shelf content\n');
  const shelf = await store.shelve(['new.txt'], 'new file');
  await fs.writeFile(file('new.txt'), 'new content\n');
  await assert.rejects(store.unshelve(shelf.id), /备份已保留/);
  assert.equal(await fs.readFile(file('new.txt'), 'utf8'), 'new content\n');
});

test('cleanup failure leaves a complete persisted backup and the real index unchanged', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'important\n'); await repo.stage(['a.txt']);
  const original = repo.run.bind(repo), index = await repo.run(['write-tree']);
  repo.run = async (args, codes, options) => {
    if (args[0] === 'restore') throw new Error('simulated checkout failure');
    return original(args, codes, options);
  };
  await assert.rejects(store.shelve(['a.txt'], 'recoverable'), /Shelf 已保存/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'important\n');
  assert.equal(await repo.run(['write-tree']), index);
  const shelves = await store.list();
  assert.equal(shelves[0].state, 'saved'); assert.match(await store.patch(shelves[0].id), /important/);
});

test('an editor save during shelving is detected before cleanup and preserves both versions', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'version to shelve\n');
  const original = repo.runBytes.bind(repo); let changed = false;
  repo.runBytes = async (args, codes, options) => {
    const result = await original(args, codes, options);
    if (!changed && args[0] === 'diff') { changed = true; await fs.writeFile(file('a.txt'), 'new editor save\n'); }
    return result;
  };
  await assert.rejects(store.shelve(['a.txt'], 'concurrent save'), /Shelf 已保存/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'new editor save\n');
  assert.match(await store.patch((await store.list())[0].id), /version to shelve/);
});

test('linked worktrees have independent shelves, and compatible branches can restore them', async t => {
  const { root, repo, store, file } = await fixture(t);
  const linked = path.join(root, 'linked'); await repo.run(['worktree', 'add', '-b', 'linked', linked]);
  await fs.writeFile(file('a.txt'), 'shelf\n'); const shelf = await store.shelve(['a.txt'], 'main worktree');
  assert.equal((await new ShelfStore(new Repository(linked)).list()).length, 0);
  await repo.createBranch('feature'); await store.unshelve(shelf.id);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'shelf\n');
});

test('foreign index locks, invalid ids and path traversal are rejected without removing data', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('a.txt'), 'keep\n');
  const index = path.resolve(repo.root, (await repo.run(['rev-parse', '--git-path', 'index'])).trim());
  await fs.writeFile(`${index}.lock`, 'another Git process');
  await assert.rejects(store.shelve(['a.txt'], 'locked'), /另一个 Git 操作/);
  assert.equal(await fs.readFile(`${index}.lock`, 'utf8'), 'another Git process');
  await fs.unlink(`${index}.lock`);
  await assert.rejects(store.shelve(['../outside'], 'invalid'), /有效/);
  await assert.rejects(store.unshelve('../outside'), /无效/);
  await assert.rejects(store.delete('../outside'), /无效/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'keep\n');
  assert.equal((await store.list()).length, 0);
});

test('a staged addition deleted from the working tree can be shelved and restored', async t => {
  const { repo, store, file } = await fixture(t);
  await fs.writeFile(file('added.txt'), 'staged version\n'); await repo.stage(['added.txt']); await fs.unlink(file('added.txt'));
  const before = await repo.run(['status', '--porcelain=v1', '-z']);
  const shelf = await store.shelve(['added.txt'], 'AD');
  assert.equal((await repo.snapshot()).changes.length, 0);
  await store.unshelve(shelf.id);
  assert.equal(await repo.run(['status', '--porcelain=v1', '-z']), before);
  assert.equal(await repo.run(['show', ':added.txt']), 'staged version\n');
  await assert.rejects(fs.access(file('added.txt')));
});

test('symbolic links are saved as links and never modify their external target files', async t => {
  const { root, repo, store, file } = await fixture(t);
  const target = path.join(root, 'external.txt'); await fs.writeFile(target, 'external content\n');
  await fs.symlink('a.txt', file('link'));
  await repo.commit(['link'], 'add link');
  await fs.unlink(file('link')); await fs.symlink(target, file('link'));
  const shelf = await store.shelve(['link'], 'symlink');
  assert.equal(await fs.readlink(file('link')), 'a.txt');
  await store.unshelve(shelf.id);
  assert.equal(await fs.readlink(file('link')), target);
  assert.equal(await fs.readFile(target, 'utf8'), 'external content\n');
});

test('Shelve does not silently include a recreated rename source when it was not selected', async t => {
  const { repo, store, file } = await fixture(t);
  await repo.run(['mv', 'a.txt', 'renamed.txt']);
  await fs.writeFile(file('a.txt'), 'independent new work\n');
  await assert.rejects(store.shelve(['renamed.txt'], 'rename'), /请一并勾选/);
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'independent new work\n');
  assert.equal((await store.list()).length, 0);
});

test('Shelf preserves non-UTF8 bytes in staged and working text patches, including deletions and new files', async t => {
  const { repo, store, file } = await fixture(t);
  const staged = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 10]); // GBK; no NUL
  const working = Buffer.from([0x63, 0x61, 0x66, 0xe9, 10]); // Latin-1; no NUL
  await fs.writeFile(file('a.txt'), staged); await repo.stage(['a.txt']);
  await fs.writeFile(file('a.txt'), working);
  await fs.writeFile(file('new.txt'), staged);
  const shelf = await store.shelve(['a.txt', 'new.txt'], 'raw bytes');
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'a.txt\n');
  await store.unshelve(shelf.id);
  assert.deepEqual(await fs.readFile(file('a.txt')), working);
  assert.deepEqual(await fs.readFile(file('new.txt')), staged);
  assert.deepEqual(execFileSync('git', ['-C', repo.root, 'show', ':a.txt']), staged);
  // Raw non-UTF8 context/deletion lines must also survive patch serialization.
  await repo.commit(['a.txt', 'new.txt'], 'non-UTF8 base');
  await fs.unlink(file('a.txt'));
  const deleted = await store.shelve(['a.txt'], 'delete raw text');
  assert.deepEqual(await fs.readFile(file('a.txt')), working);
  await store.unshelve(deleted.id);
  await assert.rejects(fs.access(file('a.txt')));
});

test('Shelf preserves racily clean staged bytes when temporary indexes are copied after an equal-size edit', async t => {
  const { repo, store, file } = await fixture(t);
  await repo.run(['config', 'core.trustctime', 'false']);
  await repo.run(['config', 'core.checkStat', 'minimal']);
  const stamp = new Date('2020-01-01T00:00:00Z');
  await fs.writeFile(file('a.txt'), 'stage\n');
  await fs.utimes(file('a.txt'), stamp, stamp);
  await repo.stage(['a.txt']);
  await fs.writeFile(file('a.txt'), 'local\n');
  await fs.utimes(file('a.txt'), stamp, stamp);
  // Force the original index to consider its stat cache racy. Merely copying
  // it with today's mtime used to disable that protection in the temporary copy.
  const index = path.resolve(repo.root, (await repo.run(['rev-parse', '--git-path', 'index'])).trim());
  await fs.utimes(index, stamp, stamp);
  const runBytes = repo.runBytes.bind(repo);
  let checkedRacyTimestamp = false;
  repo.runBytes = async (args, codes, options) => {
    if (args[0] === 'diff' && args.includes('--cached') && options?.indexFile) {
      // The cached diff must retain Git's original racy-stat boundary even
      // when the copied index file was created years later.
      assert.ok((await fs.stat(options.indexFile)).mtimeMs <= stamp.getTime());
      checkedRacyTimestamp = true;
    }
    return runBytes(args, codes, options);
  };
  const entry = await store.shelve(['a.txt'], 'racy index');
  assert.equal(checkedRacyTimestamp, true);
  const indexPatch = await fs.readFile(path.join(await store.directory(), entry.id, 'index.patch'), 'utf8');
  assert.match(indexPatch, /\+stage\n/);
  assert.doesNotMatch(indexPatch, /\+local\n/);
  await store.unshelve(entry.id);
  assert.equal(execFileSync('git', ['-C', repo.root, 'show', ':a.txt']).toString(), 'stage\n');
  assert.equal(await fs.readFile(file('a.txt'), 'utf8'), 'local\n');
});
