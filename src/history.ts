import type { Repository, Commit, Change } from './git';

export interface GitRef { kind: 'head' | 'local' | 'remote' | 'tag'; name?: string }
export interface GitTag { name: string; hash: string; commit?: string; annotated: boolean }
export interface HistoryQuery {
  refs?: GitRef[]; text?: string; regex?: boolean; matchCase?: boolean;
  author?: string; after?: string; before?: string; path?: string;
  skip?: number; limit?: number; firstParent?: boolean; noMerges?: boolean;
  order?: 'date' | 'topo'; compare?: { ref: GitRef; direction: 'incoming' | 'outgoing' };
}
export interface RevisionComparison { from: string; to: string; files: Change[] }
export interface HistoryPage {
  commits: Commit[]; hasMore: boolean; skip: number;
  comparison?: RevisionComparison & { incoming: number; outgoing: number; label: string; direction: 'incoming' | 'outgoing' };
}
export interface CommitDetails {
  hash: string; parents: string[]; author: string; email: string; authoredAt: string;
  committer: string; committerEmail: string; committedAt: string; message: string; files: Change[];
}
interface CatalogEntry { full: string; object: string; type: string; commit?: string }
const isHash = (hash: unknown): hash is string => typeof hash === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash);
const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function refKey(ref: GitRef): string {
  if (ref.kind === 'head') return 'HEAD';
  const prefixes = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' };
  if (!prefixes[ref.kind] || typeof ref.name !== 'string' || !ref.name || ref.name.length > 1024) throw new Error('无效的分支或标签。');
  return prefixes[ref.kind] + ref.name;
}

export class HistoryService {
  private catalogPromise?: Promise<CatalogEntry[]>;
  constructor(private repo: Repository) {}

