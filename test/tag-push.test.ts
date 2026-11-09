import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitActions } from '../src/git-actions';
import { historyFixture } from './support/repository';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await historyFixture(t), { repo, parent } = f;
  const bare = path.join(parent, 'remote.git'); await repo.run(['init', '--bare', bare]);
  await repo.run(['remote', 'add', 'company', bare]); await repo.run(['push', 'company', 'main']);
  return { ...f, bare, actions: new GitActions(repo) };
}

test('pushTag pushes only the selected annotated object despite mirror, followTags and broad push configuration', async t => {
  const { repo, actions, commit, file, initial } = await fixture(t);
  await actions.createTag('not-selected', initial, 'Do not publish');
  const next = await commit('next.txt', 'next', 'Next');
  await actions.createTag('release/v1', next, 'Release notes\n\nFull annotation');
  const tag = (await repo.run(['rev-parse', 'refs/tags/release/v1'])).trim();
  await repo.run(['config', 'remote.company.mirror', 'true']);
  await repo.run(['config', 'remote.company.push', '+refs/heads/*:refs/heads/*']);
  await repo.run(['config', 'push.followTags', 'true']);
  await fs.writeFile(file('base.txt'), 'staged'); await repo.stage(['base.txt']); await fs.writeFile(file('base.txt'), 'working');
  const index = await repo.run(['write-tree']), head = await repo.head();
  await actions.pushTag('release/v1', 'company', tag);
  assert.match(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/release/v1']), new RegExp(`^${tag}\\t`, 'm'));
  assert.match(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/release/v1^{}']), new RegExp(next));
  assert.equal(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/not-selected']), '');
  assert.match(await repo.run(['ls-remote', '--heads', 'company', 'refs/heads/main']), new RegExp(initial));
  assert.deepEqual(await repo.head(), head); assert.equal(await repo.run(['write-tree']), index);
  assert.equal(await fs.readFile(file('base.txt'), 'utf8'), 'working');
  assert.match(await repo.run(['show', '-s', '--format=%B', 'refs/tags/release/v1']), /Full annotation/);
});

test('an identical remote tag can be pushed again while a different same-name tag is never overwritten', async t => {
  const { repo, actions, initial, commit } = await fixture(t);
  await actions.createTag('v1', initial); await actions.pushTag('v1', 'company');
  await actions.pushTag('v1', 'company');
  const next = await commit('next.txt', 'next', 'Next');
  await repo.run(['tag', '-f', 'v1', next]);
  await assert.rejects(actions.pushTag('v1', 'company'), /already exists|rejected/i);
  assert.match(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/v1']), new RegExp(initial));
  assert.equal((await repo.run(['rev-parse', 'refs/tags/v1'])).trim(), next);
});

test('annotated tags on the same commit with different annotations are not silently overwritten', async t => {
  const { repo, actions, initial } = await fixture(t);
  await actions.createTag('v1', initial, 'Published annotation');
  const original = (await repo.run(['rev-parse', 'refs/tags/v1'])).trim();
  await actions.pushTag('v1', 'company');
  await repo.run(['tag', '-f', '-a', 'v1', '-m', 'Different annotation', initial]);
  await assert.rejects(actions.pushTag('v1', 'company'));
  assert.match(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/v1']), new RegExp(original));
});

test('pushTag rejects stale selections, missing tags and unknown remotes before publishing', async t => {
  const { repo, actions, initial, commit } = await fixture(t);
  await actions.createTag('v1', initial); const next = await commit('next.txt', 'next', 'Next');
  await repo.run(['tag', '-f', 'v1', next]);
  await assert.rejects(actions.pushTag('v1', 'company', initial), /标签已变化/);
  await assert.rejects(actions.pushTag('missing', 'company'), /不存在/);
  await assert.rejects(actions.pushTag('v1', '--all'), /Remote 不存在/);
  assert.equal(await repo.run(['ls-remote', '--tags', 'company']), '');
});

test('pushTag honors the chosen remote and can push literal lightweight or blob tags', async t => {
  const { repo, parent, actions, initial } = await fixture(t);
  const second = path.join(parent, 'second.git'); await repo.run(['init', '--bare', second]); await repo.run(['remote', 'add', 'second', second]);
  await actions.createTag('release/next', initial); await actions.pushTag('release/next', 'second');
  assert.match(await repo.run(['ls-remote', '--tags', 'second', 'refs/tags/release/next']), new RegExp(initial));
  assert.equal(await repo.run(['ls-remote', '--tags', 'company']), '');
  const blob = (await repo.run(['rev-parse', 'HEAD:base.txt'])).trim(); await repo.run(['tag', 'blob', blob]);
  await actions.pushTag('blob', 'second');
  assert.match(await repo.run(['ls-remote', '--tags', 'second', 'refs/tags/blob']), new RegExp(blob));
});
