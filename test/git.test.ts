import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Repository, runGit, findRepository, discoverRepositories, parseStatus } from '../src/git';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-git-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function init(root: string): Promise<Repository> {
  await fs.mkdir(root, { recursive: true });
  await runGit(root, ['init', '-b', 'main']);
  const repo = new Repository(root);
  await repo.run(['config', 'user.name', 'Project Git Test']);
  await repo.run(['config', 'user.email', 'test@example.invalid']);
  await repo.run(['config', 'commit.gpgsign', 'false']);
  await repo.run(['config', 'core.hooksPath', '/dev/null']);
  return repo;
}
async function seed(repo: Repository, files = ['a.txt', 'b.txt']) {
  for (const file of files) await fs.writeFile(path.join(repo.root, file), `${file}\n`);
  await repo.run(['add', '--', ...files]);
  await repo.run(['commit', '-m', 'initial']);
}

test('selected file resolves to its closest repository, including nested repositories and worktrees', async t => {
  const dir = await fixture(t);
  const outer = await init(path.join(dir, 'android'));
  await seed(outer);
  const nested = await init(path.join(outer.root, 'tools'));
  await seed(nested);
  const web = await init(path.join(dir, 'web'));
  await seed(web);
  assert.equal(await findRepository(path.join(nested.root, 'a.txt')), nested.root);
  assert.equal(await findRepository(path.join(web.root, 'b.txt')), web.root);
  const worktree = path.join(dir, 'android-worktree');
  await outer.run(['worktree', 'add', '-b', 'work', worktree]);
  assert.equal(await findRepository(path.join(worktree, 'a.txt')), worktree);
  const found = await discoverRepositories([dir], 4);
  assert.deepEqual(found.roots, [outer.root, worktree, nested.root, web.root].sort());
  assert.equal(found.truncated, false);
});

test('commit affects only selected repository and selected files, preserving other staged changes', async t => {
  const dir = await fixture(t);
  const android = await init(path.join(dir, 'android')), web = await init(path.join(dir, 'web'));
  await seed(android); await seed(web);
  await fs.writeFile(path.join(android.root, 'a.txt'), 'selected change\n');
  await fs.writeFile(path.join(android.root, 'b.txt'), 'staged but unchecked\n');
  await android.stage(['b.txt']);
  await fs.writeFile(path.join(web.root, 'a.txt'), 'other repository\n');
  const otherHead = await web.run(['rev-parse', 'HEAD']);
  await android.commit(['a.txt'], 'selected only');
  assert.equal(await android.run(['show', 'HEAD:a.txt']), 'selected change\n');
  assert.equal(await android.run(['show', 'HEAD:b.txt']), 'b.txt\n');
  assert.equal(await android.run(['show', ':b.txt']), 'staged but unchecked\n');
  assert.equal(await web.run(['rev-parse', 'HEAD']), otherHead);
  assert.equal((await web.snapshot()).changes.length, 1);
  assert.deepEqual((await android.snapshot()).changes.map(c => c.path), ['b.txt']);
});

test('first commit and log support unicode, whitespace and newline filenames', async t => {
  const repo = await init(path.join(await fixture(t), '鸿蒙'));
  const filename = '新 文件\nname.txt';
  await fs.writeFile(path.join(repo.root, filename), 'hello\n');
  assert.equal((await repo.snapshot()).commits.length, 0);
  await repo.commit([filename], '首次提交');
  const snapshot = await repo.snapshot();
  assert.equal(snapshot.branch, 'main');
  assert.equal(snapshot.commits[0].subject, '首次提交');
  assert.equal(snapshot.commits[0].author, 'Project Git Test');
  assert.deepEqual((await repo.commitFiles(snapshot.commits[0].hash)).map(c => c.path), [filename]);
  assert.equal(snapshot.changes.length, 0);
});

