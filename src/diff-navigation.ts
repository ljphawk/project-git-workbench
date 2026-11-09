import type * as VSCode from 'vscode';

export interface DiffResource { original: VSCode.Uri; modified: VSCode.Uri; name: string }
interface Sequence { title: string; resources: DiffResource[] }
interface Session { sequence: Sequence; index: number; readyVersion?: string }
type Direction = 'next' | 'previous';
const commands: Record<Direction, string> = { next: 'workbench.action.compareEditor.nextChange', previous: 'workbench.action.compareEditor.previousChange' };

/** Keep VS Code's single-file editor and native hunk navigation. Only attach
 * boundary handling while an explicitly registered Project Git diff is active. */
export class DiffNavigation {
  private sessions = new Map<string, Session>();
  private handlers: VSCode.Disposable[] = [];
  private nativeDepth = 0;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  private ticket = 0;
  private registrationFailed = false;
  constructor(private api: typeof VSCode, private onError: (error: unknown) => void, private onStateChange?: () => void) {}

  private key(original: VSCode.Uri, modified: VSCode.Uri): string { return JSON.stringify([original.toString(), modified.toString()]); }
  private activeKey(): string | undefined {
    const input = this.api.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof this.api.TabInputTextDiff ? this.key(input.original, input.modified) : undefined;
  }
  private active(): Session | undefined { const key = this.activeKey(); return key ? this.sessions.get(key) : undefined; }
  get managed(): boolean { return !!this.active(); }
  private clearHandlers(): void { for (const handler of this.handlers.splice(0)) handler.dispose(); }

  update(): void {
    if (this.disposed || this.nativeDepth || (this.active()?.sequence.resources.length ?? 0) < 2) { if (!this.nativeDepth) this.clearHandlers(); return; }
    if (this.handlers.length || this.registrationFailed) return;
    try {
      for (const direction of ['next', 'previous'] as const) {
        this.handlers.push(this.api.commands.registerCommand(commands[direction], (...args: unknown[]) => this.request(direction, args)));
      }
    } catch (error) { this.registrationFailed = true; this.clearHandlers(); this.onError(error); }
  }

  request(direction: Direction, args: unknown[] = []): Promise<void> {
    const sequence = this.active()?.sequence;
    this.pending = this.pending.then(async () => {
      if (sequence && this.active()?.sequence !== sequence) return;
      await this.navigate(direction, args);
    }).catch(this.onError);
    return this.pending;
  }

