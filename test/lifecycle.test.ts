import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { runInNewContext } from 'node:vm';
import { Repository } from '../src/git';
import { ShelfStore } from '../src/shelf';

// Exercise the extension's actual callbacks with VS Code's disposal contract:
// accessing panel.webview / view.webview after disposal throws synchronously.
function fixture() {
  const disposable = () => ({ dispose() {} });
  const commands = new Map<string, (...args: any[]) => any>();
  const errors: string[] = [], shown: any[] = [], copied: string[] = [], information: string[] = [], executed: { name: string; args: any[] }[] = [];
  const ui = { input: async (_options: any): Promise<string | undefined> => 'Test Shelf', pick: async (items: any[]): Promise<any> => items[0], confirm: async (_message: string, _options: any, action: string): Promise<string> => action };
  let provider: any;
  let tick: () => void = () => {};
  function surface() {
    let disposed = false;
    let failure = '', posts = 0, subscriptions = 0;
    const listeners: (() => void)[] = [];
    const messages: any[] = [];
    const webview = {
      cspSource: 'test-resource:', options: {}, html: '',
      asWebviewUri: (uri: string) => uri,
      onDidReceiveMessage: () => {
        subscriptions++;
        let released = false;
        return { dispose() { if (!released) { released = true; subscriptions--; } } };
      },
      postMessage: (message: any) => {
        messages.push(message); posts++;
        if (disposed || failure === 'sync') throw new Error('Webview is disposed');
        if (failure === 'async') return Promise.reject(new Error('Webview is disposed'));
        return Promise.resolve(true);
      },
    };
    return {
      get webview() { if (disposed) throw new Error('Webview is disposed'); return webview; },
      get visible() { if (disposed) throw new Error('Webview is disposed'); return true; },
      reveal() {}, onDidChangeVisibility: disposable,
      messages, get posts() { return posts; }, get subscriptions() { return subscriptions; },
      failPosts(mode: string) { failure = mode; },
      onDidDispose: (listener: () => void) => { listeners.push(listener); return disposable(); },
      dispose() { if (disposed) return; disposed = true; for (const listener of listeners) listener(); },
    };
  }
  const panel = surface();
  const sidebar = surface();
  const vscode = {
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    ThemeIcon: class { constructor(public id: string) {} },
    env: { clipboard: { async writeText(value: string) { copied.push(value); } } },
    TabInputTextDiff: class { constructor(public original: { scheme: string }, public modified: { scheme: string }) {} },
    StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { Active: -1 }, ProgressLocation: { Notification: 15 },
    Uri: { joinPath: (...parts: string[]) => parts.join('/'), file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }), from: (value: any) => ({ ...value, fsPath: value.path }) },
    window: {
      tabGroups: { activeTabGroup: { activeTab: undefined as any }, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable, async close(_tab: any) { return true; } },
      createTreeView: () => ({ ...disposable(), visible: true, async reveal() {} }),
      createStatusBarItem: () => ({ ...disposable(), hide() {}, show() {} }),
      onDidChangeActiveTextEditor: disposable, onDidChangeWindowState: disposable,
      registerWebviewViewProvider: (_id: string, value: any) => { provider = value; return disposable(); },
      createWebviewPanel: () => panel,
      showErrorMessage: (message: string) => { errors.push(message); },
      showInformationMessage(message: string) { information.push(message); },
      showInputBox: (options: any) => ui.input(options),
      showQuickPick: (items: any[]) => ui.pick(items),
      showWarningMessage: (message: string, options: any, action: string) => ui.confirm(message, options, action),
      withProgress: async (_options: any, task: () => Promise<void>) => task(),
      showTextDocument: async (document: any) => { shown.push(document); },
    },
    workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_key: string, fallback: any) => fallback }),
      textDocuments: [] as any[],
      openTextDocument: async (options: any) => ({ getText: () => options.content }),
      onDidSaveTextDocument: disposable, registerTextDocumentContentProvider: disposable,
    },
    commands: { registerCommand: (name: string, fn: (...args: any[]) => any) => { commands.set(name, fn); return disposable(); }, async executeCommand(name: string, ...args: any[]) { executed.push({ name, args }); } },
  };
  const subscriptions: { dispose(): void }[] = [];
  const filename = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(filename);
  const exports: any = {};
  runInNewContext(readFileSync(filename, 'utf8'), {
    exports, require: (name: string) => name === 'vscode' ? vscode : localRequire(name),
    setInterval: (callback: () => void) => { tick = callback; return 0; }, clearInterval() {},
  }, { filename });
  exports.activate({ subscriptions, extensionUri: 'extension', workspaceState: { get() {}, async update() {} } });
  return { panel, sidebar, commands, ui, vscode, errors, shown, copied, information, executed, tick: () => tick(), get provider() { return provider; }, dispose: () => subscriptions.forEach(d => d.dispose()) };
}