test('renames commit both old and new paths without including another staged file', async t => {
  const repo = await init(await fixture(t));
  await seed(repo);
  await repo.run(['mv', 'a.txt', 'renamed 文件.txt']);
  await fs.writeFile(path.join(repo.root, 'b.txt'), 'unchecked\n');
  await repo.stage(['b.txt']);
  assert.equal((await repo.snapshot()).changes.find(c => c.path === 'renamed 文件.txt')?.originalPath, 'a.txt');
  await repo.stage(['renamed 文件.txt']);
  await repo.commit(['renamed 文件.txt'], 'rename');
  assert.deepEqual((await repo.commitFiles((await repo.snapshot()).commits[0].hash)).map(c => [c.index, c.path]), [['D', 'a.txt'], ['A', 'renamed 文件.txt']]);
  assert.equal(await repo.run(['show', 'HEAD:b.txt']), 'b.txt\n');
});

test('literal pathspecs prevent filenames being interpreted as glob patterns', async t => {
  const repo = await init(await fixture(t));
  await seed(repo, ['a[1].txt', 'a1.txt']);
  await fs.writeFile(path.join(repo.root, 'a[1].txt'), 'selected\n');
  await fs.writeFile(path.join(repo.root, 'a1.txt'), 'unselected\n');
  await repo.commit(['a[1].txt'], 'literal');
  assert.equal(await repo.run(['show', 'HEAD:a1.txt']), 'a1.txt\n');
  assert.equal(await repo.run(['show', 'HEAD:a[1].txt']), 'selected\n');
  await assert.rejects(repo.commit(['../outside'], 'invalid'), /有效/);
});

test('discard deletes selected untracked files, protects staged content and restores tracked changes', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'keep\n');
  await repo.discard(['new.txt']);
  await assert.rejects(fs.access(path.join(repo.root, 'new.txt')));
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'staged\n'); await repo.stage(['a.txt']);
  await assert.rejects(repo.discard(['a.txt']), /只能丢弃/);
  await repo.unstage(['a.txt']); await repo.discard(['a.txt']);
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'a.txt\n');
  await assert.rejects(fs.access(path.join(repo.root, 'new.txt')));
});

test('branch creation, switching, merge and safe deletion operate on the current repository', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.createBranch('feature/test');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'feature\n');
  await repo.commit(['a.txt'], 'feature change');
  await repo.switchBranch('main'); await repo.mergeBranch('feature/test');
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'feature\n');
  await repo.deleteBranch('feature/test');
  assert.deepEqual((await repo.branches()).map(b => b.name), ['main']);
  await assert.rejects(repo.deleteBranch('main'), /非当前/);
});

test('unmerged branch deletion is rejected and stash can be restored without dropping backup', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.createBranch('unmerged');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'feature\n'); await repo.commit(['a.txt'], 'feature');
  await repo.switchBranch('main');
  await assert.rejects(repo.deleteBranch('unmerged'));
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'stash content\n');
  await repo.stash(); assert.equal((await repo.snapshot()).changes.length, 0);
  const stashes = await repo.stashes(); assert.equal(stashes.length, 1);
  await repo.applyStash(stashes[0].hash);
  assert.equal(await fs.readFile(path.join(repo.root, 'new.txt'), 'utf8'), 'stash content\n');
  assert.equal((await repo.stashes()).length, 1);
});

test('push, fetch and fast-forward pull use only the bound repository and remote', async t => {
  const dir = await fixture(t), remote = path.join(dir, 'remote.git');
  await fs.mkdir(remote); await runGit(remote, ['init', '--bare', '-b', 'main']);
  const repo = await init(path.join(dir, 'android')); await seed(repo);
  await repo.run(['remote', 'add', 'origin', remote]); await repo.run(['push', '-u', 'origin', 'main']);
  const peer = await init(path.join(dir, 'peer'));
  await peer.run(['remote', 'add', 'origin', remote]); await peer.run(['pull', '--ff-only', 'origin', 'main']);
  await fs.writeFile(path.join(peer.root, 'a.txt'), 'remote change\n');
  await peer.commit(['a.txt'], 'remote change'); await peer.run(['push', 'origin', 'main']);
  await repo.run(['fetch', '--all', '--prune']);
  assert.equal((await repo.snapshot()).behind, 1);
  await repo.run(['pull', '--ff-only']);
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'remote change\n');
  assert.equal((await repo.snapshot()).behind, 0);
});

