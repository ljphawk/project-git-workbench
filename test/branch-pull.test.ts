import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Repository } from '../src/git';
import { GitActions } from '../src/git-actions';
import { historyFixture } from './support/repository';

const ref = { kind: 'local' as const, name: 'local/dev' };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await historyFixture(t), { repo, parent, initial } = base;
  const bare = path.join(parent, 'remote.git'); await repo.run(['init', '--bare', bare]);
  await repo.run(['remote', 'add', 'company', bare]);
  await repo.run(['push', 'company', 'main:refs/heads/server/dev', 'main:refs/heads/main']);
  await repo.run(['fetch', 'company']);
  await repo.run(['branch', ref.name, initial]);
  await repo.run(['branch', '--set-upstream-to=company/server/dev', ref.name]);
  const writerRoot = path.join(parent, 'writer'); await repo.run(['clone', '--branch', 'server/dev', bare, writerRoot]);
  const writer = new Repository(writerRoot);
  for (const [key, value] of [['user.name', 'Writer'], ['user.email', 'writer@invalid'], ['core.hooksPath', '/dev/null'], ['commit.gpgsign', 'false']]) await writer.run(['config', key, value]);
  let sequence = 0;
  async function advance() {
    sequence++; const file = `remote${sequence}.txt`;
    await fs.writeFile(path.join(writerRoot, file), `remote ${sequence}`);
    await writer.run(['add', '--', file]); await writer.run(['commit', '-m', `Remote ${sequence}`]);
    await writer.run(['push', 'origin', 'HEAD:refs/heads/server/dev']);
    return (await writer.head())!.hash;
  }
  return { ...base, writer, writerRoot, advance, actions: new GitActions(repo) };
}

test('pulling an inactive branch uses its actual upstream and preserves current HEAD, index, dirty files and FETCH_HEAD', async t => {
  const { repo, file, advance, actions, initial } = await fixture(t);
  await fs.writeFile(file('base.txt'), 'staged\n'); await repo.stage(['base.txt']);
  await fs.writeFile(file('base.txt'), 'working\n'); await fs.writeFile(file('untracked'), 'keep');
  const before = await repo.head(), index = await repo.run(['write-tree']);
  const fetchHead = await fs.readFile(file('.git/FETCH_HEAD'));
  const remote = await advance();
  assert.deepEqual(await actions.pullBranch(ref), { branch: ref.name, status: 'fast-forward', range: { before: initial, after: remote } });
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), remote);
  assert.equal((await repo.run(['rev-parse', 'refs/remotes/company/server/dev'])).trim(), remote);
  assert.deepEqual(await repo.head(), before); assert.equal((await repo.snapshot()).branch, 'main');
  assert.equal(await repo.run(['write-tree']), index);
  assert.equal(await repo.run(['show', ':base.txt']), 'staged\n');
  assert.equal(await fs.readFile(file('base.txt'), 'utf8'), 'working\n');
  assert.equal(await fs.readFile(file('untracked'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readFile(file('.git/FETCH_HEAD')), fetchHead);
  assert.equal(await repo.run(['for-each-ref', '--format=%(refname)', 'refs/project-git/pull/']), '');
});

test('an updated inactive branch can then be merged into the original current branch', async t => {
  const { repo, file, advance, actions } = await fixture(t);
  const remote = await advance(); await actions.pullBranch(ref);
  await actions.merge((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), ref.name);
  assert.equal((await repo.snapshot()).branch, 'main');
  assert.equal((await repo.head())!.hash, remote);
  assert.equal(await fs.readFile(file('remote1.txt'), 'utf8'), 'remote 1');
});

test('already current and locally ahead inactive branches retain local commits without a forced rewind', async t => {
  const { repo, actions, commit, initial } = await fixture(t);
  assert.equal((await actions.pullBranch(ref)).status, 'up-to-date');
  await repo.switchBranch(ref.name); const ahead = await commit('local.txt', 'local', 'Local only'); await repo.switchBranch('main');
  assert.equal((await actions.pullBranch(ref)).status, 'local-ahead');
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), ahead);
  assert.equal((await repo.head())!.hash, initial);
});