test('closing the editor workbench never reads the disposed panel.webview', async () => {
  const f = fixture();
  try {
    await f.commands.get('projectGit.open')!();
    assert.doesNotThrow(() => f.panel.dispose(), 'Closing a panel must not throw Webview is disposed');
    assert.equal(f.panel.subscriptions, 0, 'Disposed panel message handler must be released');
    assert.doesNotThrow(() => f.tick(), 'Refresh timer must not access a disposed panel');
    await assert.doesNotReject(async () => f.commands.get('projectGit.refresh')!());
  } finally { f.dispose(); }
});

test('disposing the sidebar never reads the disposed view.webview', async () => {
  const f = fixture();
  try {
    f.provider.resolveWebviewView(f.sidebar);
    assert.doesNotThrow(() => f.sidebar.dispose(), 'Closing a sidebar must not throw Webview is disposed');
    assert.equal(f.sidebar.subscriptions, 0, 'Disposed sidebar message handler must be released');
    assert.doesNotThrow(() => f.tick(), 'Refresh timer must not access a disposed sidebar');
    await assert.doesNotReject(async () => f.commands.get('projectGit.open')!());
  } finally { f.dispose(); }
});

for (const mode of ['sync', 'async']) {
  test(`a ${mode} send failure detaches the stale webview while other views keep receiving state`, async () => {
    const f = fixture();
    try {
      await f.commands.get('projectGit.open')!();
      f.provider.resolveWebviewView(f.sidebar);
      await new Promise(resolve => setImmediate(resolve));
      f.panel.failPosts(mode);
      await f.commands.get('projectGit.open')!();
      await new Promise(resolve => setImmediate(resolve));
      const before = f.panel.posts, sidebarBefore = f.sidebar.posts;
      await f.commands.get('projectGit.open')!();
      assert.equal(f.panel.posts, before, 'Stale webview must not receive any more messages');
      assert.equal(f.panel.subscriptions, 0);
      assert.ok(f.sidebar.posts > sidebarBefore, 'Remaining view must still update');
    } finally { f.dispose(); }
  });
}

async function shelfFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pg-shelf-controller-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repos: Repository[] = [];
  for (const name of ['android', 'web']) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    const repo = new Repository(dir);
    await repo.run(['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Controller Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await repo.run(['config', key, value]);
    await fs.writeFile(path.join(dir, 'a.txt'), 'base\n');
    await repo.commit(['a.txt'], 'initial');
    await fs.writeFile(path.join(dir, 'a.txt'), `${name} working\n`);
    repos.push(repo);
  }
  return repos;
}

