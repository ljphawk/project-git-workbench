import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repository } from '../../src/git';

export async function historyFixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pg-history-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project'); await fs.mkdir(root);
  const repo = new Repository(root);
  await repo.run(['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'History Test'], ['user.email', 'history@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['core.autocrlf', 'false']]) await repo.run(['config', key, value]);
  async function commit(file: string, text: string, message: string, author = 'Alice', date = '2026-01-01T12:00:00Z'): Promise<string> {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
    await repo.run(['add', '--', file]);
    execFileSync('git', ['-C', root, 'commit', '-m', message], { env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase().replace(/[^a-z]/g, '')}@example.invalid`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe' });
    return (await repo.head())!.hash;
  }
  const initial = await commit('base.txt', 'base\n', 'Initial project');
  return { repo, parent, root, initial, commit, file: (file: string) => path.join(root, file) };
}
