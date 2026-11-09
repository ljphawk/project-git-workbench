import type { Change } from './git';

/** Retain the visible file order, starting at the clicked file. Native multi-diff
 * navigation wraps at the ends, so rotating also retains its previous file. */
export function diffFiles(changes: Change[], file: string, visible?: string[]): Change[] {
  const allowed = new Map(changes.filter(change => !change.conflict).map(change => [change.path, change]));
  const current = allowed.get(file);
  if (!current) throw new Error('文件已不在可比对列表中，请刷新后重试。');
  const paths = visible ? [...new Set(visible.filter(value => typeof value === 'string' && allowed.has(value)))] : [...allowed.keys()];
  if (!paths.includes(file)) return [current];
  const index = paths.indexOf(file);
  return [...paths.slice(index), ...paths.slice(0, index)].map(value => allowed.get(value)!);
}