test('divergent upstream history is fetched but does not replace local branch commits', async t => {
  const { repo, actions, advance, commit, initial } = await fixture(t);
  await repo.switchBranch(ref.name); const local = await commit('local.txt', 'local', 'Local only'); await repo.switchBranch('main');
  const remote = await advance();
  await assert.rejects(actions.pullBranch(ref), /分叉/);
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), local);
  assert.equal((await repo.run(['rev-parse', 'refs/remotes/company/server/dev'])).trim(), remote);
  assert.equal((await repo.head())!.hash, initial);
  assert.equal(await repo.run(['for-each-ref', '--format=%(refname)', 'refs/project-git/pull/']), '');
});

test('current branches, missing upstreams, multiple upstreams and other-worktree branches are refused', async t => {
  const { repo, parent, actions, initial } = await fixture(t);
  await assert.rejects(actions.pullBranch({ kind: 'local', name: 'main' }), /顶部 Pull/);
  await assert.rejects(actions.pullBranch({ kind: 'remote', name: 'company/server/dev' }), /本地分支/);
  await repo.run(['branch', 'no-upstream', initial]);
  await assert.rejects(actions.pullBranch({ kind: 'local', name: 'no-upstream' }), /上游/);
  await repo.run(['config', '--add', `branch.${ref.name}.merge`, 'refs/heads/main']);
  await assert.rejects(actions.pullBranch(ref), /唯一/);
  await repo.run(['config', '--unset-all', `branch.${ref.name}.merge`]);
  await repo.run(['config', `branch.${ref.name}.merge`, 'refs/heads/server/dev']);
  await repo.run(['worktree', 'add', path.join(parent, 'linked'), ref.name]);
  await assert.rejects(actions.pullBranch(ref), /Worktree/);
});

test('changes to the selected branch or upstream configuration during confirmation are refused', async t => {
  const { repo, actions, advance, initial } = await fixture(t);
  const plan = await actions.branchPullPlan(ref);
  await repo.run(['config', `branch.${ref.name}.merge`, 'refs/heads/main']);
  await assert.rejects(actions.pullBranch(ref, plan), /确认期间/);
  await repo.run(['config', `branch.${ref.name}.merge`, 'refs/heads/server/dev']);
  const remote = await advance(); await repo.run(['fetch', 'company']);
  await repo.run(['branch', '-f', ref.name, remote]);
  await assert.rejects(actions.pullBranch(ref, plan), /确认期间/);
  assert.equal((await repo.head())!.hash, initial);
});

test('a target checked out by another worktree during network fetch is never updated', async t => {
  const { repo, actions, advance, parent, initial } = await fixture(t);
  await advance();
  const original = repo.run.bind(repo); let checkedOut = false;
  repo.run = async (args, codes, options) => {
    const result = await original(args, codes, options);
    if (!checkedOut && args[0] === 'fetch' && args.includes('company')) {
      checkedOut = true; await original(['worktree', 'add', path.join(parent, 'linked'), ref.name]);
    }
    return result;
  };
  await assert.rejects(actions.pullBranch(ref), /Worktree/);
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), initial);
});

test('Git itself rejects an inactive target checked out immediately before its final ref update', async t => {
  const { repo, actions, advance, parent, initial } = await fixture(t);
  await advance();
  const original = repo.run.bind(repo); let checkedOut = false;
  repo.run = async (args, codes, options) => {
    if (!checkedOut && args[0] === 'fetch' && args.includes('.')) {
      checkedOut = true; await original(['worktree', 'add', path.join(parent, 'linked'), ref.name]);
    }
    return original(args, codes, options);
  };
  await assert.rejects(actions.pullBranch(ref), /checked out|检出/i);
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), initial);
});