test('Shelve saves selected dirty editors, blocks restoring over dirty buffers, and supports patch preview/delete', { timeout: 10_000 }, async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    const file = path.join(repo.root, 'a.txt');
    const doc = { isDirty: true, uri: { scheme: 'file', fsPath: file }, async save() { await fs.writeFile(file, 'unsaved editor content\n'); this.isDirty = false; return true; } };
    f.vscode.workspace.textDocuments.push(doc, { isDirty: true, uri: { scheme: 'file', fsPath: path.join(other.root, 'a.txt') }, async save() { throw new Error('must never save an unselected project'); } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'shelve', root: repo.root, paths: ['a.txt'] });
    assert.deepEqual(f.errors, []);
    const store = new ShelfStore(repo), shelf = (await store.list())[0];
    assert.ok(shelf); assert.match(await store.patch(shelf.id), /unsaved editor content/);
    assert.equal(await fs.readFile(file, 'utf8'), 'base\n');
    doc.isDirty = true;
    await f.provider.handle({ type: 'unshelve', root: repo.root, id: shelf.id });
    assert.match(f.errors[0], /未保存编辑/);
    assert.equal(await fs.readFile(file, 'utf8'), 'base\n');
    doc.isDirty = false;
    await f.provider.handle({ type: 'unshelve', root: repo.root, id: shelf.id });
    assert.equal(await fs.readFile(file, 'utf8'), 'unsaved editor content\n');
    assert.ok((await store.list())[0].restoredAt);
    await f.provider.handle({ type: 'shelfPatch', root: repo.root, id: shelf.id });
    assert.match(f.shown.at(-1).getText(), /unsaved editor content/);
    await f.provider.handle({ type: 'deleteShelf', root: repo.root, id: shelf.id });
    assert.equal((await store.list()).length, 0);
    assert.equal(await fs.readFile(file, 'utf8'), 'unsaved editor content\n');
  } finally { f.dispose(); }
});

test('switching projects while the Shelf name prompt is open keeps the operation bound to its original repo', { timeout: 10_000 }, async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    let resolveName!: (name: string) => void, inputShown!: () => void;
    const shown = new Promise<void>(resolve => { inputShown = resolve; });
    f.ui.input = async () => { inputShown(); return new Promise<string>(resolve => { resolveName = resolve; }); };
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    const pending = f.provider.handle({ type: 'shelve', root: repo.root, paths: ['a.txt'] });
    await shown;
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
    resolveName('Original project'); await pending;
    assert.deepEqual(f.errors, []);
    assert.equal((await new ShelfStore(repo).list()).length, 1);
    assert.equal((await new ShelfStore(other).list()).length, 0);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'base\n');
    assert.equal(await fs.readFile(path.join(other.root, 'a.txt'), 'utf8'), 'web working\n');
  } finally { f.dispose(); }
});

test('Commit saves only selected dirty editors and commits their latest contents', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    const file = path.join(repo.root, 'a.txt');
    const doc = { isDirty: true, uri: { scheme: 'file', fsPath: file }, async save() { await fs.writeFile(file, 'latest editor contents\n'); this.isDirty = false; return true; } };
    f.vscode.workspace.textDocuments.push(doc, { isDirty: true, uri: { scheme: 'file', fsPath: path.join(other.root, 'a.txt') }, async save() { throw new Error('must not save another project'); } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'commit', root: repo.root, paths: ['a.txt'], message: 'latest contents' });
    assert.deepEqual(f.errors, []);
    assert.equal(doc.isDirty, false);
    assert.equal(await repo.run(['show', 'HEAD:a.txt']), 'latest editor contents\n');
    assert.equal(await other.run(['show', 'HEAD:a.txt']), 'base\n');
  } finally { f.dispose(); }
});

test('Commit aborts without changing HEAD or index when a selected editor cannot be saved', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(repo.root, 'a.txt') }, async save() { return false; } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'commit', root: repo.root, paths: ['a.txt'], message: 'must not commit old contents' });
    assert.equal((await repo.head())!.hash, head);
    assert.equal(await repo.run(['write-tree']), index);
    assert.match(f.errors[0], /保存/);
  } finally { f.dispose(); }
});

test('message-only Amend never saves or includes unchecked dirty editors', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(repo.root, 'a.txt') }, async save() { throw new Error('must not save an unchecked file'); } });
    const head = (await repo.head())!.hash;
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'commit', root: repo.root, paths: [], message: 'message only', amend: true, expectedHead: head });
    assert.deepEqual(f.errors, []);
    assert.equal(await repo.run(['show', 'HEAD:a.txt']), 'base\n');
  } finally { f.dispose(); }
});

test('Commit rejects out-of-repository paths before saving any editor buffers', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    let saved = false;
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(other.root, 'a.txt') }, async save() { saved = true; return true; } });
    const head = (await repo.head())!.hash;
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'commit', root: repo.root, paths: [path.relative(repo.root, path.join(other.root, 'a.txt'))], message: 'invalid' });
    assert.equal(saved, false);
    assert.equal((await repo.head())!.hash, head);
    assert.match(f.errors[0], /有效/);
  } finally { f.dispose(); }
});

