/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const stored = vscode.getState() || {};
  let tab = stored.tab || 'changes';
  let drafts = stored.drafts || {};
  const amends = {};
  let state = {}, selected = new Set(), known = new Set(), root = '', selectedCommit = '', commitFiles = [], filter = '';
  const app = document.getElementById('app');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let history;
  const persist = () => vscode.setState({ tab, drafts, history: history?.preferences() });
  const send = (type, extra = {}) => vscode.postMessage({ type, root: state.root, ...extra });
  const paths = () => [...selected];
  const button = (label, action, extra = '', disabled = false, cls = '') => `<button class="${cls}" data-action="${action}" ${extra} ${disabled || state.busy ? 'disabled' : ''}>${label}</button>`;
  const basename = file => file.split('/').pop();
  const directory = file => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const canCommit = () => !state.busy && (selected.size > 0 || !!amends[root]) && !!(drafts[root] || '').trim() && !state.snapshot.changes.some(c => c.conflict) && !state.snapshot.merging;
  function status(change) {
    if (change.conflict) return { code: '!', text: '冲突', cls: 'conflict' };
    const value = change.worktree !== ' ' && change.worktree !== '?' ? change.worktree : change.index;
    return { code: value === '?' ? '+' : value, text: ({ '?': '未跟踪', A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变化' })[value] || value, cls: value === 'D' ? 'deleted' : ['?', 'A'].includes(value) ? 'added' : 'modified' };
  }
  const empty = (title, detail) => `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><strong>${title}</strong><p>${detail}</p></div>`;

  function changesView(snapshot) {
    const selectedChanges = snapshot.changes.filter(c => selected.has(c.path));
    const groups = [
      ['冲突', snapshot.changes.filter(c => c.conflict)],
      ['未暂存的更改', snapshot.changes.filter(c => !c.conflict && c.index === ' ')],
      ['已暂存的更改', snapshot.changes.filter(c => !c.conflict && c.index !== ' ' && c.index !== '?')],
      ['未跟踪的文件', snapshot.changes.filter(c => c.index === '?')],
    ];
    const files = groups.map(([name, entries]) => {
      const visible = entries.filter(c => c.path.toLowerCase().includes(filter.toLowerCase()));
      if (!visible.length) return '';
      return `<section class="file-group"><h3>${name}<span>${entries.length}</span></h3>${visible.map(change => {
        const s = status(change);
        return `<div class="file-row ${change.conflict ? 'has-conflict' : ''}">
          <input type="checkbox" aria-label="选择 ${esc(change.path)}" data-file="${esc(change.path)}" ${selected.has(change.path) ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>
          <span class="status ${s.cls}" title="${s.text}">${s.code}</span>
          <button class="file-name" data-action="diff" data-path="${esc(change.path)}" title="${esc(change.originalPath ? `${change.originalPath} → ${change.path}` : change.path)}"><span>${esc(basename(change.path))}</span><small>${esc(directory(change.path))}</small></button>
          ${!change.conflict && change.index !== '?' && change.index !== ' ' && change.worktree !== ' ' ? '<span class="staged partial" title="此文件已暂存，但工作区又有修改；Commit 会提交勾选文件的全部本地更改。">另有未暂存修改</span>' : ''}
        </div>`;
      }).join('')}</section>`;
    }).join('');
    return `<div class="changes-layout"><section class="changes-list">
      <div class="list-toolbar"><label class="select-all"><input id="select-all" type="checkbox" ${selected.size && selected.size === snapshot.changes.length ? 'checked' : ''} ${state.busy ? 'disabled' : ''}> 全选</label><span class="muted">${selected.size} / ${snapshot.changes.length}</span><input id="filter" type="search" placeholder="筛选文件…" value="${esc(filter)}" aria-label="筛选文件"></div>
      <div class="file-scroll">${snapshot.changes.length ? files || empty('没有匹配的文件', '换一个文件名或路径试试。') : empty('工作区干净', '当前项目的更改会出现在这里。')}</div>
      <div class="file-actions">${button('Shelve Changes…', 'shelve', 'title="保存勾选文件的修改并从工作区移走，稍后可恢复"', !selected.size || !snapshot.head || snapshot.changes.some(c => c.conflict) || snapshot.merging)}${button('暂存', 'stage', 'title="将勾选文件的修改加入暂存区（尚未提交）"', !selectedChanges.some(c => c.index === '?' || c.worktree !== ' '))}${button('取消暂存', 'unstage', 'title="将勾选文件移出暂存区，保留本地修改"', !selectedChanges.some(c => c.index !== ' ' && c.index !== '?'))}${button('丢弃…', 'discard', 'title="还原勾选文件的未暂存更改，并删除勾选的未跟踪文件；需要确认"', !selected.size, 'danger subtle')}</div>
    </section><section class="commit-box"><h3>Commit<span>仅当前仓库</span></h3>
      <label for="commit-message">提交信息</label><textarea id="commit-message" placeholder="描述这次改动…" ${state.busy ? 'disabled' : ''}>${esc(drafts[root] || '')}</textarea>
      <label class="amend-option"><input id="amend-commit" type="checkbox" ${amends[root] ? 'checked' : ''} ${state.busy || !snapshot.head || snapshot.merging ? 'disabled' : ''}> Amend commit（修改最后一次提交）</label>
      ${amends[root] ? `<div class="commit-note">将改写提交 ${esc(amends[root].head.slice(0, 8))}；未勾选文件时仅修改提交信息。</div>` : ''}
      <div class="commit-note">提交勾选文件的全部更改；未勾选的暂存内容会保留。</div>
      ${snapshot.merging ? '<p class="warning">合并进行中，请在 VS Code 源代码管理中完成合并提交。</p>' : ''}
      ${button(`${amends[root] ? 'Amend commit' : 'Commit'} · ${selected.size || !amends[root] ? selected.size + ' 个文件' : '仅修改信息'}`, 'commit', 'id="commit-button"', !canCommit(), 'primary')}
      <div class="stash-actions">${button('Stash 更改', 'stash', '', !snapshot.changes.length)}${button('恢复 Stash…', 'applyStash')}</div>
    </section></div>`;
  }

  history = new window.ProjectGitHistory({ state: () => state, root: () => root, tab: () => tab, send, redraw: () => render(), persist, esc }, stored.history || {});
  const logView = snapshot => history.viewMarkup(snapshot);
  const branchesView = snapshot => history.viewMarkup(snapshot);

  function shelfView(snapshot) {
    const shelves = (snapshot.shelves || []).filter(s => `${s.title} ${s.branch} ${s.files.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
    return `<section class="shelf-layout"><div class="list-toolbar"><span class="muted">本仓库 · 恢复后保留备份</span><input id="filter" type="search" placeholder="搜索 Shelf…" value="${esc(filter)}" aria-label="筛选 Shelf"></div><div class="shelf-scroll">${shelves.length ? shelves.map(s => `<article class="shelf-card"><div class="shelf-title"><strong>${esc(s.title)}</strong><time>${esc(new Date(s.createdAt).toLocaleString())}</time></div><div class="shelf-meta"><span>⑂ ${esc(s.branch)}</span><code>${esc(s.base.slice(0, 8))}</code><span>${s.files.length} 个文件</span></div>${s.state === 'saved' ? '<p class="warning">备份已保存，工作区清理未全部完成，请检查本地文件。</p>' : ''}${s.restoredAt ? '<p class="shelf-restored">已恢复 · 备份保留</p>' : ''}<details class="shelf-files"><summary>查看文件列表</summary><ul>${s.files.map(f => `<li>${esc(f)}</li>`).join('')}</ul></details><div class="shelf-actions">${button('Unshelve 恢复', 'unshelve', `data-id="${esc(s.id)}"`, false, 'primary')}${button('查看补丁', 'shelfPatch', `data-id="${esc(s.id)}"`)}${button('删除…', 'deleteShelf', `data-id="${esc(s.id)}"`, false, 'danger subtle')}</div></article>`).join('') : empty('暂无 Shelf', (snapshot.shelves || []).length ? '没有匹配的 Shelf，试试其他名称或路径。' : '在 Local Changes 勾选文件，点击 Shelve Changes 保存并移走修改；之后在这里恢复。')}</div></section>`;
  }

  function render() {
    const active = document.activeElement;
    const focus = active && active.id;
    const historyFocus = active?.dataset.href ? `[data-href="${CSS.escape(active.dataset.href)}"]` : active?.dataset.hact ? `[data-hact="${CSS.escape(active.dataset.hact)}"]${active.dataset.hash ? `[data-hash="${CSS.escape(active.dataset.hash)}"]` : active.dataset.hkey ? `[data-hkey="${CSS.escape(active.dataset.hkey)}"]` : ''}` : '';
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : undefined;
    const scrolls = [...document.querySelectorAll('.file-scroll,.shelf-scroll,.history-tree-scroll,.history-commits-scroll,.history-details-scroll')].map(el => [el.className, el.scrollTop, el.scrollLeft]);
    const snapshot = state.snapshot;
    app.innerHTML = `<div class="workbench ${state.busy ? 'is-busy' : ''}">
      <header class="repo-header"><div class="repo-heading"><span class="repo-icon" aria-hidden="true">⑂</span><button data-action="pick" class="repo-picker" title="切换 Git 项目"><strong>${esc(snapshot?.name || (state.root ? basename(state.root) : '选择 Git 项目'))}</strong><span>⌄</span></button>${state.loading ? '<span class="loading" aria-label="正在刷新">↻</span>' : ''}${snapshot ? button('Git 地址', 'repoRemotes', 'title="查看并复制当前项目的远程 Git 地址" aria-label="查看 Git 地址"', false, 'remote-address-button') : ''}${button('↗', 'openPanel', 'title="在编辑区展开工作台" aria-label="在编辑区展开工作台"', false, 'icon-button')}</div><div class="repo-path" title="${esc(state.root || '')}">${esc(state.root || '从工作区中选择一个独立的 Git 仓库')}</div></header>
      ${snapshot ? `<div class="sync-bar"><span class="branch-badge" title="${esc(snapshot.upstream || '尚未设置上游')}">⑂ ${esc(snapshot.branch)}</span><span class="tracking" title="领先 / 落后上游">↑${snapshot.ahead} ↓${snapshot.behind}</span><span class="spacer"></span>${button('Fetch', 'fetch')}${button('Pull ↓', 'pull')}${button('Push ↑', 'push')}${button('↻', 'refresh', 'title="刷新" aria-label="刷新"', false, 'icon-button')}</div>` : ''}
      ${state.error ? `<div class="error" role="alert"><strong>操作提示</strong><pre>${esc(state.error)}</pre>${button('重试刷新', 'refresh')}</div>` : ''}
      ${snapshot ? `<nav class="tabs" role="tablist" aria-label="Git 功能">${[['changes', 'Local Changes', snapshot.changes.length], ['log', 'Log', ''], ['branches', 'Branches', ''], ['shelf', 'Shelf', (snapshot.shelves || []).length]].map(([id, label, count]) => `<button role="tab" id="tab-${id}" aria-controls="tab-content" aria-selected="${tab === id}" data-tab="${id}" tabindex="${tab === id ? 0 : -1}" class="${tab === id ? 'active' : ''}">${label}${count !== '' ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</nav><main id="tab-content" role="tabpanel" aria-labelledby="tab-${tab}">${tab === 'changes' ? changesView(snapshot) : tab === 'log' ? logView(snapshot) : tab === 'shelf' ? shelfView(snapshot) : branchesView(snapshot)}</main>` : `<main>${empty(state.loading ? '正在读取仓库…' : '一个项目，一个 Git 上下文', '打开项目中的文件以自动跟随，或右键文件 / 目录，选择「在 Project Git 中打开」。')}<div class="welcome-action">${button('选择 Git 项目', 'pick', '', false, 'primary')}</div></main>`}
      <footer><span class="scope-dot"></span><span>${state.busy ? 'Git 操作进行中…' : '操作范围：当前仓库'}</span><span class="spacer"></span><span>Project Git</span></footer></div>`;
    for (const [cls, top, left] of scrolls) { const el = document.getElementsByClassName(cls)[0]; if (el) { el.scrollTop = top; el.scrollLeft = left; } }
    if (focus || historyFocus) {
      const el = focus ? document.getElementById(focus) : document.querySelector(historyFocus);
      if (el && !el.disabled) { el.focus(); if (selection && el.setSelectionRange) { try { el.setSelectionRange(...selection); } catch {} } }
    }
    const selectAll = document.getElementById('select-all');
    if (selectAll) selectAll.indeterminate = selected.size > 0 && selected.size < (snapshot?.changes.length || 0);
  }

  app.addEventListener('input', event => {
    if (history.input(event)) return;
    if (event.target.id === 'commit-message') {
      drafts[root] = event.target.value; persist();
      const button = document.getElementById('commit-button');
      button.disabled = !canCommit();
    }
    if (event.target.id === 'filter') { filter = event.target.value; render(); }
  });
  app.addEventListener('change', event => {
    if (history.change(event)) return;
    if (event.target.id === 'amend-commit') {
      if (event.target.checked && state.snapshot.head) {
        amends[root] = { head: state.snapshot.head.hash, branch: state.snapshot.branch, previousDraft: drafts[root] || '' };
        drafts[root] = state.snapshot.head.message;
      } else if (amends[root]) {
        drafts[root] = amends[root].previousDraft;
        delete amends[root];
      }
      persist(); render(); return;
    }
    if (event.target.dataset.file) {
      const file = event.target.dataset.file;
      if (event.target.checked) selected.add(file); else selected.delete(file);
      render();
    }
    if (event.target.id === 'select-all') { selected = new Set(event.target.checked ? state.snapshot.changes.map(c => c.path) : []); render(); }
  });
  function closeFileMenu(restoreFocus = false) {
    const menu = app.querySelector('.file-menu');
    if (!menu) return false;
    const file = menu.dataset.path;
    menu.remove();
    if (restoreFocus) app.querySelector(`.file-name[data-path="${CSS.escape(file)}"]`)?.focus();
    return true;
  }

  app.addEventListener('contextmenu', event => {
    closeFileMenu();
    if (history.context(event) || tab !== 'changes' || state.busy) return;
    const row = event.target.closest('.file-row');
    const file = row?.querySelector('.file-name')?.dataset.path;
    if (!state.snapshot?.changes.some(change => change.path === file && change.index === '?')) return;

    event.preventDefault();
    const menu = document.createElement('div');
    menu.className = 'history-menu file-menu';
    menu.dataset.path = file;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '文件操作');
    menu.innerHTML = '<button type="button" role="menuitem" title="将此文件加入暂存区">Add</button>';
    app.append(menu);

    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(event.clientX, innerWidth - bounds.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(event.clientY, innerHeight - bounds.height - 6))}px`;
    const add = menu.querySelector('button');
    const repoRoot = state.root;
    add.addEventListener('click', () => {
      closeFileMenu(true);
      if (!state.busy && state.root === repoRoot) send('stage', { paths: [file] });
    });
    add.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.file-menu')) closeFileMenu();
  });
  app.addEventListener('toggle', event => history.toggle(event.target), true);
  app.addEventListener('scroll', event => { if (event.target.classList?.contains('history-commits-scroll')) { const heading = document.querySelector('.history-table-heading'); if (heading) heading.scrollLeft = event.target.scrollLeft; } }, true);
  app.addEventListener('keydown', event => {
    if (event.key === 'Escape' && closeFileMenu(true)) { event.preventDefault(); return; }
    if (history.keydown(event)) return;
    if (event.target.dataset.tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = ['changes', 'log', 'branches', 'shelf'];
      tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      filter = ''; persist(); render(); history.activate(); document.getElementById(`tab-${tab}`).focus();
    }
  });
  app.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (history.click(target, event)) return;
    if (target.dataset.tab) { tab = target.dataset.tab; filter = ''; persist(); render(); history.activate(); return; }
    const action = target.dataset.action;
    if (!action) return;
    if (action === 'commitFiles') { selectedCommit = target.dataset.hash; commitFiles = []; render(); }
    send(action === 'historyDiff' ? 'diff' : action, {
      paths: paths(), path: target.dataset.path, hash: target.dataset.hash,
      files: action === 'diff' ? [...app.querySelectorAll('.file-name[data-action="diff"]')].map(node => node.dataset.path) : undefined,
      name: target.dataset.name, message: drafts[root] || '',
      amend: !!amends[root], expectedHead: amends[root]?.head,
      id: target.dataset.id,
    });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (history.receive(message)) return;
    if (message.type === 'state') {
      const changed = (message.root || '') !== root;
      if (message.root !== root) { root = message.root || ''; selected.clear(); known.clear(); selectedCommit = ''; commitFiles = []; filter = ''; }
      if (message.snapshot) {
        if (amends[root] && (message.snapshot.head?.hash !== amends[root].head || message.snapshot.branch !== amends[root].branch)) {
          drafts[root] = amends[root].previousDraft;
          delete amends[root]; persist();
        }
        const next = new Set(message.snapshot.changes.map(c => c.path));
        selected = new Set([...selected].filter(p => next.has(p)));
        for (const p of next) if (!known.has(p)) selected.add(p);
        known = next;
      }
      state = message; history.onState(changed); render();
    }
    if (message.type === 'commitFiles' && message.root === root && message.hash === selectedCommit) { commitFiles = message.files; render(); }
    if (message.type === 'completed' && message.action === 'commit') { delete drafts[message.root]; delete amends[message.root]; persist(); if (message.root === root) render(); }
    if (message.type === 'completed' && message.action === 'shelve' && message.root === root) { tab = 'shelf'; filter = ''; persist(); render(); }
  });
  render(); send('ready');
})();
