import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { HistoryService } from '../src/history';
import { historyFixture } from './support/repository';

test('branch and tag history filters leave the checked-out branch, index and working files unchanged', async t => {
  const { repo, initial, commit, file } = await historyFixture(t);
  await repo.createBranch('feature/nested/topic'); const feature = await commit('feature.txt', 'feature\n', 'Feature commit');
  await repo.run(['tag', 'release/v1', feature]); await repo.switchBranch('main');
  await fs.writeFile(file('base.txt'), 'uncommitted\n'); await repo.stage(['base.txt']);
  const index = await repo.run(['write-tree']), head = (await repo.head())!.hash;
  const service = new HistoryService(repo);
  for (const ref of [{ kind: 'local' as const, name: 'feature/nested/topic' }, { kind: 'tag' as const, name: 'release/v1' }]) {
    assert.deepEqual((await service.query({ refs: [ref] })).commits.map(c => c.hash), [feature, initial]);
  }
  assert.equal((await repo.head())!.hash, head); assert.equal(await repo.run(['write-tree']), index);
  assert.equal(await fs.readFile(file('base.txt'), 'utf8'), 'uncommitted\n');
});

test('history filtering searches the repository rather than just the loaded page, with literal/regex/case/author/date/path support', async t => {
  const { repo, commit } = await historyFixture(t);
  const matching = await commit('src/a[1].txt', 'one', 'Fix cache [1]\n\nDetailed offline body', 'Alice', '2026-02-02T10:00:00Z');
  await commit('src/a1.txt', 'two', 'fix cache 1', 'Bob', '2026-02-03T10:00:00Z');
  await commit('new.txt', 'new', 'Newest', 'Bob', '2026-02-04T10:00:00Z');
  const service = new HistoryService(repo);
  assert.equal((await service.query({ limit: 1 })).commits[0].subject, 'Newest');
  assert.deepEqual((await service.query({ text: 'Detailed offline', author: 'Alice', path: 'src/a[1].txt', after: '2026-02-02T00:00:00Z', before: '2026-02-02T23:59:59.999Z' })).commits.map(c => c.hash), [matching]);
  assert.equal((await service.query({ text: 'FIX CACHE', matchCase: true })).commits.length, 0);
  assert.equal((await service.query({ text: 'FIX CACHE' })).commits.length, 2);
  assert.equal((await service.query({ text: 'cache [1]' })).commits.length, 1);
  assert.equal((await service.query({ text: '^fix cache [0-9]$', regex: true })).commits.length, 1);
  assert.equal((await service.query({ path: 'src/a[1].txt' })).commits.length, 1);
});

test('hash search cannot return a matching ancestor instead of the requested commit', async t => {
  const { repo, initial, commit } = await historyFixture(t);
  const latest = await commit('new.txt', 'one', 'Bob change', 'Bob');
  const service = new HistoryService(repo);
  assert.deepEqual((await service.query({ text: latest.slice(0, 10) })).commits.map(c => c.hash), [latest]);
  assert.equal((await service.query({ text: latest, author: 'Alice' })).commits.length, 0);
  await repo.createBranch('other', initial);
  assert.equal((await service.query({ refs: [{ kind: 'head' }], text: latest })).commits.length, 0);
});

test('filtered history pagination has no missing or duplicate records', async t => {
  const { repo, commit } = await historyFixture(t);
  const hashes: string[] = [];
  for (let i = 1; i <= 7; i++) hashes.unshift(await commit('file.txt', String(i), `page ${i}`, 'Alice', `2026-03-0${i}T12:00:00Z`));
  const service = new HistoryService(repo), collected: string[] = [];
  let skip = 0, hasMore = true;
  while (hasMore) {
    const page = await service.query({ text: 'page ', skip, limit: 2 });
    collected.push(...page.commits.map(c => c.hash)); skip += page.commits.length; hasMore = page.hasMore;
  }
  assert.deepEqual(collected, hashes);
});