test('Stash picker restores its captured SHA after another stash changes the displayed numbering', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await repo.stash();
    f.ui.pick = async items => {
      await fs.writeFile(path.join(repo.root, 'a.txt'), 'a different stash\n');
      await repo.stash();
      return items[0];
    };
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'applyStash', root: repo.root });
    assert.deepEqual(f.errors, []);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
    assert.equal((await repo.stashes()).length, 2);
  } finally { f.dispose(); }
});

test('history and detail responses go only to their requesting view, including disposed-view races', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.commands.get('projectGit.open')!();
    f.provider.resolveWebviewView(f.sidebar);
    await f.provider.handle({ type: 'history', root: repo.root, requestId: 41, query: { limit: 1 } }, f.panel.webview);
    assert.equal(f.panel.messages.at(-1).type, 'history');
    assert.equal(f.panel.messages.at(-1).requestId, 41);
    assert.equal(f.sidebar.messages.filter(m => m.type === 'history').length, 0);
    await f.provider.handle({ type: 'commitDetails', root: repo.root, requestId: 42, hash: (await repo.head())!.hash }, f.sidebar.webview);
    assert.equal(f.sidebar.messages.at(-1).result.files[0].path, 'a.txt');
    assert.equal(f.panel.messages.filter(m => m.type === 'commitDetails').length, 0);
    const source = f.panel.webview;
    const original = repo.run.bind(repo);
    // The controller owns a different Repository instance; disposal still must
    // safely reject delivery to the released origin view.
    f.panel.dispose();
    await assert.doesNotReject(f.provider.handle({ type: 'history', root: repo.root, requestId: 43 }, source));
    await original(['status', '--porcelain']);
  } finally { f.dispose(); }
});

test('history operations reject stale roots and keep query failures local to the originating view', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.commands.get('projectGit.open')!();
    await f.provider.handle({ type: 'history', root: repo.root, requestId: 1, query: { path: '../outside' } }, f.panel.webview);
    assert.match(f.panel.messages.at(-1).error, /相对路径/);
    assert.deepEqual(f.errors, []);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
    await assert.rejects(f.provider.handle({ type: 'history', root: repo.root, requestId: 2 }, f.panel.webview), /目标仓库已切换/);
  } finally { f.dispose(); }
});

test('branch creation uses the selected revision even if its ref advances during the name prompt', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await repo.run(['restore', '--', 'a.txt']);
    const initial = (await repo.head())!.hash;
    await repo.run(['branch', 'topic']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.input = async () => {
      await fs.writeFile(path.join(repo.root, 'a.txt'), 'new main\n');
      await repo.commit(['a.txt'], 'next');
      await repo.run(['branch', '-f', 'topic', 'HEAD']);
      return 'created';
    };
    await f.provider.handle({ type: 'createBranch', root: repo.root, ref: { kind: 'local', name: 'topic' } });
    assert.deepEqual(f.errors, []);
    assert.equal((await repo.head())!.hash, initial);
    assert.equal((await repo.snapshot()).branch, 'created');
  } finally { f.dispose(); }
});

test('history mutations reject a changed checked-out branch after confirmation even at the same commit', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await repo.run(['restore', '--', 'a.txt']);
    const initial = (await repo.head())!.hash;
    await repo.run(['branch', 'other']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async (_message, _options, action) => { await repo.run(['switch', 'other']); return action; };
    await f.provider.handle({ type: 'resetCommit', root: repo.root, hash: initial });
    assert.match(f.errors.at(-1)!, /确认期间当前分支或 HEAD 已变化/);
    assert.equal((await repo.snapshot()).branch, 'other');
  } finally { f.dispose(); }
});

test('history mutations preserve unsaved editor buffers by requiring them to be saved first', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await repo.run(['restore', '--', 'a.txt']);
    const initial = (await repo.head())!.hash;
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(repo.root, 'a.txt') } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    for (const type of ['resetCommit', 'cherryPick', 'revertCommit', 'checkoutCommit']) {
      await f.provider.handle({ type, root: repo.root, hash: initial });
      assert.match(f.errors.at(-1)!, /未保存的编辑/);
      assert.equal((await repo.head())!.hash, initial);
      assert.equal((await repo.snapshot()).branch, 'main');
    }
  } finally { f.dispose(); }
});

