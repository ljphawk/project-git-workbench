import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitActions } from '../src/git-actions';
import { HistoryService } from '../src/history';
import { historyFixture } from './support/repository';

test('branch creation pins its base, rename and annotated/lightweight tags respect namespaces', async t => {
  const { repo, initial, commit } = await historyFixture(t), actions = new GitActions(repo);
  const next = await commit('next.txt', 'next', 'Next');
  await repo.createBranch('feature/older', initial);
  assert.equal((await repo.head())?.hash, initial);
  await actions.renameBranch('feature/older', 'feature/renamed');
  assert.equal((await repo.snapshot()).branch, 'feature/renamed');
  await actions.createTag('release/v1', next, 'Release notes');
  await actions.createTag('light', initial);
  const tags = await new HistoryService(repo).tags();
  assert.equal(tags.find(tag => tag.name === 'release/v1')?.commit, next);
  assert.equal(tags.find(tag => tag.name === 'release/v1')?.annotated, true);
  await assert.rejects(actions.createTag('light', next));
  await actions.deleteTag('light');
  assert.equal((await new HistoryService(repo).tags()).some(tag => tag.name === 'light'), false);
  await assert.rejects(actions.renameBranch('missing', 'x'));
});

test('cherry-pick and revert apply to checked-out branch and refuse dirty worktrees', async t => {
  const { repo, initial, commit, file } = await historyFixture(t), actions = new GitActions(repo);
  await repo.createBranch('topic', initial);
  const target = await commit('topic.txt', 'topic', 'Topic change');
  await actions.checkout({ kind: 'local', name: 'main' });
  await fs.writeFile(file('untracked.txt'), 'do not lose');
  await assert.rejects(actions.applyCommit('cherry-pick', target), /Shelve/);
  assert.equal((await repo.head())?.hash, initial);
  await fs.unlink(file('untracked.txt'));
  await actions.applyCommit('cherry-pick', target);
  assert.equal(await fs.readFile(file('topic.txt'), 'utf8'), 'topic');
  const picked = (await repo.head())!.hash;
  await actions.applyCommit('revert', picked);
  await assert.rejects(fs.access(file('topic.txt')));
  assert.equal((await repo.snapshot()).branch, 'main');
  assert.equal((await repo.run(['rev-parse', 'topic'])).trim(), target);
});

for (const mode of ['soft', 'mixed', 'hard'] as const) test(`Reset ${mode} preserves its documented index/worktree semantics`, async t => {
  const { repo, initial, commit, file } = await historyFixture(t), actions = new GitActions(repo);
  await commit('next.txt', 'next', 'Next');
  await actions.resetTo(initial, mode);
  assert.equal((await repo.head())?.hash, initial);
  const status = await repo.run(['status', '--porcelain=v1']);
  if (mode === 'soft') assert.match(status, /^A  next.txt/m);
  if (mode === 'mixed') assert.match(status, /^\?\? next.txt/m);
  if (mode === 'hard') { assert.equal(status, ''); await assert.rejects(fs.access(file('next.txt'))); }
});

test('merge commits require an explicit valid mainline for cherry-pick and revert', async t => {
  const { repo, initial, commit } = await historyFixture(t), actions = new GitActions(repo);
  await repo.createBranch('topic', initial); await commit('topic.txt', 'topic', 'Topic');
  await actions.checkout({ kind: 'local', name: 'main' }); await commit('main.txt', 'main', 'Main');
  await repo.run(['merge', '--no-ff', '--no-edit', 'topic']);
  const merge = (await repo.head())!.hash;
  await assert.rejects(actions.applyCommit('revert', merge), /父提交/);
  await assert.rejects(actions.applyCommit('cherry-pick', merge, 3), /父提交/);
  await actions.applyCommit('revert', merge, 1);
  assert.equal((await repo.commitFiles((await repo.head())!.hash))[0].path, 'topic.txt');
});

for (const kind of ['rebase', 'cherry-pick', 'merge'] as const) test(`${kind} conflict can be detected, guarded and aborted without losing branch history`, async t => {
  const { repo, initial, commit } = await historyFixture(t), actions = new GitActions(repo);
  await repo.createBranch('topic', initial); const topic = await commit('base.txt', 'topic\n', 'Topic conflict');
  await actions.checkout({ kind: 'local', name: 'main' }); const main = await commit('base.txt', 'main\n', 'Main conflict');
  await assert.rejects(kind === 'rebase' ? actions.rebaseOnto(topic) : kind === 'cherry-pick' ? actions.applyCommit(kind, topic) : actions.merge(topic, 'topic'));
  assert.deepEqual(await actions.operation(), { type: kind, conflicts: true });
  await assert.rejects(actions.finishOperation('continue', kind), /暂存/);
  await assert.rejects(actions.createTag('blocked', main), /中止/);
  await assert.rejects(actions.finishOperation('abort', kind === 'rebase' ? 'merge' : 'rebase'), /状态已变化/);
  await actions.finishOperation('abort', kind);
  assert.equal(await actions.operation(), undefined);
  assert.equal((await repo.head())?.hash, main);
  assert.equal(await repo.run(['status', '--porcelain=v1']), '');
});