test('conflicts are identified and partial commit is rejected during a merge', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.createBranch('feature');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'feature\n'); await repo.commit(['a.txt'], 'feature');
  await repo.switchBranch('main');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'main\n'); await repo.commit(['a.txt'], 'main');
  await assert.rejects(repo.mergeBranch('feature'));
  const snapshot = await repo.snapshot();
  assert.equal(snapshot.merging, true);
  assert.equal(snapshot.changes.find(c => c.path === 'a.txt')?.conflict, true);
  await assert.rejects(repo.commit(['a.txt'], 'bad merge'), /冲突/);
});

test('porcelain parsing keeps exact paths and conflict codes', () => {
  const changes = parseStatus('R  new name\0old name\0?? --flag\0UU conflict\0 M line\nfile\0');
  assert.equal(changes[0].originalPath, 'old name');
  assert.equal(changes[1].path, '--flag');
  assert.equal(changes[2].conflict, true);
  assert.equal(changes[3].path, 'line\nfile');
});

test('a staged deletion recreated on disk has one selectable entry and commits its working contents', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.run(['rm', '--', 'a.txt']);
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'recreated\n');
  const changes = (await repo.snapshot()).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].index, 'D');
  assert.equal(changes[0].worktree, 'M');
  await repo.commit(['a.txt'], 'recreate');
  assert.equal(await repo.run(['show', 'HEAD:a.txt']), 'recreated\n');
});

test('amend includes only selected files and preserves unchecked staged changes and other repositories', async t => {
  const dir = await fixture(t), repo = await init(path.join(dir, 'android')), other = await init(path.join(dir, 'web'));
  await seed(repo); await seed(other);
  const otherHead = (await other.head())!.hash;
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'first\n'); await repo.commit(['a.txt'], 'first');
  const original = (await repo.head())!;
  const parents = await repo.run(['show', '-s', '--format=%P', 'HEAD']);
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'amended\n');
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'added in amend\n');
  await fs.writeFile(path.join(repo.root, 'b.txt'), 'unchecked\n'); await repo.stage(['b.txt']);
  await repo.commit(['a.txt', 'new.txt'], 'amended message', { amend: true, expectedHead: original.hash });
  assert.notEqual((await repo.head())!.hash, original.hash);
  assert.equal((await repo.run(['rev-list', '--count', 'HEAD'])).trim(), '2');
  assert.equal(await repo.run(['show', '-s', '--format=%P', 'HEAD']), parents);
  assert.equal(await repo.run(['show', 'HEAD:a.txt']), 'amended\n');
  assert.equal(await repo.run(['show', 'HEAD:new.txt']), 'added in amend\n');
  assert.equal(await repo.run(['show', 'HEAD:b.txt']), 'b.txt\n');
  assert.equal(await repo.run(['show', ':b.txt']), 'unchecked\n');
  assert.equal((await other.head())!.hash, otherHead);
});

test('message-only amend leaves both HEAD tree and all staged contents unchanged', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  const head = (await repo.head())!, tree = await repo.run(['rev-parse', 'HEAD^{tree}']);
  await fs.writeFile(path.join(repo.root, 'b.txt'), 'do not include\n'); await repo.stage(['b.txt']);
  const index = await repo.run(['write-tree']);
  await repo.commit([], 'New subject\n\nFull commit body', { amend: true, expectedHead: head.hash });
  assert.equal(await repo.run(['rev-parse', 'HEAD^{tree}']), tree);
  assert.equal(await repo.run(['write-tree']), index);
  assert.equal((await repo.snapshot()).head!.message, 'New subject\n\nFull commit body');
  assert.equal((await repo.run(['rev-list', '--count', 'HEAD'])).trim(), '1');
});

