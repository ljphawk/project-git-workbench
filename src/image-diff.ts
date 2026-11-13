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

interface ImageData {
  src: string;
  bytes: number;
  type: '位图' | '矢量图';
  depth?: string;
}

function imageDepth(mime: string, bytes: Buffer): string | undefined {
  if (mime === 'image/png' && bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const depth = bytes[24];
    if ([1, 2, 4, 8, 16].includes(depth)) return `${depth} bit/${bytes[25] === 3 ? '索引' : '通道'}`;
  }
  if (mime === 'image/bmp' && bytes.length >= 54 && bytes.toString('ascii', 0, 2) === 'BM' &&
      [40, 52, 56, 108, 124].includes(bytes.readUInt32LE(14))) {
    const depth = bytes.readUInt16LE(28);
    if ([1, 4, 8, 16, 24, 32].includes(depth)) return `${depth} bit/像素`;
  }
}

function imageSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`;
  return `${bytes} B`;
}

export async function imageData(repo: Repository, uri?: vscode.Uri): Promise<ImageData | undefined> {
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
  return {
    src: `data:${mime};base64,${bytes.toString('base64')}`,
    bytes: bytes.length,
    type: mime === 'image/svg+xml' ? '矢量图' : '位图',
    depth: imageDepth(mime, bytes),
  };
}

export function imageDiffHtml(cspSource: string, css: vscode.Uri, nonce: string, before?: ImageData, after?: ImageData): string {
  const pane = (label: string, image: ImageData | undefined, empty: string) => `
    <section aria-label="${label}">
      <h2>${label}</h2>
      <div class="preview">${image ? `<img src="${image.src}" alt="${label}">` : `<p>${empty}</p>`}</div>
      ${image ? `<footer aria-label="图片信息">
        <span class="dimensions" aria-live="polite">正在读取尺寸…</span>
        <span title="${image.bytes} 字节">${imageSize(image.bytes)}</span>
        <span>${image.type}</span>
        ${image.depth ? `<span>${image.depth}</span>` : ''}
      </footer>` : ''}
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
        const dimensions = image.closest('section').querySelector('.dimensions');
        const updateDimensions = () => {
          if (image.naturalWidth && image.naturalHeight) {
            dimensions.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' px';
            return;
          }
          dimensions.textContent = '尺寸不可用';
          const message = document.createElement('p');
          message.textContent = '无法预览此图片，请检查文件内容或格式。';
          image.replaceWith(message);
        };
        if (image.complete) updateDimensions();
        else {
          image.addEventListener('load', updateDimensions, { once: true });
          image.addEventListener('error', updateDimensions, { once: true });
        }
      }
    </script></body></html>`;
}
