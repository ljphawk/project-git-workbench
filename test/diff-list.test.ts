import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFiles } from '../src/diff-list';
const changes = ['a.txt', 'b.txt', 'c.txt'].map(path => ({ path, index: ' ', worktree: 'M', conflict: false }));

test('multi-diff starts at the clicked file and preserves adjacent file order in both directions', () => {
  assert.deepEqual(diffFiles(changes, 'b.txt').map(c => c.path), ['b.txt', 'c.txt', 'a.txt']);
  assert.deepEqual(diffFiles(changes, 'b.txt', ['c.txt', 'b.txt', 'a.txt']).map(c => c.path), ['b.txt', 'a.txt', 'c.txt']);
});

test('multi-diff respects visible filters, excludes foreign paths and conflicts, and never duplicates entries', () => {
  const all = [...changes, { path: 'conflict', index: 'U', worktree: 'U', conflict: true }];
  assert.deepEqual(diffFiles(all, 'c.txt', ['b.txt', '../foreign', 'c.txt', 'b.txt', 'conflict']).map(c => c.path), ['c.txt', 'b.txt']);
  assert.deepEqual(diffFiles(all, 'a.txt', ['c.txt']).map(c => c.path), ['a.txt']);
  assert.throws(() => diffFiles(all, 'conflict'));
  assert.throws(() => diffFiles(all, 'missing'));
});