test('amend rejects an unborn or changed HEAD before staging any files', async t => {
  const repo = await init(await fixture(t));
  await assert.rejects(repo.commit([], 'amend', { amend: true }), /还没有提交/);
  assert.equal((await repo.snapshot()).head, null);
  await seed(repo);
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'keep untracked\n');
  await assert.rejects(repo.commit(['new.txt'], 'amend', { amend: true, expectedHead: '0'.repeat(40) }), /已变化/);
  assert.equal((await repo.snapshot()).changes[0].index, '?');
  await assert.rejects(repo.commit([], 'regular'), /有效/);
});

test('amending a merge commit preserves both parents', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.createBranch('feature');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'feature\n'); await repo.commit(['a.txt'], 'feature');
  await repo.switchBranch('main'); await repo.run(['merge', '--no-ff', '--no-edit', 'feature']);
  const parents = await repo.run(['show', '-s', '--format=%P', 'HEAD']);
  assert.equal(parents.trim().split(' ').length, 2);
  await repo.commit([], 'new merge message', { amend: true, expectedHead: (await repo.head())!.hash });
  assert.equal(await repo.run(['show', '-s', '--format=%P', 'HEAD']), parents);
});

test('staging stays in local changes with an index status, and mixed unstage preserves all working files', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'changed\n');
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'untracked\n');
  await repo.stage(['a.txt']);
  let changes = (await repo.snapshot()).changes;
  assert.equal(changes.find(c => c.path === 'a.txt')?.index, 'M');
  assert.equal(changes.find(c => c.path === 'a.txt')?.worktree, ' ');
  await repo.unstage(['a.txt', 'new.txt']);
  changes = (await repo.snapshot()).changes;
  assert.equal(changes.find(c => c.path === 'a.txt')?.index, ' ');
  assert.equal(changes.find(c => c.path === 'a.txt')?.worktree, 'M');
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(await fs.readFile(path.join(repo.root, 'new.txt'), 'utf8'), 'untracked\n');
});

for (const amend of [false, true]) {
  test(`${amend ? 'amend' : 'commit'} rejects an unchecked recreated rename source before changing HEAD or index`, async t => {
    const repo = await init(await fixture(t)); await seed(repo);
    await repo.run(['mv', 'a.txt', 'renamed.txt']);
    await fs.writeFile(path.join(repo.root, 'a.txt'), 'unchecked work\n');
    const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
    await assert.rejects(repo.commit(['renamed.txt'], 'rename', { amend, expectedHead: head }), /原路径.*勾选/);
    assert.equal((await repo.head())!.hash, head);
    assert.equal(await repo.run(['write-tree']), index);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'unchecked work\n');
    await repo.commit(['renamed.txt', 'a.txt'], 'both selected', { amend, expectedHead: head });
    assert.equal(await repo.run(['show', 'HEAD:a.txt']), 'unchecked work\n');
    assert.equal(await repo.run(['show', 'HEAD:renamed.txt']), 'a.txt\n');
  });
}

test('repository resolution preserves trailing whitespace and newline characters in real paths', async t => {
  const parent = await fixture(t);
  await init(path.join(parent, 'project'));
  for (const name of ['project ', 'project\n', 'project\r']) {
    const repo = await init(path.join(parent, name)); await seed(repo);
    assert.equal(await findRepository(path.join(repo.root, 'a.txt')), repo.root);
    const discovered = await discoverRepositories([repo.root], 1);
    assert.deepEqual(discovered.roots, [repo.root]);
  }
});

test('merge history lists only first-parent changes and keeps newly introduced files marked as added', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.createBranch('feature');
  await fs.writeFile(path.join(repo.root, 'incoming.txt'), 'feature\n'); await repo.commit(['incoming.txt'], 'incoming');
  await repo.switchBranch('main');
  await fs.writeFile(path.join(repo.root, 'b.txt'), 'main only\n'); await repo.commit(['b.txt'], 'main change');
  await repo.run(['merge', '--no-ff', '--no-commit', 'feature']);
  await fs.writeFile(path.join(repo.root, 'incoming.txt'), 'edited in merge\n');
  await repo.run(['add', 'incoming.txt']); await repo.run(['commit', '-m', 'merge']);
  const files = await repo.commitFiles((await repo.head())!.hash);
  assert.deepEqual(files.map(c => [c.path, c.index]), [['incoming.txt', 'A']]);
});

