import type * as VSCode from 'vscode';
import * as path from 'node:path';
import type { Change } from './git';

export class LocalChangeItem implements VSCode.TreeItem {
  readonly label: string;
  readonly collapsibleState = 0;
  readonly id: string;
  readonly description: string;
  readonly tooltip: string;
  readonly resourceUri: VSCode.Uri;
  readonly iconPath: VSCode.ThemeIcon;
  readonly command: VSCode.Command;
  constructor(api: typeof VSCode, readonly root: string, readonly change: Change) {
    this.label = path.basename(change.path);
    this.id = JSON.stringify([root, change.path]);
    this.description = `${change.index}${change.worktree}  ${path.dirname(change.path) === '.' ? '' : path.dirname(change.path)}`;
    this.tooltip = `${change.path}\n${root}${change.conflict ? '\n冲突文件：打开文件处理' : ''}`;
    this.resourceUri = api.Uri.file(path.join(root, change.path));
    this.iconPath = new api.ThemeIcon(change.conflict ? 'warning' : 'file');
    this.command = { command: 'projectGit.openLocalChange', title: '查看更改', arguments: [root, change.path] };
  }
}

/** A repository-pinned, read-only list beside the native single-file diff. */
export class LocalChanges implements VSCode.TreeDataProvider<LocalChangeItem>, VSCode.Disposable {
  private changed: VSCode.EventEmitter<void>;
  readonly onDidChangeTreeData: VSCode.Event<void>;
  root?: string;
  items: LocalChangeItem[] = [];
  constructor(private api: typeof VSCode) {
    this.changed = new api.EventEmitter<void>();
    this.onDidChangeTreeData = this.changed.event;
  }
  set(root: string | undefined, changes: Change[]): void {
    if (this.root === root && JSON.stringify(this.items.map(item => item.change)) === JSON.stringify(changes)) return;
    this.root = root;
    this.items = root ? changes.map(change => new LocalChangeItem(this.api, root, change)) : [];
    this.changed.fire();
  }
  getTreeItem(item: LocalChangeItem): VSCode.TreeItem { return item; }
  getParent(): undefined { return undefined; }
  getChildren(): LocalChangeItem[] { return this.items; }
  dispose(): void { this.changed.dispose(); }
}