for (const kind of ['rebase', 'cherry-pick', 'merge'] as const) test(`${kind} continues after a conflict is resolved and staged`, async t => {
  const { repo, initial, commit, file } = await historyFixture(t), actions = new GitActions(repo);
  await repo.createBranch('topic', initial); const topic = await commit('base.txt', 'topic\n', 'Topic conflict');
  await actions.checkout({ kind: 'local', name: 'main' }); await commit('base.txt', 'main\n', 'Main conflict');
  await assert.rejects(kind === 'rebase' ? actions.rebaseOnto(topic) : kind === 'cherry-pick' ? actions.applyCommit(kind, topic) : actions.merge(topic, 'topic'));
  await fs.writeFile(file('base.txt'), 'resolved\n'); await repo.run(['add', '--', 'base.txt']);
  assert.deepEqual(await actions.operation(), { type: kind, conflicts: false });
  await actions.finishOperation('continue', kind);
  assert.equal(await actions.operation(), undefined);
  assert.equal((await repo.snapshot()).branch, 'main');
  assert.equal(await fs.readFile(file('base.txt'), 'utf8'), 'resolved\n');
});

test('remote checkout reuses only the matching upstream and deletion uses a lease even with mirror configuration', async t => {
  const { repo, initial, commit, parent } = await historyFixture(t), actions = new GitActions(repo);
  const bare = path.join(parent, 'remote.git'); await repo.run(['init', '--bare', bare]);
  await repo.run(['remote', 'add', 'origin', bare]);
  await repo.run(['push', 'origin', 'main', 'main:refs/heads/topic', 'main:refs/heads/keep']);
  await repo.run(['fetch', 'origin']);
  await actions.checkout({ kind: 'remote', name: 'origin/topic' });
  assert.equal((await repo.snapshot()).upstream, 'origin/topic');
  await actions.checkout({ kind: 'local', name: 'main' });
  await actions.checkout({ kind: 'remote', name: 'origin/topic' });
  await actions.checkout({ kind: 'local', name: 'main' });
  await repo.run(['config', 'branch.topic.remote', 'other']);
  await assert.rejects(actions.checkout({ kind: 'remote', name: 'origin/topic' }), /已存在/);
  await repo.run(['config', 'remote.origin.mirror', 'true']);
  await actions.deleteRemoteBranch({ kind: 'remote', name: 'origin/topic' }, initial);
  assert.equal((await repo.run(['ls-remote', '--heads', 'origin', 'topic'])).trim(), '');
  assert.match(await repo.run(['ls-remote', '--heads', 'origin', 'keep']), new RegExp(initial));
  // Advance a remote branch without updating its local tracking ref.
  const next = await commit('next.txt', 'next', 'Next');
  await repo.run(['--git-dir', bare, 'update-ref', 'refs/heads/keep', next]).catch(async () => {
    await repo.run(['-c', 'remote.origin.mirror=false', 'push', 'origin', `${next}:refs/heads/new`]);
    await repo.run(['--git-dir', bare, 'update-ref', 'refs/heads/keep', next]);
  });
  await assert.rejects(actions.deleteRemoteBranch({ kind: 'remote', name: 'origin/keep' }), /failed to push|stale info|rejected/i);
  assert.match(await repo.run(['ls-remote', '--heads', 'origin', 'keep']), new RegExp(next));
  await repo.run(['fetch', 'origin']);
  await assert.rejects(actions.deleteRemoteBranch({ kind: 'remote', name: 'origin/keep' }, initial), /已变化/);
});

test('local tag deletion refuses a tag replaced after the confirmation and accepts blob tags explicitly', async t => {
  const { repo, initial, commit } = await historyFixture(t), actions = new GitActions(repo);
  await actions.createTag('release', initial);
  const next = await commit('next.txt', 'next', 'Next');
  await repo.run(['tag', '-f', 'release', next]);
  await assert.rejects(actions.deleteTag('release', initial), /标签已变化/);
  assert.equal((await repo.run(['rev-parse', 'refs/tags/release'])).trim(), next);
  const blob = (await repo.run(['rev-parse', 'HEAD:base.txt'])).trim();
  await repo.run(['tag', 'blob', blob]);
  await actions.deleteTag('blob', blob);
  assert.equal((await new HistoryService(repo).tags()).some(tag => tag.name === 'blob'), false);
  await repo.run(['tag', '-a', 'annotated', '-m', 'Tag', next]);
  const tagHash = (await repo.run(['rev-parse', 'refs/tags/annotated'])).trim();
  await assert.rejects(new HistoryService(repo).requireCommit(tagHash), /标签对象/);
});

test('an empty cherry-pick can be explicitly skipped without changing the branch history', async t => {
  const { repo, commit } = await historyFixture(t), actions = new GitActions(repo);
  const target = await commit('next.txt', 'next', 'Already applied');
  await assert.rejects(actions.applyCommit('cherry-pick', target));
  assert.equal((await actions.operation())?.type, 'cherry-pick');
  await actions.finishOperation('skip', 'cherry-pick');
  assert.equal(await actions.operation(), undefined);
  assert.equal((await repo.head())?.hash, target);
});
