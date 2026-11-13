import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Repository, Snapshot, discoverRepositories, findRepository, Change, runGit, parseStatus } from './git';
import { ShelfStore } from './shelf';
import { explorerSelection } from './explorer-selection';
import { HistoryService, HistoryQuery, CommitRange, GitRef, refKey } from './history';
import { GitActions, GitOperation, BranchPullResult } from './git-actions';
import { confirmationDetail, dialogLine, discardSummary } from './dialog';
import { remoteAddresses } from './remotes';
import { diffFiles } from './diff-list';
import { DiffNavigation } from './diff-navigation';
import { LocalChanges } from './local-changes';
import { imageData, imageDiffHtml, isImage } from './image-diff';

type Message = { type: string; root?: string; paths?: string[]; files?: string[]; path?: string; hash?: string; name?: string; message?: string; amend?: boolean; expectedHead?: string; id?: string; requestId?: number; query?: HistoryQuery; ref?: GitRef; from?: string; to?: string; operation?: GitOperation['type'] };

type PullReview = { id: string; branch: string; count: number; range: CommitRange; root: string };

class Workbench implements vscode.WebviewViewProvider, vscode.Disposable {
  private views = new Set<vscode.Webview>();
  private navigation = new DiffNavigation(vscode, error => this.report(error), () => this.updateDiffContext(), () => !!this.imagePanel?.active);
  private messageListeners = new Map<vscode.Webview, vscode.Disposable>();
  private disposed = false;
  private sidebar?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private imagePanel?: vscode.WebviewPanel;
  private imageRequest = 0;
  private pullReviews = new WeakMap<vscode.Webview, PullReview>();
  private repository?: Repository;
  private snapshot?: Snapshot;
  private roots = new Set<string>();
  private generation = 0;
  private selection = 0;
  private busy = false;
  private loading = false;
  private initialized = false;
  private explorerOpening?: Promise<void>;
  private error = '';
  private localChanges = new LocalChanges(vscode);
  private changesView = vscode.window.createTreeView('projectGit.localChanges', { treeDataProvider: this.localChanges, showCollapseAll: false });
  private previousChange = vscode.window.createStatusBarItem('projectGit.previousDiffChange', vscode.StatusBarAlignment.Right, -10000);
  private nextChange = vscode.window.createStatusBarItem('projectGit.nextDiffChange', vscode.StatusBarAlignment.Right, -10001);
  private sidebarRead = 0;
  private diffWasActive = false;
  private sidebarBorrowed = false;
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private timer: ReturnType<typeof setInterval>;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.status.command = 'projectGit.open';
    this.previousChange.text = '$(arrow-up) 上一处';
    this.previousChange.name = 'Project Git: 上一处修改';
    this.previousChange.command = 'projectGit.previousDiffChange';
    this.previousChange.accessibilityInformation = { label: 'Project Git: 上一处修改（跨文件）' };
    this.nextChange.text = '$(arrow-down) 下一处';
    this.nextChange.name = 'Project Git: 下一处修改';
    this.nextChange.command = 'projectGit.nextDiffChange';
    this.nextChange.accessibilityInformation = { label: 'Project Git: 下一处修改（跨文件）' };
    this.timer = setInterval(() => {
      if (!this.busy && !this.loading && (this.sidebar?.visible || this.panel?.visible || this.changesView.visible)) void this.refresh();
    }, 10_000);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        this.updateDiffContext();
        if (editor?.document.uri.scheme === 'file' && vscode.workspace.getConfiguration('projectGit').get('autoFollowEditor', true)) void this.selectResource(editor.document.uri);
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateDiffContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateDiffContext()),
      vscode.workspace.onDidSaveTextDocument(doc => { if (doc.uri.scheme === 'file') void this.refresh(); }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.refresh(); }),
      vscode.workspace.registerTextDocumentContentProvider('project-git-content', {
        provideTextDocumentContent: async uri => {
          const data = JSON.parse(uri.query) as { root: string; file: string; ref: string };
          if (!this.roots.has(data.root) || !['HEAD', ':', 'empty'].includes(data.ref) && !/^[a-f0-9]{40,64}(\^)?$/.test(data.ref)) throw new Error('无效的 Git 内容地址。');
          if (data.ref === 'empty') return '';
          if (path.isAbsolute(data.file) || data.file.split(/[\\/]/).includes('..')) throw new Error('无效路径。');
          return runGit(data.root, ['show', `${data.ref === ':' ? '' : data.ref}:${data.file}`]);
        },
      }),
    );
    this.updateDiffContext();
  }

  private activeDiffTab(): vscode.Tab | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab?.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'project-git-content' ? tab : undefined;
  }

  private updateDiffContext(): void {
    this.navigation.update();
    const active = !this.disposed && !!this.activeDiffTab();
    const enteringDiff = active && !this.diffWasActive;
    const restoreSidebar = this.diffWasActive && !active && this.sidebarBorrowed && (this.changesView.visible || this.sidebar?.visible);
    this.diffWasActive = active;
    if (!active) this.sidebarBorrowed = false;
    void vscode.commands.executeCommand('setContext', 'projectGit.diffActive', active);
    if (restoreSidebar && !this.disposed) void this.restoreSidebar().catch(error => this.report(error));
    const managed = !this.disposed && this.navigation.managed;
    void vscode.commands.executeCommand('setContext', 'projectGit.diffNavigation', managed);
    const image = this.imagePanel?.active;
    this.previousChange.tooltip = image ? '切换到上一个文件' : '上一处修改；到文件开头后切换上一个文件';
    this.nextChange.tooltip = image ? '切换到下一个文件' : '下一处修改；到文件末尾后切换下一个文件';
    for (const item of [this.previousChange, this.nextChange]) managed ? item.show() : item.hide();
    if (!this.disposed) void this.syncDiffSidebar(enteringDiff).catch(error => this.report(error));
  }

  private async restoreSidebar(): Promise<void> {
    // Let native tab/context events settle; an immediate return to a Diff must
    // keep its file list rather than execute a stale restore request.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (this.disposed || this.activeDiffTab()) return;
    const target = vscode.workspace.getConfiguration('projectGit').get<string>('afterDiffSidebar', 'explorer');
    const commands: Record<string, string> = {
      explorer: 'workbench.view.explorer', search: 'workbench.view.search',
      scm: 'workbench.view.scm', debug: 'workbench.view.debug',
      extensions: 'workbench.view.extensions', projectGit: 'workbench.view.extension.projectGit',
    };
    if (!commands[target]) return;
    await vscode.commands.executeCommand(commands[target]);
    if (this.disposed) return;
    if (this.activeDiffTab()) await this.syncDiffSidebar(true);
    else await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  private async syncDiffSidebar(reveal = false): Promise<void> {
    const input = this.activeDiffTab()?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) return;
    const data = JSON.parse(input.original.query) as { root: string; file: string };
    if (!this.roots.has(data.root)) return;
    const ticket = ++this.sidebarRead;
    if (this.localChanges.root !== data.root || reveal) {
      const changes = parseStatus(await new Repository(data.root).run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
      if (this.disposed || ticket !== this.sidebarRead || this.activeDiffTab()?.input !== input) return;
      this.localChanges.set(data.root, changes);
    }
    this.changesView.description = path.basename(data.root);
    this.changesView.message = `${path.basename(data.root)} · ${this.localChanges.items.length ? `${this.localChanges.items.length} 个更改` : '没有 Local Changes'}`;
    const file = input.modified.scheme === 'file' ? path.relative(data.root, input.modified.fsPath).split(path.sep).join('/') : JSON.parse(input.modified.query).file;
    const selected = this.localChanges.items.find(item => item.change.path === file);
    if (selected && (reveal || this.changesView.visible)) {
      this.sidebarBorrowed = true;
      try {
        await this.changesView.reveal(selected, { select: true, focus: false });
      } catch (error) {
        if (ticket === this.sidebarRead && this.activeDiffTab()?.input === input && this.localChanges.items.includes(selected)) throw error;
      }
    }
    else if (reveal) {
      this.sidebarBorrowed = true;
      await vscode.commands.executeCommand('projectGit.localChanges.focus');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  async refreshLocalChanges(): Promise<void> { await this.syncDiffSidebar(true); }

  async openLocalChange(root: string, file: string): Promise<void> {
    // A stale tree command must never silently open a file from another project.
    if (!this.roots.has(root) || this.localChanges.root !== root || !this.localChanges.items.some(item => item.change.path === file)) throw new Error('文件列表已变化，请刷新 Local Changes。');
    await this.diff(new Repository(root), file);
  }

  async navigateDiff(direction: 'previous' | 'next'): Promise<void> {
    if (!this.disposed && this.navigation.managed) await this.navigation.request(direction);
  }

  async closeDiff(): Promise<void> {
    const tab = this.activeDiffTab();
    if (tab) await vscode.window.tabGroups.close(tab);
  }

  async showChanges(uri?: vscode.Uri): Promise<void> {
    if (uri) await this.selectResource(uri);
    const repo = this.repository;
    if (!repo) throw new Error('请先在 Project Git 中选择项目。');
    const all = parseStatus(await repo.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const selected = uri?.scheme === 'file' ? path.relative(repo.root, uri.fsPath).split(path.sep).join('/') : '';
    const file = all.find(c => c.path === selected && !c.conflict) ?? all.find(c => !c.conflict);
    if (!file) { void vscode.window.showInformationMessage('当前项目没有可连续比对的更改。'); return; }
    await this.diff(repo, file.path);
  }

  get selectedRepository(): string | undefined { return this.repository?.root; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebar = view;
    const webview = view.webview;
    this.attach(webview);
    view.onDidDispose(() => {
      if (this.sidebar === view) this.sidebar = undefined;
      this.detach(webview);
    });
    view.onDidChangeVisibility(() => { if (this.sidebar === view && view.visible) void this.initialize(); });
    void this.initialize();
  }

  private attach(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const nonce = randomBytes(18).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workbench.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workbench.js'));
    const historyJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'history.js'));
    const historyCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'history.css'));
    webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${historyCss}"><title>Project Git</title></head><body><div id="app"></div><script nonce="${nonce}" src="${historyJs}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
    this.views.add(webview);
    this.messageListeners.set(webview, webview.onDidReceiveMessage((message: Message) => { void this.handle(message, webview).catch(error => this.report(error)); }));
  }

  private detach(webview: vscode.Webview): void {
    this.views.delete(webview);
    this.messageListeners.get(webview)?.dispose();
    this.messageListeners.delete(webview);
  }

  private postToViews(message: unknown): void {
    if (this.disposed) return;
    for (const webview of this.views) {
      try {
        void Promise.resolve(webview.postMessage(message)).catch(() => this.detach(webview));
      } catch {
        this.detach(webview);
      }
    }
  }

  private respond(view: vscode.Webview | undefined, message: unknown): void {
    if (!view) { this.postToViews(message); return; }
    if (this.disposed || !this.views.has(view)) return;
    try { void Promise.resolve(view.postMessage(message)).catch(() => this.detach(view)); }
    catch { this.detach(view); }
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    if (this.repository || this.initialized) { this.broadcast(); return; }
    this.initialized = true;
    const uri = vscode.window.activeTextEditor?.document.uri;
    const follow = vscode.workspace.getConfiguration('projectGit').get('autoFollowEditor', true);
    if (follow && uri?.scheme === 'file') { await this.selectResource(uri); return; }
    const last = this.context.workspaceState.get<string>('lastRepository');
    const workspaceRoots = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(f => fs.realpath(f.uri.fsPath).catch(() => f.uri.fsPath)));
    if (last && workspaceRoots.some(root => this.contains(root, last))) {
      const root = await findRepository(last);
      if (root) await this.select(root);
    }
    if (!this.repository && uri?.scheme === 'file') await this.selectResource(uri);
    this.broadcast();
  }

  private contains(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }

  async selectResource(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') return;
    this.initialized = true;
    const ticket = ++this.selection;
    const root = await findRepository(uri.fsPath);
    if (this.disposed || ticket !== this.selection) return;
    if (root) await this.select(root);
    else {
      this.repository = undefined; this.snapshot = undefined; this.error = '所选文件或目录不属于 Git 仓库，请选择一个 Git 项目。';
      this.generation++; this.loading = false; this.status.hide(); this.broadcast();
    }
  }

  private async select(root: string): Promise<void> {
    if (this.repository?.root === root) return;
    this.roots.add(root);
    this.repository = new Repository(root);
    this.snapshot = undefined;
    this.error = '';
    this.loading = false;
    await this.context.workspaceState.update('lastRepository', root);
    if (this.disposed) return;
    this.broadcast();
    await this.refresh();
  }

  async open(uri?: vscode.Uri): Promise<void> {
    if (uri) await this.selectResource(uri);
    else await this.initialize();
    if (this.disposed) return;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('projectGit.panel', 'Project Git', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { retainContextWhenHidden: true });
      const panel = this.panel;
      const webview = panel.webview;
      this.attach(webview);
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined;
        this.detach(webview);
      });
    } else this.panel.reveal();
    this.broadcast();
  }

  openFromExplorer(): Promise<void> {
    if (!this.explorerOpening) this.explorerOpening = this.openExplorerSelection().finally(() => { this.explorerOpening = undefined; });
    return this.explorerOpening;
  }

  private async openExplorerSelection(): Promise<void> {
    const raw = await explorerSelection(
      () => vscode.commands.executeCommand('copyFilePath'),
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'explorer-selection.js').fsPath,
    );
    if (this.disposed) return;
    if (!raw) throw new Error('未读取到资源管理器选择，请先选中文件或文件夹，再按 Cmd+G。');
    // Prefer one literal path, including valid filenames containing newlines.
    const literal = path.isAbsolute(raw) && await fs.stat(raw).then(() => true, () => false);
    const resources = literal ? [raw] : raw.split(/\r?\n/).filter(Boolean);
    if (!resources.length || resources.some(resource => !path.isAbsolute(resource))) throw new Error('所选路径无效，请右键目标目录选择「在 Project Git 中打开」。');
    const roots = await Promise.all(resources.map(resource => findRepository(resource)));
    if (roots.some(root => !root)) {
      // Clear the old repository rather than accidentally operating on it.
      await this.selectResource(vscode.Uri.file(resources[roots.findIndex(root => !root)]));
      await this.open(); return;
    }
    if (new Set(roots).size !== 1) throw new Error('选中项属于不同的 Git 仓库，请只选择一个项目，再按 Cmd+G。');
    await this.open(vscode.Uri.file(resources[0]));
  }

  async pick(): Promise<void> {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '查找工作区中的 Git 项目…' }, () => discoverRepositories(
      (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
      vscode.workspace.getConfiguration('projectGit').get('scanDepth', 6),
    ));
    for (const root of result.roots) this.roots.add(root);
    if (result.truncated) void vscode.window.showWarningMessage('目录扫描达到上限。可右键目标项目直接打开。');
    const choices = [...this.roots].sort().map(root => ({ label: path.basename(root), description: root, root }));
    const choice = await vscode.window.showQuickPick([...choices, { label: '$(folder-opened) 浏览其他项目…', description: '', root: '' }], { placeHolder: '选择 Git 项目（每个操作只针对所选仓库）', matchOnDescription: true });
    if (!choice) return;
    ++this.selection;
    if (choice.root) await this.select(choice.root);
    else {
      const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择 Git 项目' });
      if (folders?.[0]) await this.selectResource(folders[0]);
    }
  }

  async refresh(): Promise<void> {
    const repo = this.repository;
    if (this.disposed || !repo || this.loading || this.busy) return;
    const ticket = ++this.generation;
    this.loading = true; this.broadcast();
    try {
      const snapshot = await repo.snapshot(vscode.workspace.getConfiguration('projectGit').get('logLimit', 150));
      if (this.repository !== repo || ticket !== this.generation) return;
      this.snapshot = snapshot; this.error = '';
      if (snapshot.root === this.localChanges.root) this.localChanges.set(snapshot.root, snapshot.changes);
      this.status.text = `$(repo) ${snapshot.name} · $(git-branch) ${snapshot.branch}`;
      this.status.tooltip = `Project Git\n${snapshot.root}`; this.status.show();
    } catch (error) {
      if (this.repository === repo && ticket === this.generation) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (ticket === this.generation) { this.loading = false; this.broadcast(); }
    }
  }

  private broadcast(): void {
    const favoriteRefs = this.context.workspaceState.get<Record<string, string[]>>('favoriteRefs') ?? {};
    const state = { type: 'state', snapshot: this.snapshot, root: this.repository?.root, loading: this.loading, busy: this.busy, error: this.error, favorites: this.repository ? favoriteRefs[this.repository.root] ?? [] : [], historyPageSize: vscode.workspace.getConfiguration('projectGit').get<number>('logLimit', 150) };
    for (const view of this.views) {
      const review = this.pullReviews.get(view);
      this.respond(view, { ...state, pullReview: review?.root === state.root ? review : undefined });
    }
  }

  private report(error: unknown): void {
    if (this.disposed) return;
    this.error = error instanceof Error ? error.message : String(error);
    this.broadcast();
    void vscode.window.showErrorMessage(`Project Git: ${this.error}`);
  }

  private async confirm(repo: Repository, action: string, detail: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(`${action} · ${dialogLine(path.basename(repo.root), 40)}`, { modal: true, detail: confirmationDetail(repo.root, detail) }, action)) === action;
  }

  private async confirmAtHead(repo: Repository, action: string, detail: string): Promise<boolean> {
    const read = async () => ({ hash: (await repo.head())?.hash, branch: (await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim() || 'detached HEAD' });
    const before = await read();
    if (!before.hash) throw new Error('当前仓库还没有提交。');
    if (!await this.confirm(repo, action, `当前检出：${before.branch} · ${before.hash.slice(0, 8)}\n${detail}`)) return false;
    const after = await read();
    if (after.hash !== before.hash || after.branch !== before.branch) throw new Error('确认期间当前分支或 HEAD 已变化，请重新执行操作。');
    return true;
  }

  private async openImageDiff(repo: Repository, title: string, left?: vscode.Uri, right?: vscode.Uri): Promise<boolean> {
    if (!left && !right) throw new Error('两个版本都没有图片内容。');
    const request = ++this.imageRequest;
    const [before, after] = await Promise.all([imageData(repo, left), imageData(repo, right)]);
    if (this.disposed || request !== this.imageRequest) return false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = this.imagePanel ?? vscode.window.createWebviewPanel(
      'projectGit.imageDiff', title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [media] },
    );
    if (!this.imagePanel) {
      this.imagePanel = panel;
      const listener = panel.webview.onDidReceiveMessage(message => {
        if (message?.type === 'close') panel.dispose();
      });
      const viewState = panel.onDidChangeViewState(() => this.updateDiffContext());
      panel.onDidDispose(() => {
        if (this.imagePanel === panel) {
          this.imagePanel = undefined;
          ++this.imageRequest;
        }
        listener.dispose();
        viewState.dispose();
        this.updateDiffContext();
      });
    }
    panel.title = title;
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'image-diff.css'));
    panel.webview.html = imageDiffHtml(panel.webview.cspSource, css, randomBytes(18).toString('hex'), before, after);
    panel.reveal();
    return true;
  }

  private async openDiffFiles(repo: Repository, title: string, resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][]): Promise<void> {
    ++this.imageRequest;
    await this.navigation.open(title, resources.map(([resource, left, right]) => {
      const file = path.relative(repo.root, resource.fsPath).split(path.sep).join('/');
      return {
        name: path.basename(file),
        original: left ?? this.content(repo, file, 'empty'),
        modified: right ?? this.content(repo, file, 'empty'),
        openImage: isImage(resource.path) ? imageTitle => this.openImageDiff(repo, imageTitle, left, right) : undefined,
      };
    }));
    await this.syncDiffSidebar(true);
  }

  private async diffRevisions(repo: Repository, file: string, from: string, to: string, visible?: string[]): Promise<void> {
    const comparison = await new HistoryService(repo).compare(from, to);
    const changes = diffFiles(comparison.files, file, visible);
    await this.openDiffFiles(repo, `${from.slice(0, 8)} ↔ ${to.slice(0, 8)} · ${path.basename(repo.root)}`, changes.map(change => [vscode.Uri.file(path.join(repo.root, change.path)), change.index === 'A' ? undefined : this.content(repo, change.path, from), change.index === 'D' ? undefined : this.content(repo, change.path, to)]));
  }

  private content(repo: Repository, file: string, ref: string): vscode.Uri {
    return vscode.Uri.from({ scheme: 'project-git-content', path: `/${file}`, query: JSON.stringify({ root: repo.root, file, ref }) });
  }

  private async dirtyDocuments(repo: Repository, files: string[]): Promise<vscode.TextDocument[]> {
    const selected = new Set(files.map(file => path.join(repo.root, file)));
    const documents: vscode.TextDocument[] = [];
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const canonical = await fs.realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
      if (selected.has(canonical)) documents.push(document);
    }
    return documents;
  }

  private async saveSelectedDocuments(repo: Repository, files: string[], operation: string): Promise<void> {
    for (const document of await this.dirtyDocuments(repo, files)) {
      if (!await document.save() || document.isDirty) throw new Error(`文件未能完整保存，已取消 ${operation}：${document.uri.fsPath}`);
    }
  }

  private async diff(repo: Repository, file: string, hash?: string, visible?: string[]): Promise<void> {
    if (hash) await new HistoryService(repo).requireCommit(hash);
    const all = hash ? await repo.commitFiles(hash) : parseStatus(await repo.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const change = all.find(c => c.path === file);
    if (!change) throw new Error('文件不在此提交中。');
    if (change.conflict) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repo.root, file))); return;
    }
    const changes = diffFiles(all, file, visible);
    let resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][];
    if (hash) {
      const parents = (await repo.run(['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
      resources = changes.map(c => [vscode.Uri.file(path.join(repo.root, c.path)), c.index === 'A' || !parents.length ? undefined : this.content(repo, c.path, parents[0]), c.index === 'D' ? undefined : this.content(repo, c.path, hash)]);
    } else {
      const head = await repo.head();
      resources = changes.map(c => [vscode.Uri.file(path.join(repo.root, c.path)), !head || c.index === '?' || c.index === 'A' ? undefined : this.content(repo, c.originalPath || c.path, head.hash), c.worktree === 'D' || c.index === 'D' && c.worktree === ' ' ? undefined : vscode.Uri.file(path.join(repo.root, c.path))]);
    }
    // A staged addition deleted from disk has two empty sides. Supply one
    // explicit empty document so VS Code still has a valid diff resource.
    for (const item of resources) if (!item[1] && !item[2] && !isImage(item[0].path)) item[1] = this.content(repo, path.relative(repo.root, item[0].fsPath).split(path.sep).join('/'), 'empty');
    await this.openDiffFiles(repo, `${hash ? hash.slice(0, 8) : 'Local changes'} · ${path.basename(repo.root)}`, resources);
  }

  private async notifyPull(repo: Repository, result: BranchPullResult): Promise<void> {
    const title = `${path.basename(repo.root)} · ${result.branch}`;
    if (result.status !== 'fast-forward') {
      if (!this.disposed) void vscode.window.showInformationMessage(`${title}：${result.status === 'local-ahead' ? '本地领先上游，无需拉取，已有提交保留' : '没有新增提交'}`);
      return;
    }
    const history = new HistoryService(repo);
    const [count, preview] = await Promise.all([
      history.countRange(result.range).catch(() => undefined),
      history.query({ range: result.range, limit: 2 }).catch(() => undefined),
    ]);
    if (this.disposed) return;
    if (!count) {
      void vscode.window.showInformationMessage(`${title}：Pull 完成，${count === 0 ? '没有新增提交' : '无法读取新增提交'}`);
      return;
    }
    const action = '查看提交';
    const subjects = preview?.commits.map(commit => `${commit.hash.slice(0, 8)} ${dialogLine(commit.subject, 48)}`).join(' · ');
    const summary = subjects ? ` · ${subjects}${preview?.hasMore ? ' …' : ''}` : '';
    if (await vscode.window.showInformationMessage(`${title}：拉取到 ${count} 条新提交${summary}`, action) !== action || this.disposed) return;
    await this.open(vscode.Uri.file(repo.root));
    if (this.disposed || this.repository?.root !== repo.root || !this.panel) return;
    this.pullReviews.set(this.panel.webview, { id: randomBytes(12).toString('hex'), branch: result.branch, root: repo.root, count, range: result.range });
    this.broadcast();
  }

  private async handle(message: Message, source?: vscode.Webview): Promise<void> {
    if (this.disposed || !message || typeof message.type !== 'string') return;
    if (message.type === 'ready') { this.broadcast(); return; }
    if (message.type === 'pick') { await this.pick(); return; }
    if (message.type === 'openPanel') { await this.open(); return; }
    if (message.type === 'refresh') { await this.refresh(); return; }
    const repo = this.repository;
    if (!repo || message.root !== repo.root) throw new Error('目标仓库已切换，请在当前项目重试。');
    if (message.type === 'repoRemotes') {
      const addresses = await remoteAddresses(repo).catch(error => {
        if (this.disposed || this.repository !== repo) return undefined;
        throw error;
      });
      if (!addresses || this.disposed || this.repository !== repo) return;
      if (!addresses.length) { void vscode.window.showInformationMessage(`${path.basename(repo.root)}：尚未配置远程 Git 地址。`); return; }
      const items = addresses.map(address => ({ label: `${address.remote} · ${address.direction}`, description: address.url, detail: repo.root, url: address.url }));
      const choice = await vscode.window.showQuickPick(items, { title: `Git 地址 · ${path.basename(repo.root)}`, placeHolder: '查看 Fetch / Push 地址，选择一项复制（HTTP 凭据已隐藏）', matchOnDescription: true, matchOnDetail: true });
      if (!choice || this.disposed) return;
      await vscode.env.clipboard.writeText(choice.url);
      void vscode.window.showInformationMessage(`${path.basename(repo.root)}：已复制 ${choice.label} 地址。`);
      return;
    }
    const history = new HistoryService(repo), actions = new GitActions(repo);
    if (['history', 'commitDetails', 'revisionComparison'].includes(message.type)) {
      try {
        const result = message.type === 'history' ? await history.query(message.query) : message.type === 'commitDetails' ? await history.details(message.hash || '') : await history.compare(message.from || '', message.to || '');
        if (this.repository === repo) this.respond(source, { type: message.type, root: repo.root, requestId: message.requestId, result });
      } catch (error) {
        if (this.repository === repo) this.respond(source, { type: message.type, root: repo.root, requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'favoriteRef') {
      if (!message.ref || message.ref.kind === 'head') return;
      const selected = await history.resolve(message.ref);
      const favorites = this.context.workspaceState.get<Record<string, string[]>>('favoriteRefs') ?? {};
      const entries = new Set(favorites[repo.root] ?? []);
      if (entries.has(selected.full)) entries.delete(selected.full); else entries.add(selected.full);
      favorites[repo.root] = [...entries]; await this.context.workspaceState.update('favoriteRefs', favorites); this.broadcast(); return;
    }
    if (message.type === 'pickHistoryPath') {
      const choice = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(repo.root), canSelectFiles: true, canSelectFolders: true, canSelectMany: false, openLabel: '筛选此路径的历史' });
      if (!choice?.[0]) return;
      const relative = path.relative(repo.root, choice[0].fsPath);
      if (!this.contains(repo.root, choice[0].fsPath)) throw new Error('请选择当前仓库内的文件或目录。');
      if (this.repository === repo) this.respond(source, { type: 'historyPath', root: repo.root, path: relative.split(path.sep).join('/') });
      return;
    }
    if (message.type === 'copyHash' || message.type === 'copyMessage' || message.type === 'copyRef') {
      const value = message.type === 'copyRef' ? (await history.resolve(message.ref!)).label : message.type === 'copyHash' ? await history.requireCommit(message.hash || '') : (await history.details(message.hash || '')).message;
      await vscode.env.clipboard.writeText(value); return;
    }
    if (message.type === 'compareFile') { await this.diffRevisions(repo, message.path || '', message.from || '', message.to || '', Array.isArray(message.files) ? message.files : undefined); return; }
    if (message.type === 'shelfPatch') {
      const content = await new ShelfStore(repo).patch(message.id || '');
      const document = await vscode.workspace.openTextDocument({ content, language: 'diff' });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    if (message.type === 'diff' && typeof message.path === 'string') { await this.diff(repo, message.path, message.hash, Array.isArray(message.files) ? message.files : undefined); return; }
    if (message.type === 'commitFiles' && typeof message.hash === 'string') {
      const files = await repo.commitFiles(message.hash);
      if (this.repository === repo) this.postToViews({ type: 'commitFiles', root: repo.root, hash: message.hash, files });
      return;
    }
    if (this.busy) throw new Error('上一个 Git 操作尚未完成。');
    const paths = Array.isArray(message.paths) ? message.paths : [];
    this.busy = true; this.error = ''; this.broadcast();
    let completed = false;
    let pullResult: BranchPullResult | undefined;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Project Git · ${path.basename(repo.root)}` }, async () => {
        if (['switch', 'merge', 'rebase', 'checkoutCommit', 'cherryPick', 'revertCommit', 'resetCommit'].includes(message.type) && vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && this.contains(repo.root, document.uri.fsPath))) {
          throw new Error('当前仓库有未保存的编辑，请先保存，再执行分支或历史操作。');
        }
        switch (message.type) {
          case 'commit':
            // Only explicitly checked files are saved. Message-only Amend must
            // not save or include any unchecked editor changes.
            if (paths.length) await repo.validatePaths(paths);
            await this.saveSelectedDocuments(repo, paths, 'Commit');
            await repo.commit(paths, message.message || '', { amend: message.amend === true, expectedHead: message.expectedHead }); break;
          case 'stage': await repo.stage(paths); break;
          case 'unstage': await repo.unstage(paths); break;
          case 'shelve': {
            const changes = await repo.validatePaths(paths);
            const name = await vscode.window.showInputBox({
              title: `Shelve Changes · ${path.basename(repo.root)}`,
              prompt: `将勾选的 ${paths.length} 个文件保存到 Shelf 并移出工作区（先保存所选文件的未保存编辑）`,
              value: message.message?.split('\n')[0].slice(0, 120) || '未完成的修改',
              ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : '请填写 Shelf 名称。',
            });
            if (!name?.trim()) return;
            const files = changes.flatMap(c => c.originalPath ? [c.originalPath, c.path] : [c.path]);
            await this.saveSelectedDocuments(repo, files, 'Shelve');
            await new ShelfStore(repo).shelve(paths, name);
            break;
          }
          case 'unshelve': {
            const store = new ShelfStore(repo);
            const shelf = (await store.list()).find(s => s.id === message.id);
            if (!shelf) throw new Error('Shelf 不存在，请刷新列表。');
            if ((await this.dirtyDocuments(repo, shelf.files)).length) throw new Error('Shelf 涉及的文件有未保存编辑，请先保存后再恢复。Shelf 备份会保留。');
            await store.unshelve(shelf.id); break;
          }
          case 'deleteShelf': {
            const store = new ShelfStore(repo);
            const shelf = (await store.list()).find(s => s.id === message.id);
            if (!shelf) throw new Error('Shelf 不存在，请刷新列表。');
            if (!await this.confirm(repo, '删除 Shelf', `永久删除备份「${shelf.title}」（${shelf.files.length} 个文件），不会修改工作区文件。`)) return;
            await store.delete(shelf.id); break;
          }
          case 'discard': {
            const changes = await repo.discardChanges(paths);
            if ((await this.dirtyDocuments(repo, paths)).length) throw new Error('勾选的文件有未保存编辑，请先保存，再确认丢弃。');
            if (!await this.confirm(repo, '丢弃更改', discardSummary(changes.map(c => c.path), changes.filter(c => c.index === '?').length))) return;
            if ((await this.dirtyDocuments(repo, paths)).length) throw new Error('确认期间文件出现未保存编辑，已取消丢弃。');
            await repo.discard(paths, changes); break;
          }
          case 'fetch': await repo.run(['fetch', '--all', '--prune']); break;
          case 'pull': {
            const readTip = async () => {
              const ref = (await repo.run(['symbolic-ref', '--quiet', 'HEAD'], [0, 1])).trim();
              const hash = (await repo.run(['rev-parse', '--verify', 'HEAD^{commit}'], [0, 128])).trim() || undefined;
              return { ref, hash };
            };
            const before = await readTip();
            await repo.run(['pull', '--ff-only']);
            const after = await readTip();
            const branch = before.ref.replace(/^refs\/heads\//, '') || 'HEAD';
            pullResult = before.ref === after.ref && after.hash && before.hash !== after.hash
              ? { branch, status: 'fast-forward', range: { before: before.hash, after: after.hash } }
              : { branch, status: 'up-to-date' };
            break;
          }
          case 'pullBranch': {
            if (!message.ref) throw new Error('请选择本地分支。');
            const plan = await actions.branchPullPlan(message.ref);
            if (!await this.confirm(repo, 'Pull 到所选分支', `目标：${plan.branch} · ${plan.hash.slice(0, 8)}\n上游：${plan.remote} / ${plan.remoteRef.replace(/^refs\/heads\//, '')}\n只快进目标分支，不切换当前分支，也不修改当前工作区。`)) return;
            pullResult = await actions.pullBranch(message.ref, plan);
            break;
          }
          case 'push': {
            const upstream = (await repo.snapshot(1)).upstream;
            if (upstream) await repo.run(['push']);
            else {
              const branch = (await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
              const remotes = (await repo.run(['remote'])).trim().split('\n').filter(Boolean);
              if (!remotes.length) throw new Error('此仓库未配置 remote，请先添加远程地址。');
              const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { placeHolder: `推送 ${path.basename(repo.root)} / ${branch} 到哪个 remote？` });
              if (!remote || !await this.confirm(repo, '推送并设置上游', `${branch} → ${remote}/${branch}`)) return;
              await repo.run(['push', '--set-upstream', remote, branch]);
            }
            break;
          }
          case 'switch':
            if (message.ref) await actions.checkout(message.ref);
            else { await actions.assertReady(false); await repo.switchBranch(message.name || ''); }
            break;
          case 'createBranch': {
            const base = message.ref ? await history.resolve(message.ref) : message.hash ? { hash: await history.requireCommit(message.hash), label: message.hash.slice(0, 8) } : await repo.head().then(head => head ? { hash: head.hash, label: '当前 HEAD' } : undefined);
            const name = await vscode.window.showInputBox({ title: `创建并切换分支 · ${path.basename(repo.root)}`, prompt: `${repo.root}${base ? ` · 基于 ${base.label}` : ''}`, placeHolder: 'feature/my-change', ignoreFocusOut: true });
            if (!name) return;
            await actions.assertReady(false); await repo.createBranch(name, base?.hash); break;
          }
          case 'renameBranch': {
            if (message.ref?.kind !== 'local') throw new Error('只能重命名本地分支。');
            await history.resolve(message.ref);
            const name = await vscode.window.showInputBox({ title: `重命名本地分支 · ${path.basename(repo.root)}`, value: message.ref.name, ignoreFocusOut: true });
            if (!name || name === message.ref.name) return;
            await actions.renameBranch(message.ref.name!, name); break;
          }
          case 'deleteBranch': {
            const name = message.ref?.kind === 'local' ? (await history.resolve(message.ref)).label : message.name || '';
            if (!await this.confirm(repo, '删除本地分支', name)) return;
            await actions.assertReady(false); await repo.deleteBranch(name); break;
          }
          case 'deleteRemoteBranch': {
            if (message.ref?.kind !== 'remote') throw new Error('请选择远程分支。');
            const target = await history.resolve(message.ref);
            if (!await this.confirm(repo, '删除远程分支', `将从远程仓库删除 ${target.label} (${target.hash.slice(0, 8)})；若远程已更新，操作会拒绝执行。`)) return;
            await actions.deleteRemoteBranch(message.ref, target.hash); break;
          }
          case 'createTag': {
            const base = message.ref ? await history.resolve(message.ref) : { hash: await history.requireCommit(message.hash || ''), label: (message.hash || '').slice(0, 8) };
            const name = await vscode.window.showInputBox({ title: `创建本地标签 · ${path.basename(repo.root)}`, prompt: `基于 ${base.label} · ${base.hash.slice(0, 8)}`, placeHolder: 'v1.0.0', ignoreFocusOut: true });
            if (!name) return;
            const description = await vscode.window.showInputBox({ title: '标签说明（留空创建轻量标签）', ignoreFocusOut: true });
            if (description === undefined) return;
            await actions.createTag(name, base.hash, description); break;
          }
          case 'pushTag': {
            if (message.ref?.kind !== 'tag') throw new Error('请选择需要推送的标签。');
            const tag = (await history.tags()).find(tag => tag.name === message.ref!.name);
            if (!tag) throw new Error('标签不存在，请刷新。');
            const remotes = (await repo.run(['remote'])).split('\n').filter(Boolean);
            if (!remotes.length) throw new Error('当前仓库未配置 remote，请先添加远程地址。');
            const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { placeHolder: `推送标签 ${tag.name} 到哪个 remote？` });
            if (!remote || !await this.confirm(repo, '推送标签', `标签：${tag.name} · ${tag.hash.slice(0, 12)}\n目标 remote：${remote}\n只推送此标签；远程同名标签内容不同时拒绝覆盖。`)) return;
            await actions.pushTag(tag.name, remote, tag.hash); break;
          }
          case 'deleteTag': {
            if (message.ref?.kind !== 'tag') throw new Error('请选择标签。');
            const tag = (await history.tags()).find(tag => tag.name === message.ref!.name);
            if (!tag) throw new Error('标签不存在，请刷新。');
            if (!await this.confirm(repo, '删除本地标签', `${tag.name} · ${tag.hash.slice(0, 8)}（不删除远程标签）`)) return;
            await actions.deleteTag(tag.name, tag.hash); break;
          }
          case 'merge':
          case 'rebase': {
            const ref = message.ref || (await repo.branches()).filter(branch => branch.name === message.name).map(branch => ({ kind: branch.remote ? 'remote' as const : 'local' as const, name: branch.name }))[0];
            const target = await history.resolve(ref);
            const action = message.type === 'merge' ? '合并分支' : 'Rebase 当前分支';
            if (!await this.confirmAtHead(repo, action, message.type === 'merge' ? `将 ${target.label} (${target.hash.slice(0, 8)}) 合并到当前检出分支。` : `将当前检出分支的提交重放到 ${target.label} (${target.hash.slice(0, 8)})；本地提交哈希可能变化。`)) return;
            if (message.type === 'merge') await actions.merge(target.hash, target.label); else await actions.rebaseOnto(target.hash);
            break;
          }
          case 'checkoutCommit':
            if (!await this.confirmAtHead(repo, '检出提交', `以 Detached HEAD 检出 ${(await history.requireCommit(message.hash || '')).slice(0, 12)}，可随后新建分支保存工作。`)) return;
            await actions.checkoutCommit(message.hash!); break;
          case 'cherryPick':
          case 'revertCommit': {
            const details = await history.details(message.hash || '');
            let mainline: number | undefined;
            if (details.parents.length > 1) {
              const selected = await vscode.window.showQuickPick(details.parents.map((hash, index) => ({ label: `Parent ${index + 1} · ${hash.slice(0, 12)}`, value: index + 1 })), { placeHolder: '该提交是合并提交，请选择主线父提交' });
              if (!selected) return; mainline = selected.value;
            }
            const action = message.type === 'cherryPick' ? 'Cherry-pick 到当前分支' : 'Revert 此提交';
            if (!await this.confirmAtHead(repo, action, `${details.hash.slice(0, 12)} · ${details.message.split('\n')[0]}\n${message.type === 'revertCommit' ? '创建反向提交，不删除已有历史。' : '将该提交的修改应用为当前分支的一次提交。'}`)) return;
            await actions.applyCommit(message.type === 'cherryPick' ? 'cherry-pick' : 'revert', details.hash, mainline); break;
          }
          case 'resetCommit': {
            const hash = await history.requireCommit(message.hash || '');
            const choice = await vscode.window.showQuickPick([
              { label: 'Soft', description: '移动 HEAD，保留暂存区和工作区', mode: 'soft' as const },
              { label: 'Mixed', description: '移动 HEAD 并重置暂存区，保留工作区', mode: 'mixed' as const },
              { label: 'Hard', description: '移动 HEAD，并将暂存区和工作区恢复到该提交', mode: 'hard' as const },
            ], { placeHolder: 'Reset 模式（需先提交或搁置当前未提交修改）' });
            if (!choice || !await this.confirmAtHead(repo, `Reset ${choice.label}`, `将当前检出位置重置到 ${hash.slice(0, 12)}。远程分支不会改变。\n${choice.description}`)) return;
            await actions.resetTo(hash, choice.mode); break;
          }
          case 'continueOperation':
          case 'skipOperation':
          case 'abortOperation': {
            if (!message.operation) throw new Error('请刷新 Git 操作状态。');
            if (message.type === 'abortOperation' && !await this.confirm(repo, '中止 Git 操作', `中止当前 ${message.operation} 并返回操作前的状态。`)) return;
            if (message.type === 'skipOperation' && !await this.confirm(repo, '跳过当前提交', `放弃当前 ${message.operation} 步骤的修改，继续处理后续提交。`)) return;
            await actions.finishOperation(message.type === 'continueOperation' ? 'continue' : message.type === 'skipOperation' ? 'skip' : 'abort', message.operation); break;
          }
          case 'stash': await repo.stash(); break;
          case 'applyStash': {
            const stashes = await repo.stashes();
            if (!stashes.length) throw new Error('当前仓库没有 stash。');
            const selected = await vscode.window.showQuickPick(stashes.map(s => ({ label: s.ref, description: s.subject, hash: s.hash })), { placeHolder: `恢复 stash · ${path.basename(repo.root)}（保留备份）` });
            if (!selected) return;
            await repo.applyStash(selected.hash); break;
          }
          default: return;
        }
        completed = true;
      });
      if (completed && !this.disposed) {
        this.postToViews({ type: 'completed', action: message.type, root: repo.root });
        if (!pullResult) void vscode.window.showInformationMessage(`${path.basename(repo.root)}：${({ commit: '提交完成', stage: '已加入暂存区（尚未提交）', unstage: '已取消暂存，本地修改已保留', shelve: '修改已搁置到 Shelf', unshelve: 'Shelf 已恢复，备份已保留', deleteShelf: 'Shelf 备份已删除', push: '推送完成', pushTag: '标签推送完成', fetch: '获取完成' } as Record<string, string>)[message.type] || '操作完成'}`);
      }
    } catch (error) { this.report(new Error(`${repo.root}\n${error instanceof Error ? error.message : String(error)}`)); }
    finally {
      this.busy = false;
      // Invalidate any read that started before this mutation.
      ++this.generation; this.loading = false;
      const operationError = this.error;
      await this.refresh();
      if (!completed && operationError) { this.error = operationError; this.broadcast(); }
    }
    if (completed && pullResult) await this.notifyPull(repo, pullResult).catch(error => this.report(error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.navigation.dispose();
    this.updateDiffContext();
    ++this.generation; ++this.selection;
    clearInterval(this.timer);
    for (const view of this.views) this.detach(view);
    this.status.dispose(); this.previousChange.dispose(); this.nextChange.dispose();
    this.changesView.dispose(); this.localChanges.dispose(); this.panel?.dispose(); this.imagePanel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): { readonly selectedRepository: string | undefined } {
  const workbench = new Workbench(context);
  context.subscriptions.push(
    workbench,
    vscode.window.registerWebviewViewProvider('projectGit.workbench', workbench, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('projectGit.open', (uri?: vscode.Uri) => workbench.open(uri || vscode.window.activeTextEditor?.document.uri)),
    vscode.commands.registerCommand('projectGit.openFromExplorer', () => workbench.openFromExplorer().catch(error => vscode.window.showErrorMessage(`Project Git: ${error instanceof Error ? error.message : String(error)}`))),
    vscode.commands.registerCommand('projectGit.openResource', (uri?: vscode.Uri) => workbench.open(uri || vscode.window.activeTextEditor?.document.uri)),
    vscode.commands.registerCommand('projectGit.pickRepository', () => workbench.pick()),
    vscode.commands.registerCommand('projectGit.refresh', () => workbench.refresh()),
    vscode.commands.registerCommand('projectGit.closeDiff', () => workbench.closeDiff()),
    vscode.commands.registerCommand('projectGit.refreshLocalChanges', () => workbench.refreshLocalChanges().catch(error => vscode.window.showErrorMessage(`Project Git: ${error instanceof Error ? error.message : String(error)}`))),
    vscode.commands.registerCommand('projectGit.openLocalChange', (root: string, file: string) => workbench.openLocalChange(root, file).catch(error => vscode.window.showErrorMessage(`Project Git: ${error instanceof Error ? error.message : String(error)}`))),
    vscode.commands.registerCommand('projectGit.previousDiffChange', () => workbench.navigateDiff('previous')),
    vscode.commands.registerCommand('projectGit.nextDiffChange', () => workbench.navigateDiff('next')),
    vscode.commands.registerCommand('projectGit.showChanges', (uri?: vscode.Uri) => workbench.showChanges(uri || vscode.window.activeTextEditor?.document.uri).catch(error => vscode.window.showErrorMessage(`Project Git: ${error instanceof Error ? error.message : String(error)}`))),
  );
  return { get selectedRepository() { return workbench.selectedRepository; } };
}
