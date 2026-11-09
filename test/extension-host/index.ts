import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Repository, runGit } from '../../src/git';
import { ShelfStore } from '../../src/shelf';

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'An isolated temporary workspace is required');
  const projects = ['android', 'web'];
  for (const name of projects) {
    const root = path.join(folder.uri.fsPath, name);
    await fs.mkdir(root, { recursive: true });
    await runGit(root, ['init', '-b', 'main']);
    await runGit(root, ['config', 'user.name', 'Smoke Test']);
    await runGit(root, ['config', 'user.email', 'smoke@example.invalid']);
    await runGit(root, ['config', 'commit.gpgsign', 'false']);
    await runGit(root, ['config', 'core.hooksPath', '/dev/null']);
    await fs.writeFile(path.join(root, 'file.txt'), `${name}\n`);
    await new Repository(root).commit(['file.txt'], 'initial');
  }
  const extension = vscode.extensions.getExtension<{ readonly selectedRepository: string | undefined }>('local-dev.project-git-workbench');
  assert.ok(extension, 'Extension should be registered');
  const api = await extension.activate();
  const android = path.join(folder.uri.fsPath, 'android');
  const web = path.join(folder.uri.fsPath, 'web');
  await vscode.commands.executeCommand('projectGit.openResource', vscode.Uri.file(android));
  assert.equal(api.selectedRepository, android, 'Folder context must select Android');
  await vscode.commands.executeCommand('projectGit.openResource', vscode.Uri.file(path.join(web, 'file.txt')));
  assert.equal(api.selectedRepository, web, 'File context must select Web');
  await vscode.commands.executeCommand('projectGit.refresh');
  // Content provider must serve snapshots from a selected repo, not the process cwd.
  const uri = vscode.Uri.from({ scheme: 'project-git-content', path: '/file.txt', query: JSON.stringify({ root: web, file: 'file.txt', ref: 'HEAD' }) });
  const historical = await vscode.workspace.openTextDocument(uri);
  assert.equal(historical.getText(), 'web\n');
  await vscode.commands.executeCommand('vscode.diff', uri, vscode.Uri.file(path.join(web, 'file.txt')), 'Project Git Escape test');
  const diffTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(diffTab?.input instanceof vscode.TabInputTextDiff);
  await vscode.commands.executeCommand('projectGit.closeDiff');
  assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.includes(diffTab!)), 'Close Diff must close the plugin diff tab');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(android, 'file.txt')));
  await vscode.window.showTextDocument(document);
  const regularTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  await vscode.commands.executeCommand('projectGit.closeDiff');
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, regularTab, 'Close Diff must not close a normal editor');
  const deadline = Date.now() + 5_000;
  while (api.selectedRepository !== android && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(api.selectedRepository, android, 'Opening an editor must follow its repo');
  await vscode.commands.executeCommand('projectGit.openResource', vscode.Uri.file(web));
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(android));
  await vscode.commands.executeCommand('projectGit.openFromExplorer');
  assert.equal(api.selectedRepository, android, 'Shortcut must follow the selected Explorer folder instead of the previous repository');
  // Single-file Diff must move between files only at native hunk boundaries.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const nativeFiles = ['a-nav.txt', 'b-nav.txt'];
  const baseLines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  for (const file of nativeFiles) await fs.writeFile(path.join(android, file), baseLines);
  await new Repository(android).commit(nativeFiles, 'Diff navigation base');
  for (const file of nativeFiles) {
    const lines = baseLines.split('\n'); lines[3] = 'first change'; lines[30] = 'last change';
    await fs.writeFile(path.join(android, file), lines.join('\n'));
  }
  await vscode.commands.executeCommand('projectGit.showChanges', vscode.Uri.file(path.join(android, 'a-nav.txt')));
  const expectDiffPosition = async (file: string, line: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const active = vscode.window.activeTextEditor;
      if (active?.document.uri.fsPath === path.join(android, file) && active.selection.active.line === line) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`Expected native Diff at ${file}:${line + 1}; got ${vscode.window.activeTextEditor?.document.uri.fsPath}:${(vscode.window.activeTextEditor?.selection.active.line ?? -1) + 1}`);
  };
  await expectDiffPosition('a-nav.txt', 3);
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await expectDiffPosition('a-nav.txt', 30);
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await expectDiffPosition('b-nav.txt', 3);
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await expectDiffPosition('b-nav.txt', 30);
  await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
  await expectDiffPosition('b-nav.txt', 3);
  await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
  await expectDiffPosition('a-nav.txt', 30);
  if (process.env.PROJECT_GIT_TOOLBAR_TEST === '1') {
    const signal = path.join(folder.uri.fsPath, 'toolbar-signal');
    const state = path.join(folder.uri.fsPath, 'toolbar-state.json');
    let extra = false;
    let lastSignal = '';
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const value = await fs.readFile(signal, 'utf8').catch(() => '');
      if (value === 'done') break;
      if (value !== lastSignal) {
        lastSignal = value;
        if (value === 'search') await vscode.commands.executeCommand('workbench.view.search');
        if (value === 'ordinary') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(android, 'file.txt')));
        if (value === 'reopen') await vscode.commands.executeCommand('projectGit.showChanges', vscode.Uri.file(path.join(android, 'a-nav.txt')));
      }
      const next = value === 'extra';
      if (next !== extra) { extra = next; await vscode.commands.executeCommand('setContext', 'projectGit.toolbarTestExtra', extra); }
      const active = vscode.window.activeTextEditor;
      await fs.writeFile(state, JSON.stringify({ extra, file: active?.document.uri.fsPath, line: active?.selection.active.line }));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await vscode.commands.executeCommand('setContext', 'projectGit.toolbarTestExtra', false);
  }
  const singleDiffTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(singleDiffTab?.input instanceof vscode.TabInputTextDiff, 'Exactly one native file Diff must be visible');
  assert.match(singleDiffTab?.label || '', /a-nav.txt.*1\/2/);
  await vscode.commands.executeCommand('projectGit.closeDiff');
  assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.includes(singleDiffTab!)), 'Escape command must close the current single-file Diff');
  // The same arrows also handle one-hunk added/deleted files, without stacking.
  await fs.writeFile(path.join(android, 'c-deleted.txt'), baseLines);
  await new Repository(android).commit(['c-deleted.txt'], 'tracked deletion fixture');
  await fs.unlink(path.join(android, 'c-deleted.txt'));
  await fs.writeFile(path.join(android, 'new-nav.txt'), 'one inserted line');
  await vscode.commands.executeCommand('projectGit.showChanges', vscode.Uri.file(path.join(android, 'new-nav.txt')));
  await expectDiffPosition('new-nav.txt', 0);
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await expectDiffPosition('a-nav.txt', 3);
  for (let i = 0; i < 4; i++) await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  const deletionDeadline = Date.now() + 5_000;
  while (Date.now() < deletionDeadline && !(vscode.window.activeTextEditor?.document.uri.scheme === 'project-git-content' && JSON.parse(vscode.window.activeTextEditor.document.uri.query).file === 'c-deleted.txt')) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'project-git-content');
  assert.equal(JSON.parse(vscode.window.activeTextEditor!.document.uri.query).file, 'c-deleted.txt');
  assert.equal(JSON.parse(vscode.window.activeTextEditor!.document.uri.query).ref, 'empty');
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
  await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
  await expectDiffPosition('b-nav.txt', 30);
  await vscode.commands.executeCommand('projectGit.closeDiff');

  // Once outside our Diff, the original native arrows must wrap within that
  // ordinary editor instead of entering any Project Git file queue.
  const plainLeft = vscode.Uri.file(path.join(folder.uri.fsPath, 'plain-left.txt'));
  const plainRight = vscode.Uri.file(path.join(folder.uri.fsPath, 'plain-right.txt'));
  await fs.writeFile(plainLeft.fsPath, baseLines);
  await fs.writeFile(plainRight.fsPath, baseLines.replace('line 3\n', 'changed 3\n').replace('line 30\n', 'changed 30\n'));
  await vscode.commands.executeCommand('vscode.diff', plainLeft, plainRight, 'Ordinary unrelated Diff');
  const regularDiff = vscode.window.tabGroups.activeTabGroup.activeTab;
  const plainDeadline = Date.now() + 5_000;
  while ((vscode.window.activeTextEditor?.document.uri.toString() !== plainRight.toString() || vscode.window.activeTextEditor.selection.active.line !== 3) && Date.now() < plainDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 30);
  await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 3);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, regularDiff);
  await vscode.commands.executeCommand('projectGit.closeDiff');
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, regularDiff);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  // Shelf data must survive fresh service instances and flow into panel snapshots.
  await fs.writeFile(path.join(web, 'file.txt'), 'shelved from VS Code host\n');
  const store = new ShelfStore(new Repository(web));
  const shelf = await store.shelve(['file.txt'], 'Extension host shelf');
  assert.equal(await fs.readFile(path.join(web, 'file.txt'), 'utf8'), 'web\n');
  assert.equal((await new Repository(web).snapshot()).shelves[0].id, shelf.id);
  await store.unshelve(shelf.id);
  assert.equal(await fs.readFile(path.join(web, 'file.txt'), 'utf8'), 'shelved from VS Code host\n');
  // A resource outside Git must clear the old context rather than reuse it.
  await vscode.commands.executeCommand('projectGit.openResource', folder.uri);
  assert.equal(api.selectedRepository, undefined);
  await vscode.commands.executeCommand('projectGit.open');
  assert.equal(api.selectedRepository, undefined, 'Reopening must not restore an old repo after an explicit invalid selection');
  // Exercise real VS Code disposal and recreation repeatedly.
  for (let i = 0; i < 3; i++) {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('projectGit.refresh');
    await vscode.commands.executeCommand('projectGit.open');
  }
  await vscode.commands.executeCommand('workbench.view.extension.projectGit');
  console.log('Extension host checks passed: activation, repository context, auto-follow, content provider, native Diff within-file/next-file/previous-file navigation, Escape, Shelf, close/reopen lifecycle, sidebar.');
}