test('explicit fetch mapping does not follow broad fetch/prune/tag settings into unrelated refs', async t => {
  const { repo, actions, advance, initial } = await fixture(t);
  const remote = await advance();
  await repo.run(['tag', '-a', 'local-only', '-m', 'Preserve', initial]);
  await repo.run(['config', 'fetch.prune', 'true']); await repo.run(['config', 'fetch.pruneTags', 'true']);
  await repo.run(['config', '--add', 'remote.company.fetch', '+refs/heads/*:refs/heads/*']);
  await actions.pullBranch(ref);
  assert.equal((await repo.head())!.hash, initial);
  assert.equal((await repo.run(['rev-parse', 'refs/tags/local-only^{commit}'])).trim(), initial);
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), remote);
});

test('local-dot upstreams fast-forward safely without switching branches', async t => {
  const { repo, commit, initial } = await historyFixture(t), actions = new GitActions(repo);
  await repo.run(['branch', 'inactive', initial]); await repo.run(['branch', '--set-upstream-to=main', 'inactive']);
  const next = await commit('next.txt', 'next', 'Next');
  assert.equal((await actions.pullBranch({ kind: 'local', name: 'inactive' })).status, 'fast-forward');
  assert.equal((await repo.run(['rev-parse', 'refs/heads/inactive'])).trim(), next);
  assert.equal((await repo.snapshot()).branch, 'main');
});

test('a force-rewritten upstream updates tracking history but never rewrites the inactive local branch', async t => {
  const { repo, writer, writerRoot, initial, actions, advance } = await fixture(t);
  const first = await advance(); await actions.pullBranch(ref);
  await writer.run(['reset', '--hard', initial]);
  await fs.writeFile(path.join(writerRoot, 'rewritten.txt'), 'alternate history');
  await writer.run(['add', '--', 'rewritten.txt']); await writer.run(['commit', '-m', 'Rewritten']);
  await writer.run(['push', '--force', 'origin', 'HEAD:refs/heads/server/dev']);
  await assert.rejects(actions.pullBranch(ref), /分叉/);
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), first);
  assert.equal((await repo.run(['rev-parse', 'refs/remotes/company/server/dev'])).trim(), (await writer.head())!.hash);
  assert.equal((await repo.head())!.hash, initial);
});

test('a deleted upstream or unsafe fetch mapping fails without moving any local branch', async t => {
  const { repo, actions, initial } = await fixture(t);
  await repo.run(['push', 'company', ':refs/heads/server/dev']);
  await assert.rejects(actions.pullBranch(ref));
  assert.equal((await repo.run(['rev-parse', 'refs/heads/local/dev'])).trim(), initial);
  assert.equal(await repo.run(['for-each-ref', '--format=%(refname)', 'refs/project-git/pull/']), '');
  await repo.run(['config', '--replace-all', 'remote.company.fetch', '+refs/heads/*:refs/heads/*']);
  await assert.rejects(actions.pullBranch(ref), /上游映射/);
  assert.equal((await repo.head())!.hash, initial);
});

test('symbolic branch or upstream aliases cannot redirect a background Pull into another local branch', async t => {
  const { repo, actions, advance, initial } = await fixture(t);
  await advance();
  await repo.run(['symbolic-ref', 'refs/remotes/company/server/dev', 'refs/heads/main']);
  await assert.rejects(actions.pullBranch(ref), /符号引用/);
  assert.equal((await repo.head())!.hash, initial);
  await repo.run(['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  await repo.run(['config', 'branch.alias.remote', 'company']);
  await repo.run(['config', 'branch.alias.merge', 'refs/heads/server/dev']);
  await assert.rejects(actions.pullBranch({ kind: 'local', name: 'alias' }), /符号引用|顶部 Pull|Worktree/);
  assert.equal((await repo.head())!.hash, initial);
});