  private async native(direction: Direction, args: unknown[] = []): Promise<void> {
    // Temporarily release our registrations so the original built-in command,
    // including its cursor/scroll/whitespace behavior, runs without recursion.
    this.nativeDepth++; this.clearHandlers();
    try {
      await this.api.commands.executeCommand(commands[direction], ...args);
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { this.nativeDepth--; if (!this.disposed) this.update(); }
  }

  private editor(session: Session): VSCode.TextEditor | undefined {
    const uri = session.sequence.resources[session.index].modified.toString();
    return this.api.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri);
  }
  private version(session: Session): string {
    const resource = session.sequence.resources[session.index];
    return [resource.original, resource.modified].map(uri => this.api.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString())?.document.version ?? -1).join(':');
  }
  private position(editor: VSCode.TextEditor, line: number, character: number): void { editor.selection = new this.api.Selection(line, character, line, character); }
  private current(session: Session): boolean {
    const resource = session.sequence.resources[session.index];
    const key = this.key(resource.original, resource.modified);
    return !this.disposed && this.sessions.get(key) === session && this.activeKey() === key;
  }

  private async ready(session: Session): Promise<boolean> {
    if (session.readyVersion === this.version(session)) return true;
    const editor = this.editor(session); if (!editor) return false;
    const original = await this.api.workspace.openTextDocument(session.sequence.resources[session.index].original);
    if (!this.current(session)) return false;
    const ignoreWhitespace = this.api.workspace.getConfiguration('diffEditor', editor.document.uri).get('ignoreTrimWhitespace', true);
    const normalized = (text: string) => {
      const lines = text.replace(/\r\n/g, '\n');
      return ignoreWhitespace ? lines.split('\n').map(line => line.replace(/^[\t ]+|[\t ]+$/g, '')).join('\n') : lines;
    };
    if (normalized(original.getText()) === normalized(editor.document.getText())) { session.readyVersion = this.version(session); return true; }
    const saved = editor.selection, deadline = Date.now() + 2_000;
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    // An empty modified document has at most one deletion block, already at 0:0.
    if (end.line === 0 && end.character === 0) { session.readyVersion = this.version(session); return true; }
    try {
      while (this.current(session) && Date.now() < deadline) {
        // A native move from either sentinel proves that its diff model is
        // computed. Never interpret a still-loading no-op as a file boundary.
        this.position(editor, end.line, end.character);
        await this.native('next');
        if (!this.current(session)) return false;
        if (!editor.selection.active.isEqual(end)) { session.readyVersion = this.version(session); return true; }
        this.position(editor, 0, 0);
        await this.native('previous');
        if (!this.current(session)) return false;
        if (editor.selection.active.line !== 0 || editor.selection.active.character !== 0) { session.readyVersion = this.version(session); return true; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    } finally { if (this.current(session)) editor.selection = saved; }
  }

  async open(title: string, resources: DiffResource[]): Promise<void> {
    if (!resources.length || this.disposed) return;
    const opened = this.pending.then(() => this.openAt({ title, resources }, 0, 'next'));
    // Initial model preparation and arrow clicks must not move the cursor in
    // parallel. Keep the queue usable if a document failed to open.
    this.pending = opened.catch(() => {});
    await opened;
  }

  private async openAt(sequence: Sequence, index: number, edge: Direction): Promise<void> {
    if (this.disposed) return;
    const ticket = ++this.ticket, resource = sequence.resources[index];
    const key = this.key(resource.original, resource.modified);
    const session: Session = { sequence, index };
    this.sessions.set(key, session);
    const count = sequence.resources.length > 1 ? ` · ${index + 1}/${sequence.resources.length}` : '';
    await this.api.commands.executeCommand('vscode.diff', resource.original, resource.modified, `${resource.name} · ${sequence.title}${count}`, { preview: true });
    if (this.disposed || ticket !== this.ticket || !this.current(session)) return;
    this.update();
    this.onStateChange?.();
    if (!await this.ready(session) || ticket !== this.ticket || !this.current(session)) return;
    const editor = this.editor(session); if (!editor) return;
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    if (edge === 'next') this.position(editor, end.line, end.character); else this.position(editor, 0, 0);
    await this.native(edge);
  }

  private async navigate(direction: Direction, args: unknown[]): Promise<void> {
    const session = this.active();
    if (!session || this.disposed) { await this.native(direction, args); return; }
    const resource = session.sequence.resources[session.index];
    if (args.some(arg => typeof arg === 'object' && arg !== null && 'scheme' in arg && 'path' in arg && arg.toString() !== resource.original.toString() && arg.toString() !== resource.modified.toString())) { await this.native(direction, args); return; }
    if (!await this.ready(session) || !this.current(session)) { if (this.current(session)) await this.native(direction, args); return; }
    const editor = this.editor(session); if (!editor) { await this.native(direction, args); return; }
    const before = editor.selection.active, version = this.version(session);
    await this.native(direction, args);
    if (!this.current(session) || version !== this.version(session)) return;
    const after = editor.selection.active;
    const crossed = direction === 'next' ? after.line <= before.line : after.line >= before.line;
    if (crossed && session.sequence.resources.length > 1) {
      const count = session.sequence.resources.length;
      await this.openAt(session.sequence, (session.index + (direction === 'next' ? 1 : count - 1)) % count, direction);
    }
  }

  dispose(): void { this.disposed = true; this.ticket++; this.clearHandlers(); this.sessions.clear(); }
}
