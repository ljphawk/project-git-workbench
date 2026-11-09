import { spawn } from 'node:child_process';

/** Capture the focused Explorer resource without leaving the clipboard changed.
 * A named pasteboard is used only by tests; production uses the general board.
 */
export async function explorerSelection(copyPath: () => PromiseLike<unknown>, script: string, pasteboard?: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('此平台请使用资源管理器右键「在 Project Git 中打开」，或在插件内选择项目。');
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script, ...(pasteboard ? [pasteboard] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completed = new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.startsWith('ready\n')) readyResolve();
    });
    child.stderr.resume();
    child.stdin.on('error', () => {}); // Close/error handling below owns the result.
    child.on('error', error => { readyReject(error); reject(error); });
    child.on('close', code => {
      if (code !== 0 || !output.startsWith('ready\n')) {
        // Helper stderr contains no clipboard contents, but avoid propagating it
        // into UI messages in case the operating system changes its formatting.
        const error = new Error('无法安全读取资源管理器选择，请右键目标目录打开 Project Git。');
        readyReject(error); reject(error); return;
      }
      try { resolve(String(JSON.parse(output.slice('ready\n'.length).trim()).path || '')); }
      catch { reject(new Error('读取资源管理器选择失败，请重试。')); }
    });
  });
  // Attach a rejection handler immediately, including if startup fails before ready.
  void completed.catch(() => {});
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    await ready;
    try { await copyPath(); }
    catch (error) { child.stdin.end('cancel'); await completed; throw error; }
    child.stdin.end('capture');
    return await completed;
  } finally {
    clearTimeout(timeout);
    if (!child.stdin.writableEnded) child.stdin.end('cancel');
  }
}
