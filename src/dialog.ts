/** Native macOS message boxes grow with their detail text instead of scrolling. */
export function dialogLine(value: string, columns = 72): string {
  const chars = Array.from(value.replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
  const width = (char: string) => char.codePointAt(0)! > 255 ? 2 : 1;
  if (chars.reduce((sum, char) => sum + width(char), 0) <= columns) return chars.join('');
  const take = (items: string[], budget: number) => {
    let used = 0, output = '';
    for (const char of items) { used += width(char); if (used > budget) break; output += char; }
    return output;
  };
  const half = Math.floor((columns - 1) / 2);
  return take(chars, half) + '…' + Array.from(take([...chars].reverse(), half)).reverse().join('');
}

export function confirmationDetail(root: string, detail: string): string {
  const lines = detail.split(/\r?\n/);
  const visible = lines.length > 7 ? [...lines.slice(0, 6), '…其余内容已省略，请取消后在工作台核对。'] : lines;
  return [dialogLine(root), '', ...visible.map(line => dialogLine(line))].join('\n');
}

export function discardSummary(paths: string[], untracked = 0): string {
  return [
    `选中 ${paths.length} 个文件：删除 ${untracked} 个未跟踪文件，另有 ${paths.length - untracked} 个已跟踪文件。`,
    '已跟踪文件仅还原未暂存更改；此操作不可撤销。',
    ...paths.slice(0, 3).map(file => dialogLine(file)),
    ...(paths.length > 3 ? [`…另 ${paths.length - 3} 个文件。`] : []),
    '完整范围见 Local Changes 中勾选的文件；请确认后再继续。',
  ].join('\n');
}
