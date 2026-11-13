import type * as vscode from 'vscode';
import * as path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import type { Repository } from './git';

const imageTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
]);
const maxImageBytes = 16 * 1024 * 1024;
export const isImage = (file: string): boolean => imageTypes.has(path.extname(file).toLowerCase());

export async function imageData(repo: Repository, uri?: vscode.Uri): Promise<string | undefined> {
  if (!uri) return undefined;
  const mime = imageTypes.get(path.extname(uri.path).toLowerCase());
  if (!mime) throw new Error('此版本的文件格式不支持图片预览。');
  let bytes: Buffer;
  if (uri.scheme === 'file') {
    const canonical = await fs.realpath(uri.fsPath);
    const relative = path.relative(repo.root, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('图片必须位于当前仓库内。');
    }
    const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('请选择图片文件。');
      if (stat.size > maxImageBytes) throw new Error('图片预览支持每侧最多 16 MiB。');
      bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw new Error('读取期间图片大小已变化，请重新打开比对。');
      bytes = bytes.subarray(0, offset);
    } finally { await handle.close(); }
  } else {
    const { root, file, ref } = JSON.parse(uri.query) as { root: string; file: string; ref: string };
    if (uri.scheme !== 'project-git-content' || root !== repo.root || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)) {
      throw new Error('无效的图片版本。');
    }
    bytes = await repo.runBytes(['cat-file', 'blob', `${ref}:${file}`]);
  }
  if (bytes.length > maxImageBytes) throw new Error('图片预览支持每侧最多 16 MiB。');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function imageDiffHtml(cspSource: string, css: vscode.Uri, nonce: string, before?: string, after?: string): string {
  const pane = (label: string, image: string | undefined, empty: string) => `
    <section aria-label="${label}">
      <h2>${label}</h2>
      <div class="preview">${image ? `<img src="${image}" alt="${label}">` : `<p>${empty}</p>`}</div>
    </section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource}; script-src 'nonce-${nonce}'">
    <link rel="stylesheet" href="${css}"><title>图片对比</title></head>
    <body><main>${pane('旧版本', before, '新增图片，此版本无文件')}${pane('新版本', after, '此版本无文件')}</main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') vscode.postMessage({ type: 'close' });
      });
      for (const image of document.images) {
        image.addEventListener('error', () => {
          const message = document.createElement('p');
          message.textContent = '无法预览此图片，请检查文件内容或格式。';
          image.replaceWith(message);
        });
      }
    </script></body></html>`;
}
