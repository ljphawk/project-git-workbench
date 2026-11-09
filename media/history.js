/* A repository-scoped branch tree and server-filtered Git Log workbench. */
(() => {
  const defaults = () => ({ text: '', author: '', after: '', before: '', path: '', regex: false, matchCase: false, firstParent: false, noMerges: false, order: 'date' });
  const key = ref => ref.kind === 'head' ? 'HEAD' : ({ local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' })[ref.kind] + ref.name;
  const same = (a, b) => key(a) === key(b);
  const clampDetailHeight = height => Math.round(Math.max(20, Math.min(70, height)));
  class ProjectGitHistory {
    constructor(host, stored = {}) {
      this.host = host; this.repos = stored.repos || {}; this.width = stored.width || 280;
      this.detailHeight = Number.isFinite(stored.detailHeight) ? clampDetailHeight(stored.detailHeight) : 24;
      this.view = { author: true, date: true, hash: true, details: true, refs: true, ...(stored.view || {}) };
      this.root = ''; this.refs = []; this.filters = defaults(); this.branchSearch = ''; this.collapsed = new Set();
      this.rows = []; this.ready = false; this.loading = false; this.error = ''; this.hasMore = false;
      this.counter = 0; this.request = 0; this.detailRequest = 0; this.compareRequest = 0; this.signature = '';
      this.selection = new Set(); this.selected = ''; this.details = undefined; this.detailError = ''; this.filesFilter = '';
      this.comparison = undefined; this.revisionComparison = undefined; this.compareMode = undefined; this.showComparison = false;
      this.popover = ''; this.menu = undefined; this.treeHidden = false; this.treeOverlay = false;
      document.documentElement.style.setProperty('--history-sidebar-width', `${this.width}px`);
      document.documentElement.style.setProperty('--history-detail-height', `${this.detailHeight}%`);
      document.addEventListener('click', event => {
        if (event.button !== 0) return;
        let changed = false;
        if (this.menu && !event.target.closest('.history-menu,[data-hact="refMenu"],[data-hact="commitMenu"]')) { this.menu = undefined; changed = true; }
        if (this.popover && !event.target.closest('.history-filter-popover,.history-filter-button')) { this.popover = ''; changed = true; }
        if (changed) this.host.redraw();
      });
      document.addEventListener('pointerdown', event => {
        if (event.button !== 0 || this.dragging) return;
        const divider = event.target.closest('.history-divider, .history-detail-divider');
        if (!divider) return;
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        this.dragging = {
          pointerId: event.pointerId,
          details: divider.classList.contains('history-detail-divider'),
          y: event.clientY,
          height: this.detailHeight,
        };
      });
      document.addEventListener('pointermove', event => {
        const drag = this.dragging;
        if (event.pointerId !== drag?.pointerId) return;
        if (drag.details) {
          const height = document.querySelector('.history-main')?.clientHeight;
          if (height) this.resizeDetails(drag.height + (drag.y - event.clientY) * 100 / height);
          return;
        }
        const rect = document.querySelector('.history-workspace')?.getBoundingClientRect();
        if (!rect) return;
        this.width = Math.round(Math.max(160, Math.min(event.clientX - rect.left, Math.min(520, rect.width * .6))));
        document.documentElement.style.setProperty('--history-sidebar-width', `${this.width}px`);
      });
      const finishDrag = event => {
        if (event.pointerId !== this.dragging?.pointerId) return;
        const { details } = this.dragging;
        this.dragging = undefined;
        this.save();
        if (!details) this.host.redraw();
      };
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(event, finishDrag);
    }
    resizeDetails(height) {
      this.detailHeight = clampDetailHeight(height);
      document.documentElement.style.setProperty('--history-detail-height', `${this.detailHeight}%`);
      document.querySelector('.history-detail-divider')?.setAttribute('aria-valuenow', String(this.detailHeight));
    }
    active() { return ['log', 'branches'].includes(this.host.tab()); }
    preferences() { return { repos: this.repos, width: this.width, detailHeight: this.detailHeight, view: this.view }; }
    save() {
      if (this.root) this.repos[this.root] = { refs: this.refs, filters: this.filters, branchSearch: this.branchSearch, collapsed: [...this.collapsed], compareMode: this.compareMode };
      this.host.persist();
    }
    refsFor(snapshot) {
      return [...snapshot.branches.map(branch => ({ kind: branch.remote ? 'remote' : 'local', name: branch.name, branch })), ...(snapshot.tags || []).map(tag => ({ kind: 'tag', name: tag.name, tag }))];
    }
    find(refKey) { return refKey === 'HEAD' ? { kind: 'head' } : this.refsFor(this.host.state().snapshot).find(ref => key(ref) === refKey); }
    wire(ref) { return { kind: ref.kind, ...(ref.name ? { name: ref.name } : {}) }; }
    onState(changed) {
      const snapshot = this.host.state().snapshot;
      if (changed) {
        this.root = this.host.root(); const prefs = this.repos[this.root] || {};
        this.refs = prefs.refs || []; this.filters = { ...defaults(), ...(prefs.filters || {}) }; this.branchSearch = prefs.branchSearch || ''; this.collapsed = new Set(prefs.collapsed || []);
        this.compareMode = prefs.compareMode; this.rows = []; this.ready = false; this.loading = false; this.signature = ''; this.error = '';
        this.selection.clear(); this.selected = ''; this.details = undefined; this.revisionComparison = undefined; this.comparison = undefined; this.menu = undefined; this.popover = ''; this.treeOverlay = false;
        this.request = ++this.counter; this.detailRequest = ++this.counter; this.compareRequest = ++this.counter;
        clearTimeout(this.debounce);
      }
      if (!snapshot) return;
      const valid = new Set(['HEAD', ...this.refsFor(snapshot).map(key)]);
      this.refs = this.refs.filter(ref => valid.has(key(ref)));
      if (this.compareMode && !valid.has(key(this.compareMode.ref))) this.compareMode = undefined;
      if (this.active() && !this.host.state().busy && !this.host.state().loading && this.currentSignature() !== this.signature) this.load();
    }
    currentSignature() {
      const s = this.host.state().snapshot;
      return s ? JSON.stringify([s.head?.hash, s.branch, s.branches.map(b => [b.name, b.hash]), (s.tags || []).map(t => [t.name, t.hash])]) : '';
    }
    activate() { if (this.active() && this.host.state().snapshot && (!this.ready && !this.loading || this.currentSignature() !== this.signature)) this.load(); }
    query(skip) {
      const f = this.filters;
      return {
        refs: this.refs.map(ref => this.wire(ref)), text: f.text, regex: f.regex, matchCase: f.matchCase, author: f.author,
        ...(f.after ? { after: new Date(`${f.after}T00:00:00`).toISOString() } : {}),
        ...(f.before ? { before: new Date(`${f.before}T23:59:59.999`).toISOString() } : {}),
        path: f.path, skip, limit: this.host.state().historyPageSize || 150, firstParent: f.firstParent, noMerges: f.noMerges, order: f.order,
        ...(this.compareMode ? { compare: { ref: this.wire(this.compareMode.ref), direction: this.compareMode.direction } } : {}),
      };
    }
    load(append = false) {
      if (!this.active() || !this.host.state().snapshot) return;
      clearTimeout(this.debounce);
      if (this.filters.after && this.filters.before && this.filters.after > this.filters.before) { this.error = '开始日期不能晚于结束日期。'; this.loading = false; this.host.redraw(); return; }
      this.append = append; this.request = ++this.counter; this.signature = this.currentSignature(); this.error = ''; this.loading = true;
      if (!append) { this.rows = []; this.ready = false; this.hasMore = false; this.selected = ''; this.selection.clear(); this.details = undefined; this.revisionComparison = undefined; this.showComparison = false; this.detailRequest = ++this.counter; this.compareRequest = ++this.counter; }
      this.host.redraw();
      try { this.host.send('history', { requestId: this.request, query: this.query(append ? this.rows.length : 0) }); }
      catch (error) { this.loading = false; this.error = error.message; this.host.redraw(); }
    }
    receive(message) {
      if (!['history', 'commitDetails', 'revisionComparison', 'historyPath'].includes(message.type)) return false;
      if (message.root !== this.host.root()) return true;
      if (message.type === 'historyPath') { this.filters.path = message.path; this.popover = ''; this.save(); this.load(); return true; }
      if (message.type === 'history') {
        if (message.requestId !== this.request) return true;
        this.loading = false; this.ready = true; this.error = message.error || '';
        if (message.result) {
          const next = message.result.commits || [];
          this.rows = this.append ? [...new Map([...this.rows, ...next].map(commit => [commit.hash, commit])).values()] : next;
          this.hasMore = message.result.hasMore; this.comparison = message.result.comparison;
          if (this.selected && !this.rows.some(commit => commit.hash === this.selected)) { this.selected = ''; this.selection.clear(); this.details = undefined; }
        }
      }
      if (message.type === 'commitDetails') {
        if (message.requestId !== this.detailRequest || message.result && message.result.hash !== this.selected) return true;
        this.details = message.result; this.detailError = message.error || '';
      }
      if (message.type === 'revisionComparison') {
        if (message.requestId !== this.compareRequest) return true;
        this.revisionComparison = message.result; this.detailError = message.error || ''; this.showComparison = true;
      }
      this.host.redraw(); return true;
    }
    choose(refKey, multi = false) {
      this.compareMode = undefined; this.showComparison = false; this.revisionComparison = undefined;
      if (refKey === 'ALL') this.refs = [];
      else {
        const ref = this.find(refKey); if (!ref || ref.kind === 'tag' && !ref.tag?.commit) return;
        if (multi) this.refs = this.refs.some(value => same(value, ref)) ? this.refs.filter(value => !same(value, ref)) : [...this.refs, this.wire(ref)];
        else this.refs = [this.wire(ref)];
      }
      this.treeOverlay = false; this.menu = undefined; this.save(); this.load();
    }
    selectCommit(hash, multi) {
      if (multi) {
        if (this.selection.has(hash)) this.selection.delete(hash); else { if (this.selection.size >= 2) this.selection.delete([...this.selection][0]); this.selection.add(hash); }
      } else this.selection = new Set([hash]);
      this.compareRequest = ++this.counter; this.selected = hash; this.details = undefined; this.detailError = ''; this.filesFilter = ''; this.showComparison = false;
      this.detailRequest = ++this.counter; this.host.redraw(); this.host.send('commitDetails', { hash, requestId: this.detailRequest });
    }
    graph() {
      let lanes = [], max = 2; const visible = new Set(this.rows.map(commit => commit.hash)), drawings = [];
      const x = lane => 10 + lane * 13;
      for (const commit of this.rows) {
        const incoming = lanes.includes(commit.hash); if (!incoming) lanes.push(commit.hash);
        const before = [...lanes], at = lanes.indexOf(commit.hash); lanes.splice(at, 1);
        const parents = commit.parents.filter(hash => visible.has(hash));
        parents.forEach((hash, i) => { if (!lanes.includes(hash)) lanes.splice(i === 0 ? Math.min(at, lanes.length) : lanes.length, 0, hash); });
        max = Math.max(max, before.length, lanes.length);
        let lines = before.map((hash, i) => hash === commit.hash ? incoming ? `<path class="lane l${at % 6}" d="M${x(at)} 0V20"/>` : '' : `<path class="lane l${i % 6}" d="M${x(i)} 0C${x(i)} 26 ${x(lanes.indexOf(hash))} 14 ${x(lanes.indexOf(hash))} 40"/>`).join('');
        lines += parents.map(hash => `<path class="lane l${at % 6}" d="M${x(at)} 20C${x(at)} 32 ${x(lanes.indexOf(hash))} 27 ${x(lanes.indexOf(hash))} 40"/>`).join('');
        if (parents.length < commit.parents.length) lines += `<path class="lane boundary l${at % 6}" d="M${x(at)} 23V34"/>`;
        drawings.push(`${lines}<circle class="dot l${at % 6}" cx="${x(at)}" cy="20" r="${commit.parents.length > 1 ? 4 : 3}"/>`);
      }
      const width = Math.max(38, max * 13 + 10);
      document.documentElement.style.setProperty('--history-graph-width', `${width}px`);
      document.documentElement.style.setProperty('--history-row-min-width', `${width + 220 + 20 + 12 * (1 + Number(this.view.author) + Number(this.view.date) + Number(this.view.hash)) + (this.view.author ? 110 : 0) + (this.view.date ? 155 : 0) + (this.view.hash ? 68 : 0)}px`);
      return drawings.map(body => `<svg class="history-graph" width="${Math.max(38, max * 13 + 10)}" height="40" aria-hidden="true">${body}</svg>`);
    }
    row(ref, snapshot) {
      const { esc } = this.host, full = key(ref), current = ref.branch?.current, favorites = this.host.state().favorites || [];
      const label = ref.name?.split('/').pop() || 'HEAD (Current Branch)', chosen = this.refs.some(value => same(value, ref));
      const tracking = ref.branch?.tracking || '', ahead = /ahead (\d+)/.exec(tracking)?.[1], behind = /behind (\d+)/.exec(tracking)?.[1];
      const count = value => Number(value) > 99 ? '99+' : value;
      return `<div class="history-ref-row ${chosen ? 'chosen' : ''}"><button class="history-ref" data-href="${esc(full)}" role="treeitem" aria-selected="${chosen}" title="${esc(`${ref.name || 'HEAD'}${ref.branch?.upstream ? ' → ' + ref.branch.upstream : ''}`)}" ${ref.kind === 'tag' && !ref.tag?.commit ? 'disabled' : ''}><span class="history-ref-icon ${current ? 'current' : ''}">${current ? '◆' : ref.kind === 'tag' ? '◇' : '⑂'}</span><span class="history-ref-label">${esc(label)}</span>${ahead || behind ? `<span class="history-tracking">${ahead ? '↑' + count(ahead) : ''} ${behind ? '↓' + count(behind) : ''}</span>` : ''}</button>${ref.kind !== 'head' ? `<button class="history-star ${favorites.includes(full) ? 'favorite' : ''}" data-hact="favorite" data-hkey="${esc(full)}" title="${favorites.includes(full) ? '取消收藏' : '收藏分支或标签'}" aria-label="收藏 ${esc(ref.name)}">${favorites.includes(full) ? '★' : '☆'}</button><button class="history-more" data-hact="refMenu" data-hkey="${esc(full)}" aria-label="${esc(ref.name)} 的操作菜单">⋯</button>` : ''}</div>`;
    }
    tree(snapshot) {
      const esc = this.host.esc, refs = this.refsFor(snapshot).filter(ref => !this.branchSearch || ref.name.toLowerCase().includes(this.branchSearch.toLowerCase()));
      const group = (title, prefix, entries) => {
        const render = (list, depth = '') => {
          const folders = new Map(), leaves = [];
          for (const item of list) {
            const relative = item.name.slice(depth.length), slash = relative.indexOf('/');
            if (slash < 0) leaves.push(item); else { const name = relative.slice(0, slash); if (!folders.has(name)) folders.set(name, []); folders.get(name).push(item); }
          }
          return [...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => {
            const folder = `${prefix}/${depth}${name}`;
            return `<details class="history-folder" data-hfolder="${esc(folder)}" ${this.branchSearch || !this.collapsed.has(folder) ? 'open' : ''}><summary><span class="history-folder-icon">▱</span>${esc(name)}<span>${items.length}</span></summary><div class="history-ref-list">${render(items, depth + name + '/')}</div></details>`;
          }).join('') + leaves.sort((a, b) => Number(!!b.branch?.current) - Number(!!a.branch?.current) || a.name.localeCompare(b.name)).map(ref => this.row(ref, snapshot)).join('');
        };
        return `<details class="history-category" data-hfolder="${prefix}" ${this.branchSearch || !this.collapsed.has(prefix) ? 'open' : ''}><summary>${title}<span>${entries.length}</span></summary><div class="history-ref-list">${render(entries)}</div></details>`;
      };
      const favorites = refs.filter(ref => (this.host.state().favorites || []).includes(key(ref)));
      return `<aside class="history-refs-pane" aria-label="分支与标签"><div class="history-branch-search"><span aria-hidden="true">⌕</span><input id="branch-search" type="search" value="${esc(this.branchSearch)}" placeholder="Branch or tag" aria-label="搜索分支或标签"></div><div class="history-tree-scroll" role="tree" aria-label="分支树"><button class="history-all ${!this.refs.length && !this.compareMode ? 'chosen' : ''}" data-href="ALL">所有分支与标签</button>${this.row({ kind: 'head' }, snapshot)}${favorites.length ? `<details class="history-category" open><summary>Favorites<span>${favorites.length}</span></summary>${favorites.map(ref => this.row(ref, snapshot)).join('')}</details>` : ''}${group('Local', 'local', refs.filter(ref => ref.kind === 'local'))}${group('Remote', 'remote', refs.filter(ref => ref.kind === 'remote'))}${group('Tags', 'tag', refs.filter(ref => ref.kind === 'tag'))}</div><div class="history-tree-footer">${this.hbutton('＋ New Branch', 'createBranch', '', this.host.state().busy || !!snapshot.operation)}${this.hbutton('全部折叠', 'collapseAll', '', false, 'quiet')}</div></aside>`;
    }
    hbutton(label, action, extra = '', disabled = false, cls = '') {
      return `<button class="${cls}" data-hact="${action}" ${extra} ${disabled ? 'disabled' : ''}>${label}</button>`;
    }
    filtersView() {
      const e = this.host.esc, f = this.filters;
      const chip = this.compareMode ? `Compare: ${this.compareMode.ref.name}` : this.refs.length ? `Branch: ${this.refs.map(ref => ref.name || 'HEAD').join(', ')}` : 'Branch: All';
      const pop = (name, label, active) => this.hbutton(`${label}${active ? ' ●' : ''} ⌄`, 'popover', `data-popover="${name}" aria-expanded="${this.popover === name}"`, false, 'history-filter-button');
      let popup = '';
      if (this.popover === 'user') popup = `<label for="history-author">User · 作者姓名或邮箱</label><input id="history-author" list="history-authors" value="${e(f.author)}" placeholder="所有作者"><datalist id="history-authors">${[...new Set(this.rows.map(c => c.author))].map(author => `<option value="${e(author)}"></option>`).join('')}</datalist>`;
      if (this.popover === 'date') popup = `<label for="history-after">开始日期</label><input id="history-after" type="date" value="${e(f.after)}"><label for="history-before">结束日期</label><input id="history-before" type="date" value="${e(f.before)}">`;
      if (this.popover === 'path') popup = `<label for="history-path">Paths · 仓库相对路径</label><input id="history-path" value="${e(f.path)}" placeholder="src/ 或 src/main.kt">${this.hbutton('选择文件或目录…', 'pickPath', '', false, 'quiet')}`;
      if (this.popover === 'view') popup = `<strong>View options</strong>${[['author', '显示作者'], ['date', '显示日期'], ['hash', '显示短哈希'], ['refs', '显示分支标签'], ['details', '显示提交详情']].map(([field, label]) => `<label class="history-check"><input type="checkbox" data-hview="${field}" ${this.view[field] ? 'checked' : ''}> ${label}</label>`).join('')}<hr><label class="history-check"><input type="checkbox" data-hfilter="firstParent" ${f.firstParent ? 'checked' : ''}> 仅第一父提交链</label><label class="history-check"><input type="checkbox" data-hfilter="noMerges" ${f.noMerges ? 'checked' : ''}> 隐藏 Merge Commit</label><label for="history-order">排序</label><select id="history-order"><option value="date" ${f.order === 'date' ? 'selected' : ''}>日期顺序</option><option value="topo" ${f.order === 'topo' ? 'selected' : ''}>拓扑顺序</option></select>`;
      return `<div class="history-toolbar"><div class="history-search-box"><span aria-hidden="true">⌕</span><input id="history-search" type="search" placeholder="Text or hash" aria-label="搜索提交文本或哈希" value="${e(f.text)}">${this.hbutton('.*', 'regex', `aria-pressed="${f.regex}" title="正则表达式（Git 扩展正则）"`, false, f.regex ? 'toggled' : '')}${this.hbutton('Cc', 'matchCase', `aria-pressed="${f.matchCase}" title="区分大小写"`, false, f.matchCase ? 'toggled' : '')}</div>${this.hbutton('☷', 'toggleTree', 'title="显示或隐藏分支树" aria-label="显示或隐藏分支树"', false, 'history-filter-button')}<span class="history-branch-chip" title="${e(chip)}">${e(chip)}${this.refs.length || this.compareMode ? this.hbutton('×', 'clearRefs', 'aria-label="清除分支筛选"') : ''}</span>${pop('user', f.author ? `User: ${e(f.author)}` : 'User', !!f.author)}${pop('date', 'Date', f.after || f.before)}${pop('path', f.path ? `Paths: ${e(f.path)}` : 'Paths', !!f.path)}<span class="spacer"></span>${this.hbutton('↻', 'reload', 'title="刷新历史" aria-label="刷新历史"')}${pop('view', '◉', false)}${this.hbutton('清除筛选', 'clearFilters', '', false, 'quiet')}${this.popover ? `<div class="history-filter-popover" role="dialog" aria-label="历史筛选">${popup}${this.popover !== 'view' ? `<div class="history-popover-actions">${this.hbutton('应用', 'applyFilter', '', false, 'primary')}${this.hbutton('清除', 'clearPopover')}</div>` : ''}</div>` : ''}</div>`;
    }
    detailView() {
      const e = this.host.esc, comparison = this.showComparison ? this.revisionComparison || this.comparison : undefined;
      const divider = `<div class="history-detail-divider" role="separator" aria-label="调整提交详情高度" aria-orientation="horizontal" aria-valuemin="20" aria-valuemax="70" aria-valuenow="${this.detailHeight}" tabindex="0" title="上下拖动调整详情高度"></div>`;
      if (comparison) return `${divider}<section class="history-details"><div class="history-detail-heading"><strong>文件比较</strong><code>${e(comparison.from.slice(0, 8))} ↔ ${e(comparison.to.slice(0, 8))}</code>${this.hbutton('×', 'closeComparison', 'aria-label="关闭文件比较"', false, 'quiet')}</div><div class="history-details-scroll">${comparison.files.length ? comparison.files.map(file => `<button class="history-changed-file" data-hact="compareFile" data-path="${e(file.path)}" data-from="${e(comparison.from)}" data-to="${e(comparison.to)}"><span class="status ${file.index === 'D' ? 'deleted' : file.index === 'A' ? 'added' : 'modified'}">${e(file.index)}</span>${e(file.path)}</button>`).join('') : '<p class="muted">两个版本的文件内容相同。</p>'}</div></section>`;
      if (!this.view.details) return '';
      const current = this.rows.find(row => row.hash === this.selected);
      if (!current) return '<div class="history-detail-hint">选择提交查看完整信息和改动文件 · ⌘/Ctrl 单击可选择两条提交进行比较</div>';
      const detail = this.details, files = (detail?.files || []).filter(file => file.path.toLowerCase().includes(this.filesFilter.toLowerCase()));
      return `${divider}<section class="history-details"><div class="history-detail-heading"><strong>${e(current.subject)}</strong>${this.hbutton('复制 SHA', 'copyHash', `data-hash="${e(current.hash)}"`, false, 'quiet')}${this.hbutton('⋯', 'commitMenu', `data-hash="${e(current.hash)}" aria-label="提交操作菜单"`, false, 'quiet')}</div>${this.detailError ? `<div class="history-error" role="alert">${e(this.detailError)}</div>` : ''}<div class="history-detail-columns"><div class="history-commit-message"><code>${e(current.hash)}</code><p>${e(detail?.author || current.author)}${detail?.email ? ' &lt;' + e(detail.email) + '&gt;' : ''}<br><span class="muted">${e(new Date(detail?.committedAt || current.date).toLocaleString())}${current.parents.length > 1 ? ' · Merge / 第一父提交' : ''}</span></p><pre>${e(detail?.message || '正在读取完整提交信息…')}</pre></div><div class="history-detail-file-panel"><input id="changed-files-filter" type="search" value="${e(this.filesFilter)}" placeholder="筛选改动文件…" aria-label="筛选提交中的文件"><div class="history-details-scroll">${files.map(file => `<button class="history-changed-file" data-hact="fileDiff" data-hash="${e(current.hash)}" data-path="${e(file.path)}"><span class="status ${file.index === 'D' ? 'deleted' : file.index === 'A' ? 'added' : 'modified'}">${e(file.index)}</span>${e(file.path)}</button>`).join('') || `<p class="muted">${detail ? '没有匹配的文件改动。' : '正在读取文件…'}</p>`}</div></div></div></section>`;
    }
    viewMarkup(snapshot) {
      const e = this.host.esc, graphs = this.graph();
      const columns = `<span class="history-subject">Commit</span>${this.view.author ? '<span class="history-author">User</span>' : ''}${this.view.date ? '<span class="history-date">Date</span>' : ''}${this.view.hash ? '<span class="history-hash">Hash</span>' : ''}`;
      const operation = snapshot.operation;
      return `<div class="history-workspace ${this.treeHidden ? 'tree-hidden' : ''} ${this.treeOverlay ? 'tree-overlay' : ''}">${this.tree(snapshot)}<div class="history-divider" role="separator" aria-label="调整分支栏宽度" aria-orientation="vertical" aria-valuemin="160" aria-valuemax="520" aria-valuenow="${this.width}" tabindex="0"></div><section class="history-main" aria-label="提交日志">${this.filtersView()}${operation ? `<div class="history-operation" role="status"><strong>${e(operation.type)} 进行中</strong><span>${operation.conflicts ? '请解决冲突并暂存文件' : '可以继续或中止操作'}</span>${this.hbutton('继续', 'continueOperation', '', this.host.state().busy || operation.conflicts)}${operation.type !== 'merge' ? this.hbutton('跳过当前提交…', 'skipOperation', '', this.host.state().busy) : ''}${this.hbutton('中止…', 'abortOperation', '', this.host.state().busy)}</div>` : ''}${this.comparison && this.compareMode ? `<div class="history-comparison-bar"><strong>${e(this.comparison.label)} ↔ 当前检出分支</strong>${this.hbutton(`Incoming ${this.comparison.incoming}`, 'incoming', '', false, this.compareMode.direction === 'incoming' ? 'toggled' : '')}${this.hbutton(`Outgoing ${this.comparison.outgoing}`, 'outgoing', '', false, this.compareMode.direction === 'outgoing' ? 'toggled' : '')}${this.hbutton(`文件差异 ${this.comparison.files.length}`, 'branchFiles')}${this.hbutton('×', 'clearRefs', 'aria-label="退出分支比较"')}</div>` : ''}${this.error ? `<div class="history-error" role="alert"><pre>${e(this.error)}</pre>${this.hbutton('重试', 'reload')}</div>` : ''}<div class="history-table-heading"><span class="history-graph-heading">Graph</span>${columns}</div><div class="history-commits-scroll" role="list" aria-label="提交历史" aria-busy="${this.loading}">${this.rows.map((commit, index) => `<button class="history-log-row ${this.selection.has(commit.hash) ? 'selected' : ''} ${commit.parents.length > 1 ? 'is-merge' : ''}" data-hact="selectCommit" data-hash="${e(commit.hash)}" aria-pressed="${this.selection.has(commit.hash)}" title="${e(commit.subject)}">${graphs[index]}<span class="history-subject">${this.view.refs && commit.refs ? `<span class="history-ref-badge">${e(commit.refs)}</span>` : ''}<span>${e(commit.subject)}</span></span>${this.view.author ? `<span class="history-author">${e(commit.author)}</span>` : ''}${this.view.date ? `<time class="history-date">${e(new Date(commit.date).toLocaleString())}</time>` : ''}${this.view.hash ? `<code class="history-hash">${e(commit.hash.slice(0, 8))}</code>` : ''}</button>`).join('') || `<div class="history-empty"><strong>${this.loading ? '正在读取提交历史…' : '没有匹配的提交'}</strong><p>${this.loading ? '正在按当前分支和筛选条件查询仓库。' : '可清除筛选、选择其他分支，或先完成仓库的首次提交。'}</p></div>`}</div><div class="history-log-footer"><span>${this.rows.length} commits${this.loading ? ' · 读取中…' : ''}</span>${this.hasMore ? this.hbutton('加载更多', 'more', '', this.loading) : ''}<span class="spacer"></span>${this.hbutton('比较所选提交', 'compareSelected', '', this.selection.size !== 2)}</div>${this.detailView()}</section>${this.renderMenu()}</div>`;
    }
    renderMenu() {
      if (!this.menu) return '';
      const e = this.host.esc, disabled = this.host.state().busy || !!this.host.state().snapshot.operation;
      const item = (label, action, extra = '', off = false, cls = '') => `<button role="menuitem" class="${cls}" data-hact="${action}" ${extra} ${off ? 'disabled' : ''}>${label}</button>`;
      let html = '';
      if (this.menu.ref) {
        const ref = this.find(this.menu.ref); if (!ref) return '';
        const attrs = `data-hkey="${e(key(ref))}"`, valid = ref.kind !== 'tag' || !!ref.tag?.commit;
        html = `<div class="history-menu-title">${e(ref.name || 'HEAD')}</div>${item('仅显示此分支的提交', 'filterRef', attrs, !valid)}${item('与当前分支比较', 'compareBranch', attrs, !valid || ref.kind === 'head')}<hr>${item(ref.kind === 'remote' ? '检出远程分支' : ref.kind === 'tag' ? 'Checkout Tag（Detached HEAD）…' : 'Checkout', ref.kind === 'tag' ? 'checkoutCommit' : 'switch', ref.kind === 'tag' ? `data-hash="${e(ref.tag?.commit || '')}"` : attrs, disabled || ref.kind === 'head' || !valid || !!ref.branch?.current)}${ref.kind === 'local' ? item(ref.branch?.upstream ? 'Pull（仅快进）…' : 'Pull（未设置上游）', 'pullBranch', attrs, disabled || !!ref.branch?.current || !ref.branch?.upstream) : ''}${item('从这里新建分支…', 'createBranch', attrs, disabled || !valid)}${item('创建标签…', 'createTag', attrs, disabled || !valid)}${item('Merge into Current…', 'merge', attrs, disabled || !valid || !!ref.branch?.current)}${item('Rebase Current onto This…', 'rebase', attrs, disabled || !valid || !!ref.branch?.current)}${ref.kind === 'local' ? item('Rename…', 'renameBranch', attrs, disabled) + item('删除本地分支…', 'deleteBranch', attrs, disabled || !!ref.branch?.current, 'danger') : ref.kind === 'remote' ? item('删除远程分支…', 'deleteRemoteBranch', attrs, disabled, 'danger') : ref.kind === 'tag' ? item('推送标签…', 'pushTag', attrs, disabled) + item('删除本地标签…', 'deleteTag', attrs, disabled, 'danger') : ''}<hr>${item('复制名称', 'copyRef', attrs, !valid)}${item((this.host.state().favorites || []).includes(key(ref)) ? '取消收藏' : '加入收藏', 'favorite', attrs, ref.kind === 'head' || !valid)}`;
      } else {
        const hash = this.menu.hash, attrs = `data-hash="${e(hash)}"`;
        html = `<div class="history-menu-title">${e(hash.slice(0, 12))}</div>${item('复制 Commit SHA', 'copyHash', attrs)}${item('复制完整提交信息', 'copyMessage', attrs)}${item('比较两条所选提交', 'compareSelected', '', this.selection.size !== 2)}<hr>${item('从此提交新建分支…', 'createBranch', attrs, disabled)}${item('创建标签…', 'createTag', attrs, disabled)}${item('Cherry-pick…', 'cherryPick', attrs, disabled)}${item('Revert Commit…', 'revertCommit', attrs, disabled)}${item('检出提交（Detached HEAD）…', 'checkoutCommit', attrs, disabled)}${item('Reset Current Branch to Here…', 'resetCommit', attrs, disabled, 'danger')}`;
      }
      return `<div class="history-menu" role="menu" aria-label="Git 操作">${html}</div>`;
    }
    openMenu(menu, event) {
      event?.preventDefault(); this.menu = menu; this.popover = ''; this.host.redraw();
      queueMicrotask(() => {
        const node = document.querySelector('.history-menu'); if (!node) return;
        const rect = node.getBoundingClientRect();
        document.documentElement.style.setProperty('--history-menu-x', `${Math.max(6, Math.min(event?.clientX || 30, window.innerWidth - rect.width - 6))}px`);
        document.documentElement.style.setProperty('--history-menu-y', `${Math.max(6, Math.min(event?.clientY || 80, window.innerHeight - rect.height - 6))}px`);
        node.querySelector('button:not(:disabled)')?.focus();
      });
    }
    context(event) {
      const ref = event.target.closest('[data-href]'), commit = event.target.closest('[data-hact="selectCommit"]');
      if (ref && ref.dataset.href !== 'ALL') { this.openMenu({ ref: ref.dataset.href }, event); return true; }
      if (commit) { if (!this.selection.has(commit.dataset.hash)) this.selectCommit(commit.dataset.hash, false); this.openMenu({ hash: commit.dataset.hash }, event); return true; }
      return false;
    }
    click(target, event) {
      if (target.dataset.href) { this.choose(target.dataset.href, event.metaKey || event.ctrlKey); return true; }
      const action = target.dataset.hact; if (!action) return false;
      const ref = target.dataset.hkey ? this.find(target.dataset.hkey) : undefined;
      if (action === 'refMenu') { this.openMenu({ ref: target.dataset.hkey }, event); return true; }
      if (action === 'commitMenu') { this.openMenu({ hash: target.dataset.hash }, event); return true; }
      this.menu = undefined;
      if (action === 'selectCommit') { this.selectCommit(target.dataset.hash, event.metaKey || event.ctrlKey); return true; }
      if (action === 'filterRef') { this.choose(target.dataset.hkey); return true; }
      if (action === 'compareBranch') { this.refs = [this.wire(ref)]; this.compareMode = { ref: this.wire(ref), direction: 'incoming' }; this.save(); this.load(); return true; }
      if (action === 'incoming' || action === 'outgoing') { if (this.compareMode) { this.compareMode.direction = action; this.save(); this.load(); } return true; }
      if (action === 'branchFiles') { this.revisionComparison = undefined; this.showComparison = true; this.host.redraw(); return true; }
      if (action === 'closeComparison') { this.showComparison = false; this.host.redraw(); return true; }
      if (action === 'compareSelected') {
        const hashes = this.rows.filter(row => this.selection.has(row.hash)).map(row => row.hash);
        if (hashes.length !== 2) return true;
        this.compareRequest = ++this.counter; this.detailError = ''; this.host.send('revisionComparison', { from: hashes[1], to: hashes[0], requestId: this.compareRequest }); this.host.redraw(); return true;
      }
      if (action === 'fileDiff') { this.host.send('diff', { hash: target.dataset.hash, path: target.dataset.path, files: [...document.querySelectorAll('[data-hact="fileDiff"]')].map(node => node.dataset.path) }); return true; }
      if (action === 'compareFile') { this.host.send('compareFile', { from: target.dataset.from, to: target.dataset.to, path: target.dataset.path, files: [...document.querySelectorAll('[data-hact="compareFile"]')].map(node => node.dataset.path) }); return true; }
      if (action === 'popover') { this.popover = this.popover === target.dataset.popover ? '' : target.dataset.popover; this.host.redraw(); queueMicrotask(() => document.querySelector('.history-filter-popover input')?.focus()); return true; }
      if (action === 'toggleTree') { if (window.innerWidth <= 640) this.treeOverlay = !this.treeOverlay; else this.treeHidden = !this.treeHidden; this.host.redraw(); return true; }
      if (action === 'collapseAll') { document.querySelectorAll('[data-hfolder]').forEach(folder => this.collapsed.add(folder.dataset.hfolder)); this.save(); this.host.redraw(); return true; }
      if (action === 'clearRefs') { this.refs = []; this.compareMode = undefined; this.comparison = undefined; this.showComparison = false; this.save(); this.load(); return true; }
      if (action === 'clearFilters') { this.filters = defaults(); this.refs = []; this.compareMode = undefined; this.comparison = undefined; this.showComparison = false; this.save(); this.load(); return true; }
      if (action === 'regex' || action === 'matchCase') { this.filters[action] = !this.filters[action]; this.save(); this.load(); return true; }
      if (action === 'reload') { this.host.send('refresh'); this.load(); return true; }
      if (action === 'more') { this.load(true); return true; }
      if (action === 'applyFilter') { this.popover = ''; this.save(); this.load(); return true; }
      if (action === 'clearPopover') { if (this.popover === 'user') this.filters.author = ''; if (this.popover === 'date') { this.filters.after = ''; this.filters.before = ''; } if (this.popover === 'path') this.filters.path = ''; this.popover = ''; this.save(); this.load(); return true; }
      if (action === 'pickPath') { this.host.send('pickHistoryPath'); return true; }
      if (action === 'favorite') { if (ref) this.host.send('favoriteRef', { ref: this.wire(ref) }); this.host.redraw(); return true; }
      const extra = { ...(ref ? { ref: this.wire(ref) } : {}), ...(target.dataset.hash ? { hash: target.dataset.hash } : {}), ...(action === 'continueOperation' || action === 'abortOperation' || action === 'skipOperation' ? { operation: this.host.state().snapshot.operation?.type } : {}) };
      this.host.send(action, extra); this.host.redraw(); return true;
    }
    input(event) {
      const id = event.target.id;
      if (id === 'branch-search') { this.branchSearch = event.target.value; this.save(); this.host.redraw(); return true; }
      if (id === 'history-search') { this.filters.text = event.target.value; this.save(); clearTimeout(this.debounce); this.debounce = setTimeout(() => this.load(), 320); return true; }
      if (id === 'changed-files-filter') { this.filesFilter = event.target.value; this.host.redraw(); return true; }
      const fields = { 'history-author': 'author', 'history-after': 'after', 'history-before': 'before', 'history-path': 'path' };
      if (fields[id]) { this.filters[fields[id]] = event.target.value; return true; }
      return false;
    }
    change(event) {
      if (event.target.dataset.hview) { this.view[event.target.dataset.hview] = event.target.checked; this.save(); this.host.redraw(); return true; }
      if (event.target.dataset.hfilter) { this.filters[event.target.dataset.hfilter] = event.target.checked; this.save(); this.load(); return true; }
      if (event.target.id === 'history-order') { this.filters.order = event.target.value; this.save(); this.load(); return true; }
      return false;
    }
    toggle(target) {
      if (!target.dataset.hfolder) return;
      const full = target.dataset.hfolder;
      if (target.open && this.collapsed.has(full)) { this.collapsed.delete(full); this.save(); }
      else if (!target.open && !this.collapsed.has(full)) { this.collapsed.add(full); this.save(); }
    }
    keydown(event) {
      if (event.key === 'Escape' && (this.menu || this.popover || this.treeOverlay)) { event.preventDefault(); this.menu = undefined; this.popover = ''; this.treeOverlay = false; this.host.redraw(); return true; }
      if (this.menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = [...document.querySelectorAll('.history-menu button:not(:disabled)')], index = items.indexOf(document.activeElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); return true;
      }
      if (event.key === 'Enter' && event.target.closest('.history-filter-popover')) { event.preventDefault(); this.popover = ''; this.save(); this.load(); return true; }
      if (event.key === 'Enter' && event.target.id === 'history-search') { event.preventDefault(); this.load(); return true; }
      if (event.target.closest('.history-detail-divider') && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        this.resizeDetails(this.detailHeight + (event.key === 'ArrowUp' ? 3 : -3));
        this.save();
        return true;
      }
      if (event.target.closest('.history-divider') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); this.width = Math.max(160, Math.min(520, this.width + (event.key === 'ArrowRight' ? 16 : -16))); document.documentElement.style.setProperty('--history-sidebar-width', `${this.width}px`); this.save(); this.host.redraw(); return true; }
      if (event.target.closest('.history-ref') && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const nodes = [...document.querySelectorAll('.history-ref')].filter(node => node.offsetParent), index = nodes.indexOf(event.target.closest('.history-ref')); nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); return true; }
      return false;
    }
  }
  window.ProjectGitHistory = ProjectGitHistory;
})();