  private catalog(): Promise<CatalogEntry[]> {
    if (!this.catalogPromise) this.catalogPromise = this.repo.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)', 'refs/heads/', 'refs/remotes/', 'refs/tags/']).then(output =>
      output.split('\n').filter(Boolean).map(line => {
        const [full, object, type, peeled, peeledType] = line.split('\0');
        return { full, object, type, commit: type === 'commit' ? object : peeledType === 'commit' ? peeled : undefined };
      }));
    return this.catalogPromise;
  }

  async tags(): Promise<GitTag[]> {
    return (await this.catalog()).filter(entry => entry.full.startsWith('refs/tags/')).map(entry => ({
      name: entry.full.slice('refs/tags/'.length), hash: entry.object, commit: entry.commit, annotated: entry.type === 'tag',
    }));
  }

  async resolve(ref: GitRef): Promise<{ hash: string; full: string; label: string }> {
    if (!ref || typeof ref !== 'object') throw new Error('请选择有效的分支或标签。');
    const full = refKey(ref);
    if (full === 'HEAD') {
      const head = await this.repo.head();
      if (!head) throw new Error('当前仓库还没有提交。');
      return { hash: head.hash, full, label: 'HEAD' };
    }
    const entry = (await this.catalog()).find(item => item.full === full);
    if (!entry?.commit || !isHash(entry.commit)) throw new Error('分支或标签已变化，或该标签不指向提交，请刷新后重试。');
    return { hash: entry.commit, full, label: ref.name! };
  }

  async requireCommit(hash: string): Promise<string> {
    if (!isHash(hash)) throw new Error('无效的提交标识。');
    const commit = (await this.repo.run(['rev-parse', '--verify', `${hash}^{commit}`])).trim();
    if (commit !== hash) throw new Error('请选择提交对象，而不是标签对象。');
    return commit;
  }

  private text(value: unknown, label: string, max = 1024): string {
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}无效或过长。`);
    return value;
  }

  async query(query: HistoryQuery = {}): Promise<HistoryPage> {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('历史筛选条件无效。');
    const limit = query.limit ?? 150, skip = query.skip ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(skip) || skip < 0 || skip > 1_000_000) throw new Error('分页范围无效。');
    const text = this.text(query.text, '搜索内容'), author = this.text(query.author, '作者', 256), file = this.text(query.path, '路径', 4096);
    if (file && (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..'))) throw new Error('路径必须是仓库内的相对路径。');
    const dates = [query.after, query.before].map(value => {
      if (!value) return undefined;
      if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('日期范围无效。');
      if (new Date(value).toISOString() !== (value.includes('.') ? value : value.replace(/Z$/, '.000Z'))) throw new Error('日期范围无效。');
      return value;
    });
    if (dates[0] && dates[1] && Date.parse(dates[0]) > Date.parse(dates[1])) throw new Error('开始日期不能晚于结束日期。');
    if (query.refs !== undefined && (!Array.isArray(query.refs) || query.refs.length > 32)) throw new Error('最多同时筛选 32 个分支或标签。');
    const head = await this.repo.head();
    let roots: string[];
    let comparison: HistoryPage['comparison'];
    if (query.compare) {
      if (!head || !['incoming', 'outgoing'].includes(query.compare.direction)) throw new Error('比较方向无效，或当前分支没有提交。');
      const other = await this.resolve(query.compare.ref);
      const [outgoing, incoming] = (await this.repo.run(['rev-list', '--left-right', '--count', `${head.hash}...${other.hash}`])).trim().split(/\s+/).map(Number);
      comparison = { ...(await this.compare(head.hash, other.hash)), incoming, outgoing, label: other.label, direction: query.compare.direction };
      roots = query.compare.direction === 'incoming' ? [other.hash, `^${head.hash}`] : [head.hash, `^${other.hash}`];
    } else if (query.refs?.length) {
      if (!head && query.refs.every(ref => ref.kind === 'head')) return { commits: [], hasMore: false, skip };
      roots = (await Promise.all(query.refs.map(ref => this.resolve(ref)))).map(ref => ref.hash);
    } else {
      roots = [...new Set([...(await this.catalog()).flatMap(ref => ref.commit ? [ref.commit] : []), ...(head ? [head.hash] : [])])];
    }
    if (!roots.length) return { commits: [], hasMore: false, skip, comparison };
    let exactHash: string | undefined;
    if (!query.regex && /^[a-f0-9]{4,64}$/i.test(text)) {
      exactHash = await this.repo.run(['rev-parse', '--verify', `${text}^{commit}`]).then(value => value.trim(), () => undefined);
    }
    if (exactHash) {
      const positives = roots.filter(ref => !ref.startsWith('^')), negatives = roots.filter(ref => ref.startsWith('^')).map(ref => ref.slice(1));
      const ancestor = (tip: string) => this.repo.run(['merge-base', '--is-ancestor', exactHash!, tip], [0]).then(() => true, () => false);
      if (!(await Promise.all(positives.map(ancestor))).some(Boolean) || (await Promise.all(negatives.map(ancestor))).some(Boolean)) return { commits: [], hasMore: false, skip, comparison };
      roots = [exactHash];
    }
    const args = ['log', '--no-patch', '--no-notes', '--no-show-signature', '--no-color', '--decorate=short', '--stdin', query.order === 'topo' ? '--topo-order' : '--date-order', '--full-history', `--max-count=${exactHash ? 1 : limit + 1}`, `--skip=${skip}`, '-z', '--format=%H%x00%P%x00%an%x00%cI%x00%D%x00%s', '--extended-regexp'];
    if (!query.matchCase) args.push('--regexp-ignore-case');
    if (text && !exactHash) args.push(`--grep=${query.regex ? text : literalPattern(text)}`);
    if (author) args.push(`--author=${literalPattern(author)}`);
    if (exactHash) args.push('--no-walk');
    if (dates[0]) args.push(`--since-as-filter=${dates[0]}`);
    if (dates[1]) args.push(`--until=${dates[1]}`);
    if (query.firstParent) args.push('--first-parent');
    if (query.noMerges) args.push('--no-merges');
    args.push('--', ...(file ? [file] : []));
    const raw = await this.repo.run(args, undefined, { input: roots.join('\n') + '\n' });
    const fields = raw.split('\0'), commits: Commit[] = [];
    for (let i = 0; i + 5 < fields.length; i += 6) commits.push({ hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], refs: fields[i + 4], subject: fields[i + 5] });
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit, skip, comparison };
  }

  async details(hash: string): Promise<CommitDetails> {
    await this.requireCommit(hash);
    const fields = (await this.repo.run(['show', '-s', '--no-notes', '--no-show-signature', '--no-color', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', hash, '--'])).split('\0');
    return { hash: fields[0], parents: fields[1].split(' ').filter(Boolean), author: fields[2], email: fields[3], authoredAt: fields[4], committer: fields[5], committerEmail: fields[6], committedAt: fields[7], message: fields.slice(8).join('\0').trimEnd(), files: await this.repo.commitFiles(hash) };
  }

  async compare(from: string, to: string): Promise<RevisionComparison> {
    await Promise.all([this.requireCommit(from), this.requireCommit(to)]);
    const fields = (await this.repo.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', from, to, '--'])).split('\0');
    const files: Change[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) files.push({ path: fields[i + 1], index: fields[i], worktree: ' ', conflict: false });
    return { from, to, files };
  }
}