test('discard confirmation stays bounded for many long paths and cancellation leaves files unchanged', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    const paths = Array.from({ length: 35 }, (_, i) => `build-logic/convention/bin/main/${'very-long-directory/'.repeat(8)}Plugin${i}.kt`);
    for (const file of paths) { await fs.mkdir(path.dirname(path.join(repo.root, file)), { recursive: true }); await fs.writeFile(path.join(repo.root, file), 'keep'); }
    let called = false;
    f.ui.confirm = async (_message, options) => {
      called = true;
      assert.match(options.detail, /35 个文件/);
      assert.ok(options.detail.length <= 800, `native dialog text is too long: ${options.detail.length}`);
      assert.ok(options.detail.split('\n').length <= 12, 'native dialog overflows vertically');
      return ''; // Cancel: never run a destructive action in this regression.
    };
    await f.provider.handle({ type: 'discard', root: repo.root, paths });
    assert.equal(called, true);
    assert.deepEqual(f.errors, []);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
  } finally { f.dispose(); }
});

test('other confirmation dialogs also bound multiline repository-controlled text', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const shelf = await new ShelfStore(repo).shelve(['a.txt'], 'Long shelf title\n'.repeat(100));
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    let called = false;
    f.ui.confirm = async (_message, options) => {
      called = true;
      assert.ok(options.detail.length <= 800);
      assert.ok(options.detail.split('\n').length <= 9);
      assert.match(options.detail, /省略/);
      return '';
    };
    await f.provider.handle({ type: 'deleteShelf', root: repo.root, id: shelf.id });
    assert.equal(called, true);
    assert.deepEqual(f.errors, []);
    assert.equal((await new ShelfStore(repo).list()).length, 1);
  } finally { f.dispose(); }
});

test('confirmed discard deletes only selected untracked files in its original repository after changing projects', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    for (const r of [repo, other]) {
      await fs.writeFile(path.join(r.root, 'new.txt'), 'new');
      await fs.writeFile(path.join(r.root, 'keep.txt'), 'keep');
    }
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
    f.ui.confirm = async (_message, options, action) => {
      assert.match(options.detail, /删除 1 个未跟踪文件/);
      assert.match(options.detail, /1 个已跟踪文件/);
      await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
      return action;
    };
    await f.provider.handle({ type: 'discard', root: repo.root, paths: ['new.txt', 'a.txt'] });
    assert.deepEqual(f.errors, []);
    await assert.rejects(fs.access(path.join(repo.root, 'new.txt')));
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'base\n');
    assert.equal(await fs.readFile(path.join(repo.root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(other.root, 'new.txt'), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(other.root, 'a.txt'), 'utf8'), 'web working\n');
    assert.equal((await repo.head())!.hash, head); assert.equal(await repo.run(['write-tree']), index);
  } finally { f.dispose(); }
});

test('discard refuses changes in selection state during confirmation before deleting any files', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await fs.writeFile(path.join(repo.root, 'new.txt'), 'new');
    await fs.writeFile(path.join(repo.root, 'keep.txt'), 'keep');
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async (_message, _options, action) => { await repo.stage(['new.txt']); return action; };
    await f.provider.handle({ type: 'discard', root: repo.root, paths: ['keep.txt', 'new.txt', 'a.txt'] });
    assert.match(f.errors.at(-1)!, /取消暂存|状态已变化/);
    assert.equal(await fs.readFile(path.join(repo.root, 'new.txt'), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(repo.root, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
  } finally { f.dispose(); }
});

test('discard protects selected unsaved editor buffers without deleting files', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const file = path.join(repo.root, 'new.txt'); await fs.writeFile(file, 'new');
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: file } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async () => { throw new Error('must not prompt with unsaved buffers'); };
    await f.provider.handle({ type: 'discard', root: repo.root, paths: ['new.txt'] });
    assert.match(f.errors.at(-1)!, /未保存编辑/);
    assert.equal(await fs.readFile(file, 'utf8'), 'new');
  } finally { f.dispose(); }
});

