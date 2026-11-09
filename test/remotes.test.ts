import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteAddresses, displayRemoteUrl } from '../src/remotes';
import { historyFixture } from './support/repository';

test('remote addresses include every configured remote and distinguish fetch and multiple push URLs without network access', async t => {
  const { repo } = await historyFixture(t);
  assert.deepEqual(await remoteAddresses(repo), []);
  await repo.run(['remote', 'add', 'company', 'git@example.invalid:team/project.git']);
  await repo.run(['remote', 'add', 'mirror', 'https://mirror.invalid/project.git']);
  await repo.run(['config', '--add', 'remote.company.pushurl', 'ssh://git@push.invalid/team/project.git']);
  await repo.run(['config', '--add', 'remote.company.pushurl', 'https://backup.invalid/team/project.git']);
  const before = await repo.run(['config', '--local', '--list']), head = await repo.head(), index = await repo.run(['write-tree']);
  assert.deepEqual(await remoteAddresses(repo), [
    { remote: 'company', direction: 'Fetch', url: 'git@example.invalid:team/project.git' },
    { remote: 'company', direction: 'Push', url: 'ssh://git@push.invalid/team/project.git' },
    { remote: 'company', direction: 'Push', url: 'https://backup.invalid/team/project.git' },
    { remote: 'mirror', direction: 'Fetch', url: 'https://mirror.invalid/project.git' },
    { remote: 'mirror', direction: 'Push', url: 'https://mirror.invalid/project.git' },
  ]);
  assert.equal(await repo.run(['config', '--local', '--list']), before);
  assert.deepEqual(await repo.head(), head); assert.equal(await repo.run(['write-tree']), index);
});

test('display addresses honor Git URL rewrite rules and hide embedded HTTP credentials', async t => {
  const { repo } = await historyFixture(t);
  await repo.run(['config', 'url.https://user:password@example.invalid/.insteadOf', 'company:']);
  await repo.run(['config', 'url.ssh://git@push.invalid/.pushInsteadOf', 'company:']);
  await repo.run(['remote', 'add', 'origin', 'company:team/project.git']);
  const addresses = await remoteAddresses(repo);
  assert.equal(addresses[0].url, 'https://example.invalid/team/project.git');
  assert.equal(addresses[1].url, 'ssh://git@push.invalid/team/project.git');
  assert.doesNotMatch(JSON.stringify(addresses), /password|user:/);
  assert.equal((await repo.run(['config', '--get', 'remote.origin.url'])).trim(), 'company:team/project.git');
  assert.equal(displayRemoteUrl('https://token@host.invalid/repo.git?access_token=secret&view=read'), 'https://host.invalid/repo.git?access_token=REDACTED&view=read');
  assert.equal(displayRemoteUrl('git@host.invalid:team/project.git'), 'git@host.invalid:team/project.git');
});