test('incoming/outgoing comparisons and file differences use the selected branch without checking it out', async t => {
  const { repo, commit } = await historyFixture(t);
  await repo.createBranch('feature'); const feature = await commit('feature.txt', 'incoming', 'Incoming');
  await repo.switchBranch('main'); const main = await commit('main.txt', 'outgoing', 'Outgoing');
  const service = new HistoryService(repo);
  const incoming = await service.query({ compare: { ref: { kind: 'local', name: 'feature' }, direction: 'incoming' } });
  const outgoing = await service.query({ compare: { ref: { kind: 'local', name: 'feature' }, direction: 'outgoing' } });
  assert.deepEqual(incoming.commits.map(c => c.hash), [feature]); assert.deepEqual(outgoing.commits.map(c => c.hash), [main]);
  assert.equal(incoming.comparison!.incoming, 1); assert.equal(incoming.comparison!.outgoing, 1);
  assert.deepEqual(incoming.comparison!.files.map(c => [c.path, c.index]), [['feature.txt', 'A'], ['main.txt', 'D']]);
  assert.equal((await repo.head())!.hash, main);
});

test('all-history excludes stash internals and non-commit tags while tag catalog retains their identity', async t => {
  const { repo, initial, file } = await historyFixture(t);
  await repo.run(['tag', '-a', 'annotated', '-m', 'release', initial]); await repo.run(['tag', 'lightweight', initial]);
  const blob = (await repo.run(['rev-parse', 'HEAD:base.txt'])).trim(); await repo.run(['tag', 'blob-tag', blob]);
  await fs.writeFile(file('base.txt'), 'stash\n'); await repo.stash();
  const service = new HistoryService(repo);
  assert.deepEqual((await service.query()).commits.map(c => c.hash), [initial]);
  assert.equal((await service.tags()).find(tag => tag.name === 'annotated')!.annotated, true);
  assert.equal((await service.tags()).find(tag => tag.name === 'blob-tag')!.commit, undefined);
  assert.deepEqual((await repo.snapshot()).commits.map(c => c.hash), [initial]);
});

test('history details retain full commit messages and filtering validates untrusted arguments', async t => {
  const { repo, commit } = await historyFixture(t);
  const hash = await commit('file.txt', 'text', 'Subject\n\nFull message body');
  const service = new HistoryService(repo), details = await service.details(hash);
  assert.equal(details.message, 'Subject\n\nFull message body'); assert.equal(details.email, 'alice@example.invalid');
  assert.equal(details.files[0].path, 'file.txt');
  await assert.rejects(service.query({ refs: [{ kind: 'local', name: 'main~1' }] }));
  await assert.rejects(service.query({ path: '../outside' }), /相对/);
  await assert.rejects(service.query({ limit: 5000 }), /分页/);
  await assert.rejects(service.query({ text: '[', regex: true }));
  await assert.rejects(service.query({ after: 'yesterday' }), /日期/);
});

test('commit details list containing branches and HEAD without tags or symbolic remote aliases', async t => {
  const { repo, commit, initial } = await historyFixture(t);
  const hash = await commit('file.txt', 'reviewed', 'Reviewed commit');
  const tip = await commit('file.txt', 'later', 'Branch tip');
  await repo.run(['branch', 'older', initial]);
  await repo.run(['tag', 'release', hash]);
  await repo.run(['update-ref', 'refs/remotes/origin/main', tip]);
  await repo.run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  const history = new HistoryService(repo);
  assert.deepEqual((await history.details(hash)).branches, ['HEAD', 'main', 'origin/main']);
  await repo.switchBranch('older');
  assert.deepEqual((await history.details(hash)).branches, ['main', 'origin/main']);
});

test('structured history ignores display configuration and rejects normalized invalid dates', async t => {
  const { repo, initial } = await historyFixture(t), service = new HistoryService(repo);
  await repo.run(['config', 'log.showSignature', 'true']);
  await repo.run(['config', 'log.showNotes', 'true']);
  await repo.run(['config', 'color.ui', 'always']);
  await repo.run(['notes', 'add', '-m', 'Unstructured note text', initial]);
  assert.deepEqual((await service.query()).commits.map(c => c.hash), [initial]);
  assert.equal((await service.details(initial)).message, 'Initial project');
  assert.equal((await repo.head())?.message, 'Initial project');
  assert.equal((await service.query({ after: '2026-01-01T12:00:00Z', before: '2026-01-01T12:00:00.999Z' })).commits[0].hash, initial);
  await assert.rejects(service.query({ after: '2026-02-30T00:00:00Z' }), /日期/);
});