test('inactive branch Pull stays bound to its original repository and preserves current dirty files', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    const initial = (await repo.head())!.hash, otherInitial = (await other.head())!.hash;
    await repo.run(['branch', 'inactive', initial]); await repo.run(['branch', '--set-upstream-to=main', 'inactive']);
    await repo.commit(['a.txt'], 'advance main'); const next = (await repo.head())!.hash;
    await fs.writeFile(path.join(repo.root, 'a.txt'), 'keep working');
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    const index = await repo.run(['write-tree']);
    f.ui.confirm = async (_message, options, action) => {
      assert.match(options.detail, /inactive/); assert.match(options.detail, /上游/);
      await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
      return action;
    };
    await f.provider.handle({ type: 'pullBranch', root: repo.root, ref: { kind: 'local', name: 'inactive' } });
    assert.deepEqual(f.errors, []);
    assert.equal((await repo.run(['rev-parse', 'refs/heads/inactive'])).trim(), next);
    assert.equal((await repo.snapshot()).branch, 'main');
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'keep working');
    assert.equal(await repo.run(['write-tree']), index);
    assert.equal((await other.head())!.hash, otherInitial);
    assert.equal(await fs.readFile(path.join(other.root, 'a.txt'), 'utf8'), 'web working\n');
  } finally { f.dispose(); }
});

test('current branch Pull offers a repository-pinned review of only the newly integrated commits', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    const before = (await repo.head())!.hash;
    await repo.createBranch('incoming');
    await fs.writeFile(path.join(repo.root, 'a.txt'), 'incoming change');
    await repo.commit(['a.txt'], 'incoming change');
    const after = (await repo.head())!.hash;
    await repo.switchBranch('main');
    await repo.run(['branch', '--set-upstream-to=incoming', 'main']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });

    let offered = 0;
    f.vscode.window.showInformationMessage = (async (message: string, action?: string) => {
      if (!action) return;
      offered++;
      assert.match(message, /main.*1 条新提交/);
      assert.equal(action, '查看提交');
      assert.match(message, /incoming change/);
      await fs.writeFile(path.join(repo.root, 'a.txt'), 'later local change');
      await repo.commit(['a.txt'], 'later local change');
      await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
      return action;
    }) as typeof f.vscode.window.showInformationMessage;
    await f.provider.handle({ type: 'pull', root: repo.root });
    const review = f.panel.messages.at(-1).pullReview;
    assert.equal(review.root, repo.root);
    assert.equal(review.range.before, before);
    assert.equal(review.range.after, after);
    assert.equal(review.count, 1);
    await f.provider.handle({ type: 'history', root: repo.root, requestId: 42, query: { range: review.range } }, f.panel.webview);
    assert.deepEqual(f.panel.messages.at(-1).result.commits.map((commit: { hash: string }) => commit.hash), [after]);
    await f.provider.handle({ type: 'pull', root: repo.root });
    assert.equal(offered, 1, 'An up-to-date pull must not offer another review');
    assert.deepEqual(f.errors, []);
  } finally { f.dispose(); }
});

test('cancelling inactive branch Pull or changing upstream during its confirmation never moves its ref', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const initial = (await repo.head())!.hash;
    await repo.run(['branch', 'inactive', initial]); await repo.run(['branch', '--set-upstream-to=main', 'inactive']);
    await repo.run(['branch', 'another', initial]); await repo.commit(['a.txt'], 'advance main');
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async () => '';
    await f.provider.handle({ type: 'pullBranch', root: repo.root, ref: { kind: 'local', name: 'inactive' } });
    assert.equal((await repo.run(['rev-parse', 'refs/heads/inactive'])).trim(), initial);
    assert.deepEqual(f.errors, []);
    f.ui.confirm = async (_message, _options, action) => { await repo.run(['config', 'branch.inactive.merge', 'refs/heads/another']); return action; };
    await f.provider.handle({ type: 'pullBranch', root: repo.root, ref: { kind: 'local', name: 'inactive' } });
    assert.match(f.errors.at(-1)!, /确认期间/);
    assert.equal((await repo.run(['rev-parse', 'refs/heads/inactive'])).trim(), initial);
  } finally { f.dispose(); }
});