test('a chosen stash is restored even after a newer stash changes its display number', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'wanted stash\n'); await repo.stash();
  const chosen = (await repo.stashes())[0];
  await fs.writeFile(path.join(repo.root, 'b.txt'), 'new stash\n'); await repo.stash();
  await repo.applyStash(chosen.hash);
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'wanted stash\n');
  assert.equal(await fs.readFile(path.join(repo.root, 'b.txt'), 'utf8'), 'b.txt\n');
});

test('a recreated directory at a rename source cannot bring unchecked nested files into a commit', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.run(['mv', 'a.txt', 'renamed.txt']);
  await fs.mkdir(path.join(repo.root, 'a.txt'));
  await fs.writeFile(path.join(repo.root, 'a.txt', 'unchecked.txt'), 'keep out of commit\n');
  const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
  await assert.rejects(repo.commit(['renamed.txt'], 'rename only'), /原路径.*勾选/);
  assert.equal((await repo.head())!.hash, head);
  assert.equal(await repo.run(['write-tree']), index);
});

for (const directory of [false, true]) {
  test(`a case-variant ${directory ? 'directory' : 'file'} at a rename source is protected on a case-insensitive filesystem`, async t => {
    const repo = await init(await fixture(t)); await seed(repo);
    if ((await repo.run(['config', '--bool', '--get', 'core.ignorecase'], [0, 1])).trim() !== 'true') { t.skip('requires a case-insensitive filesystem'); return; }
    await repo.run(['mv', 'a.txt', 'renamed.txt']);
    const source = path.join(repo.root, 'A.TXT');
    if (directory) await fs.mkdir(source);
    await fs.writeFile(directory ? path.join(source, 'unchecked.txt') : source, 'unchecked case variant\n');
    const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
    await assert.rejects(repo.commit(['renamed.txt'], 'rename only'), /原路径.*勾选/);
    assert.equal((await repo.head())!.hash, head);
    assert.equal(await repo.run(['write-tree']), index);
  });
}

test('an ignored recreated rename source cannot bypass the checked-file commit boundary', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await repo.run(['mv', 'a.txt', 'renamed.txt']);
  await fs.writeFile(path.join(repo.root, '.git', 'info', 'exclude'), 'a.txt\n');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'ignored unchecked work\n');
  const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
  await assert.rejects(repo.commit(['renamed.txt'], 'rename only'), /原路径.*勾选/);
  assert.equal((await repo.head())!.hash, head);
  assert.equal(await repo.run(['write-tree']), index);
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'ignored unchecked work\n');
});

test('rename source protection fails closed when core.ignorecase was disabled on a case-insensitive filesystem', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  if ((await repo.run(['config', '--bool', '--get', 'core.ignorecase'], [0, 1])).trim() !== 'true') { t.skip('requires a case-insensitive filesystem'); return; }
  await repo.run(['config', 'core.ignorecase', 'false']);
  await repo.run(['mv', 'a.txt', 'renamed.txt']);
  await fs.writeFile(path.join(repo.root, 'A.TXT'), 'unchecked alias\n');
  const head = (await repo.head())!.hash;
  await assert.rejects(repo.commit(['renamed.txt'], 'rename only'), /原路径.*勾选/);
  assert.equal((await repo.head())!.hash, head);
});