test('Tag push uses the chosen remote in its original repository without saving dirty editors', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    const parent = path.dirname(repo.root), company = path.join(parent, 'company.git'), backup = path.join(parent, 'backup.git');
    for (const [name, bare] of [['company', company], ['backup', backup]]) { await repo.run(['init', '--bare', bare]); await repo.run(['remote', 'add', name, bare]); }
    await repo.run(['tag', '-a', 'release/v1', '-m', 'Release', 'HEAD']);
    const tag = (await repo.run(['rev-parse', 'refs/tags/release/v1'])).trim();
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'file', fsPath: path.join(repo.root, 'a.txt') }, async save() { throw new Error('must not save editors to push a tag'); } });
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.pick = async items => { assert.ok(items.includes('company')); await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root }); return 'company'; };
    f.ui.confirm = async (_message, options, action) => { assert.match(options.detail, /release\/v1/); assert.match(options.detail, /company/); return action; };
    await f.provider.handle({ type: 'pushTag', root: repo.root, ref: { kind: 'tag', name: 'release/v1' } });
    assert.deepEqual(f.errors, []);
    assert.match(await repo.run(['ls-remote', '--tags', 'company', 'refs/tags/release/v1']), new RegExp(tag));
    assert.equal(await repo.run(['ls-remote', '--tags', 'backup']), '');
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
    assert.equal(await fs.readFile(path.join(other.root, 'a.txt'), 'utf8'), 'web working\n');
  } finally { f.dispose(); }
});

test('Tag push cancellation and a tag replaced during confirmation publish nothing', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const bare = path.join(path.dirname(repo.root), 'company.git'); await repo.run(['init', '--bare', bare]); await repo.run(['remote', 'add', 'company', bare]);
    await repo.run(['tag', '-a', 'v1', '-m', 'Original', 'HEAD']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async () => '';
    await f.provider.handle({ type: 'pushTag', root: repo.root, ref: { kind: 'tag', name: 'v1' } });
    assert.deepEqual(f.errors, []); assert.equal(await repo.run(['ls-remote', '--tags', 'company']), '');
    f.ui.confirm = async (_message, _options, action) => { await repo.run(['tag', '-f', 'v1', 'HEAD']); return action; };
    await f.provider.handle({ type: 'pushTag', root: repo.root, ref: { kind: 'tag', name: 'v1' } });
    assert.match(f.errors.at(-1)!, /标签已变化/); assert.equal(await repo.run(['ls-remote', '--tags', 'company']), '');
  } finally { f.dispose(); }
});

test('Tag push without a remote reports the missing configuration', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await repo.run(['tag', 'v1', 'HEAD']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.confirm = async () => { throw new Error('must not prompt without a remote'); };
    await f.provider.handle({ type: 'pushTag', root: repo.root, ref: { kind: 'tag', name: 'v1' } });
    assert.match(f.errors.at(-1)!, /未配置 remote/);
  } finally { f.dispose(); }
});

test('Git address picker displays and copies the original project URL after switching projects', async t => {
  const [repo, other] = await shelfFixture(t), f = fixture();
  try {
    await repo.run(['remote', 'add', 'origin', 'https://user:password@company.invalid/android.git']);
    await repo.run(['config', 'remote.origin.pushurl', 'git@push.invalid:android.git']);
    await other.run(['remote', 'add', 'origin', 'https://company.invalid/web.git']);
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.pick = async items => {
      assert.equal(items[0].description, 'https://company.invalid/android.git');
      assert.doesNotMatch(JSON.stringify(items), /password|user:/);
      await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: other.root });
      return items.find(item => item.label === 'origin · Push');
    };
    await f.provider.handle({ type: 'repoRemotes', root: repo.root });
    assert.deepEqual(f.errors, []); assert.deepEqual(f.copied, ['git@push.invalid:android.git']);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
  } finally { f.dispose(); }
});

test('Git address picker cancellation leaves the clipboard unchanged and missing remotes are explained', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    f.ui.pick = async () => { throw new Error('must not show an empty picker'); };
    await f.provider.handle({ type: 'repoRemotes', root: repo.root });
    assert.match(f.information.at(-1)!, /尚未配置/);
    await repo.run(['remote', 'add', 'origin', 'git@company.invalid:android.git']);
    f.ui.pick = async () => undefined;
    await f.provider.handle({ type: 'repoRemotes', root: repo.root });
    assert.deepEqual(f.errors, []); assert.deepEqual(f.copied, []);
  } finally { f.dispose(); }
});