test('discard removes only checked untracked leaves, preserving ignored, unchecked and other repository files', async t => {
  const root = await fixture(t), repo = await init(path.join(root, 'one')), other = await init(path.join(root, 'two'));
  await seed(repo); await seed(other);
  await fs.mkdir(path.join(repo.root, 'new'), { recursive: true });
  for (const name of ['new/selected.txt', 'new/keep.txt', 'new/a[1].txt', 'new/a1.txt', 'new/-option', 'new/换行\n文件']) await fs.writeFile(path.join(repo.root, name), name);
  await fs.writeFile(path.join(repo.root, '.gitignore'), 'new/ignored.txt\n');
  await fs.writeFile(path.join(repo.root, 'new/ignored.txt'), 'ignored');
  await fs.writeFile(path.join(other.root, 'new.txt'), 'other repo');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'tracked edit');
  const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
  await repo.discard(['new/selected.txt', 'new/a[1].txt', 'new/-option', 'new/换行\n文件', 'a.txt']);
  for (const name of ['new/selected.txt', 'new/a[1].txt', 'new/-option', 'new/换行\n文件']) await assert.rejects(fs.lstat(path.join(repo.root, name)));
  for (const name of ['new/keep.txt', 'new/a1.txt', 'new/ignored.txt', '.gitignore']) await fs.access(path.join(repo.root, name));
  assert.equal(await fs.readFile(path.join(other.root, 'new.txt'), 'utf8'), 'other repo');
  assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal((await repo.head())!.hash, head); assert.equal(await repo.run(['write-tree']), index);
  await assert.rejects(repo.discard(['new/ignored.txt']));
  await assert.rejects(repo.discard(['../two/new.txt']));
  await assert.rejects(repo.discard(['new']));
});

test('discard rejects a mixed selection with staged changes before deleting any untracked file', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'preserve');
  await fs.writeFile(path.join(repo.root, 'a.txt'), 'staged'); await repo.stage(['a.txt']);
  await assert.rejects(repo.discard(['new.txt', 'a.txt']), /取消暂存/);
  assert.equal(await fs.readFile(path.join(repo.root, 'new.txt'), 'utf8'), 'preserve');
  assert.equal(await repo.run(['show', ':a.txt']), 'staged');
});

test('discard deletes an untracked symlink without touching its external target and refuses nested repositories', async t => {
  const root = await fixture(t), repo = await init(path.join(root, 'project')); await seed(repo);
  const target = path.join(root, 'external.txt'); await fs.writeFile(target, 'external');
  await fs.symlink(target, path.join(repo.root, 'link'));
  await repo.discard(['link']);
  await assert.rejects(fs.lstat(path.join(repo.root, 'link')));
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
  const nested = await init(path.join(repo.root, 'nested')); await seed(nested);
  const entry = (await repo.snapshot()).changes.find(c => c.path.startsWith('nested'))!;
  await assert.rejects(repo.discard([entry.path]), /目录|嵌套仓库/);
  assert.equal(await fs.readFile(path.join(nested.root, 'a.txt'), 'utf8'), 'a.txt\n');
});

test('discard refuses a newly staged file after confirmation and never recursively removes a replacement directory', async t => {
  const repo = await init(await fixture(t)); await seed(repo);
  await fs.writeFile(path.join(repo.root, 'new.txt'), 'new');
  const plan = await repo.discardChanges(['new.txt']);
  await repo.stage(['new.txt']);
  await assert.rejects(repo.discard(['new.txt'], plan), /取消暂存|状态已变化/);
  await repo.unstage(['new.txt']);
  await fs.unlink(path.join(repo.root, 'new.txt')); await fs.mkdir(path.join(repo.root, 'new.txt'));
  await fs.writeFile(path.join(repo.root, 'new.txt/keep'), 'keep');
  await assert.rejects(repo.discard(['new.txt'], plan));
  assert.equal(await fs.readFile(path.join(repo.root, 'new.txt/keep'), 'utf8'), 'keep');
});

test('discard restores tracked deletions even when their parent directory was deleted', async t => {
  const repo = await init(await fixture(t)); await fs.mkdir(path.join(repo.root, 'dir'));
  await seed(repo, ['dir/file.txt']);
  await fs.rm(path.join(repo.root, 'dir'), { recursive: true });
  await repo.discard(['dir/file.txt']);
  assert.equal(await fs.readFile(path.join(repo.root, 'dir/file.txt'), 'utf8'), 'dir/file.txt\n');
});