test('single-file Diff retains only visible same-repo navigation entries and starts with the clicked file', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    await fs.writeFile(path.join(repo.root, 'deleted.txt'), 'delete'); await repo.commit(['deleted.txt'], 'track deletion');
    await fs.unlink(path.join(repo.root, 'deleted.txt')); await fs.writeFile(path.join(repo.root, 'new.txt'), 'new');
    const head = (await repo.head())!.hash, index = await repo.run(['write-tree']);
    const captured: any[][] = [];
    const open = f.provider.navigation.open.bind(f.provider.navigation);
    f.provider.navigation.open = async (title: string, resources: any[]) => { captured.push(resources); await open(title, resources); };
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'diff', root: repo.root, path: 'a.txt', files: ['new.txt', 'a.txt', 'deleted.txt', '../outside'] });
    const resources = captured[0];
    assert.deepEqual(resources.map((item: any) => item.name), ['a.txt', 'deleted.txt', 'new.txt']);
    assert.equal(JSON.parse(resources[0].original.query).root, repo.root);
    assert.equal(JSON.parse(resources[0].original.query).ref, head);
    assert.equal(resources[0].modified.scheme, 'file');
    assert.equal(JSON.parse(resources[1].modified.query).ref, 'empty');
    assert.equal(JSON.parse(resources[2].original.query).ref, 'empty');
    const calls = f.executed.filter(command => command.name === 'vscode.diff');
    assert.equal(calls.length, 1, 'Only the clicked file should open');
    assert.equal(calls[0].args[1].fsPath, path.join(repo.root, 'a.txt'));
    assert.equal(f.executed.some(command => command.name === 'vscode.changes'), false, 'Never open the stacked multi-file view');
    assert.equal(await repo.run(['write-tree']), index); assert.equal((await repo.head())!.hash, head);
    assert.equal(await fs.readFile(path.join(repo.root, 'a.txt'), 'utf8'), 'android working\n');
    await f.provider.handle({ type: 'diff', root: repo.root, path: 'a.txt', files: ['a.txt'] });
    assert.equal(f.executed.at(-1)!.name, 'vscode.diff', 'A one-file filtered list should retain the normal Diff');
    assert.deepEqual(f.errors, []);
  } finally { f.dispose(); }
});

test('single-file commit and revision comparisons retain exact revisions for navigation', async t => {
  const [repo] = await shelfFixture(t), f = fixture();
  try {
    const captured: any[][] = [];
    const open = f.provider.navigation.open.bind(f.provider.navigation);
    f.provider.navigation.open = async (title: string, resources: any[]) => { captured.push(resources); await open(title, resources); };
    const from = (await repo.head())!.hash;
    await fs.writeFile(path.join(repo.root, 'new.txt'), 'new'); await repo.commit(['a.txt', 'new.txt'], 'two-file commit');
    const to = (await repo.head())!.hash;
    await f.commands.get('projectGit.openResource')!({ scheme: 'file', fsPath: repo.root });
    await f.provider.handle({ type: 'diff', root: repo.root, path: 'new.txt', hash: to, files: ['a.txt', 'new.txt'] });
    const commit = captured[0];
    assert.equal(JSON.parse(commit[0].original.query).ref, 'empty'); assert.equal(JSON.parse(commit[0].modified.query).ref, to);
    assert.equal(JSON.parse(commit[1].original.query).ref, from); assert.equal(JSON.parse(commit[1].modified.query).ref, to);
    await f.provider.handle({ type: 'compareFile', root: repo.root, path: 'a.txt', from, to, files: ['new.txt', 'a.txt'] });
    const comparison = captured[1];
    assert.equal(comparison[0].name, 'a.txt');
    assert.equal(JSON.parse(comparison[0].original.query).ref, from);
    assert.equal(JSON.parse(comparison[0].modified.query).ref, to);
    assert.deepEqual(f.errors, []);
  } finally { f.dispose(); }
});
