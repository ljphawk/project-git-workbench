"""Exercise the actual webview scripts under the production CSP with a controlled host."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from support.ui_fixture import SNAPSHOT, state

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'artifacts'

def latest(page, kind):
    return page.evaluate('(kind)=>window.sent.filter(m=>m.type===kind).at(-1)', kind)

def reply(page, req, result, kind='history', root=None):
    page.evaluate("m=>window.postMessage(m,'*')", {'type':kind, 'root':root or req['root'], 'requestId':req['requestId'], 'result':result})
    page.wait_for_timeout(30)

def history_reply(page, commits=None, more=False, **extra):
    req = latest(page, 'history')
    reply(page, req, {'commits':SNAPSHOT['commits'] if commits is None else commits, 'hasMore':more, **extra})
    return req

with tempfile.TemporaryDirectory(prefix='pg-history-ui-') as temp, sync_playwright() as p:
    html = Path(temp) / 'index.html'
    html.write_text('''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src file:; script-src 'nonce-test';">''' + ''.join(f'<link rel="stylesheet" href="{(ROOT / "media" / name).as_uri()}">' for name in ['workbench.css','history.css']) + '</head><body><div id="app"></div>' + ''.join(f'<script nonce="test" src="{(ROOT / "media" / name).as_uri()}"></script>' for name in ['history.js','workbench.js']) + '</body></html>')
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width':1440,'height':900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    page.add_init_script("window.sent=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:s=>window.saved=s,postMessage:m=>window.sent.push(m)});")
    page.goto(html.as_uri())
    snapshot = {**SNAPSHOT, 'tags':[{'name':'release/1.0','hash':'a'*40,'commit':'a'*40,'annotated':True}]}
    state(page, snapshot)
    page.locator('#tab-branches').click()
    history_reply(page, more=True)
    expect(page.locator('.history-refs-pane')).to_be_visible()
    expect(page.locator('.history-log-row')).to_have_count(4)
    assert page.locator('.history-refs-pane').bounding_box()['x'] < page.locator('.history-main').bounding_box()['x']
    expect(page.locator('[data-hfolder="local/feature"]')).to_be_visible()
    expect(page.locator('[data-hfolder="remote/origin"]')).to_be_visible()
    page.screenshot(path=str(ART / 'branches-as-wide.png'))
    # Read-only selection issues a scoped server query, never Checkout.
    before = page.evaluate('window.sent.length')
    page.locator('[data-href="refs/heads/main"]').click()
    req = latest(page,'history')
    assert req['query']['refs'] == [{'kind':'local','name':'main'}]
    assert all(m['type'] == 'history' for m in page.evaluate('i=>window.sent.slice(i)', before))
    history_reply(page)
    page.locator('[data-href="refs/remotes/origin/main"]').click(modifiers=['Meta'])
    assert len(latest(page,'history')['query']['refs']) == 2
    history_reply(page)
    # Filtering is sent to Git, with controls and dates encoded in the request.
    page.locator('#history-search').fill('offline.*reader')
    page.wait_for_timeout(370)
    assert latest(page,'history')['query']['text'] == 'offline.*reader'
    old = latest(page,'history')
    page.locator('[data-hact="regex"]').click()
    assert latest(page,'history')['query']['regex']
    page.locator('[data-hact="matchCase"]').click()
    assert latest(page,'history')['query']['matchCase']
    reply(page,old,{'commits':SNAPSHOT['commits'],'hasMore':False})
    expect(page.locator('.history-log-row')).to_have_count(0)
    history_reply(page,[SNAPSHOT['commits'][2]])
    for pop, field, value, query_field in [('user','history-author','Junpeng','author'),('path','history-path','app/src','path')]:
        page.locator(f'[data-popover="{pop}"]').click()
        page.locator('#'+field).fill(value)
        page.locator('[data-hact="applyFilter"]').click()
        assert latest(page,'history')['query'][query_field] == value
        history_reply(page)
    page.locator('[data-popover="date"]').click()
    page.locator('#history-after').fill('2026-10-01')
    page.locator('#history-before').fill('2026-11-04')
    page.locator('[data-hact="applyFilter"]').click()
    q = latest(page,'history')['query']
    assert q['after'].endswith('Z') and q['before'].endswith('Z')
    assert q['after'] < q['before']
    history_reply(page)
    page.screenshot(path=str(ART / 'branches-as-filtered.png'))
    page.locator('[data-hact="clearFilters"]').click()
    history_reply(page,SNAPSHOT['commits'][:2],more=True)
    page.locator('[data-hact="more"]').click()
    assert latest(page,'history')['query']['skip'] == 2
    history_reply(page,SNAPSHOT['commits'][1:])
    expect(page.locator('.history-log-row')).to_have_count(4)
    # Context menu has explicit mutation targets and keyboard navigation.
    page.locator('[data-hact="refMenu"][data-hkey="refs/tags/release/1.0"]').click()
    page.locator('[data-hact="pushTag"]').click()
    assert latest(page,'pushTag')['ref'] == {'kind':'tag','name':'release/1.0'}
    assert latest(page,'pushTag')['root'] == SNAPSHOT['root']
    page.locator('[data-href="refs/heads/main"]').click(button='right')
    expect(page.locator('.history-menu')).to_be_visible()
    page.keyboard.press('End')
    expect(page.locator('.history-menu [data-hact="favorite"]')).to_be_focused()
    page.keyboard.press('Escape')
    expect(page.locator('.history-menu')).to_have_count(0)
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    page.screenshot(path=str(ART / 'branches-as-context-menu.png'))
    page.locator('[data-hact="pullBranch"]').click()
    assert latest(page,'pullBranch')['ref'] == {'kind':'local','name':'main'}
    assert latest(page,'pullBranch')['root'] == SNAPSHOT['root']
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    page.locator('[data-hact="switch"]').click()
    assert latest(page,'switch')['ref'] == {'kind':'local','name':'main'}
    assert latest(page,'switch')['root'] == SNAPSHOT['root']
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    page.locator('[data-hact="compareBranch"]').click()
    assert latest(page,'history')['query']['compare'] == {'ref':{'kind':'local','name':'main'},'direction':'incoming'}
    history_reply(page, comparison={'from':'a'*40,'to':'b'*40,'files':[SNAPSHOT['changes'][0]],'label':'main','incoming':1,'outgoing':2})
    page.locator('[data-hact="outgoing"]').click()
    assert latest(page,'history')['query']['compare']['direction'] == 'outgoing'
    history_reply(page, comparison={'from':'a'*40,'to':'b'*40,'files':[SNAPSHOT['changes'][0]],'label':'main','incoming':1,'outgoing':2})
    page.locator('[data-hact="branchFiles"]').click()
    page.locator('[data-hact="compareFile"]').click()
    assert latest(page,'compareFile')['from'] == 'a'*40
    assert latest(page,'compareFile')['files'] == [SNAPSHOT['changes'][0]['path']]
    page.locator('[data-hact="clearRefs"]').first.click()
    history_reply(page)
    # Details and native diff, two-commit comparison and delayed-response isolation.
    page.locator('.history-log-row').first.click()
    req = latest(page,'commitDetails')
    reply(page,req,{'hash':'a'*40,'author':'Junpeng','email':'test@invalid','message':'Full subject\n\nDetailed body <img src=x>', 'files':[SNAPSHOT['changes'][0]]},'commitDetails')
    expect(page.locator('.history-commit-message')).to_contain_text('Detailed body <img src=x>')
    assert page.locator('img').count() == 0
    divider = page.get_by_role('separator', name='调整提交详情高度')
    details = page.locator('.history-details')
    initial_height = details.bounding_box()['height']
    bar = divider.bounding_box()
    x, y = bar['x'] + bar['width'] / 2, bar['y'] + bar['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y - 140, steps=8)
    page.mouse.up()
    expanded_height = details.bounding_box()['height']
    assert expanded_height > initial_height + 100
    assert page.locator('.history-commits-scroll').bounding_box()['height'] > 0
    saved_height = page.evaluate('window.saved.history.detailHeight')
    assert saved_height > 24
    reply(page, req, {'hash':'a'*40,'message':'Refreshed details','files':[SNAPSHOT['changes'][0]]}, 'commitDetails')
    assert abs(details.bounding_box()['height'] - expanded_height) < 1
    divider.press('ArrowDown')
    assert details.bounding_box()['height'] < expanded_height
    page.locator('[data-hact="fileDiff"]').click()
    assert latest(page,'diff')['hash'] == 'a'*40
    assert latest(page,'diff')['files'] == [SNAPSHOT['changes'][0]['path']]
    page.locator('.history-log-row').nth(1).click(modifiers=['Meta'])
    page.locator('[data-hact="compareSelected"]').click()
    comp = latest(page,'revisionComparison')
    assert comp['from'] == 'b'*40 and comp['to'] == 'a'*40
    reply(page,comp,{'from':'b'*40,'to':'a'*40,'files':[SNAPSHOT['changes'][0]]},'revisionComparison')
    expect(page.get_by_text('文件比较',exact=True)).to_be_visible()
    page.locator('.history-log-row').nth(2).click()
    reply(page,comp,{'from':'b'*40,'to':'a'*40,'files':[]},'revisionComparison')
    expect(page.get_by_text('文件比较',exact=True)).to_have_count(0)
    # Divider, tree search, view options and busy state.
    divider = page.locator('.history-divider')
    divider.focus(); page.keyboard.press('ArrowRight')
    assert page.locator('.history-refs-pane').bounding_box()['width'] == 296
    page.locator('#branch-search').fill('origin')
    expect(page.locator('[data-href="refs/heads/main"]')).to_have_count(0)
    page.locator('#branch-search').fill('')
    page.locator('[data-popover="view"]').click()
    page.locator('[data-hview="hash"]').uncheck()
    expect(page.locator('.history-hash')).to_have_count(0)
    page.keyboard.press('Escape')
    state(page,snapshot,busy=True)
    expect(page.locator('.workbench')).to_have_class('workbench is-busy')
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    expect(page.locator('[data-hact="switch"]')).to_be_disabled()
    expect(page.locator('[data-hact="pullBranch"]')).to_be_disabled()
    page.keyboard.press('Escape')
    page.locator('[data-hact="refMenu"][data-hkey="refs/tags/release/1.0"]').click()
    expect(page.locator('[data-hact="pushTag"]')).to_be_disabled()
    page.keyboard.press('Escape')
    state(page,snapshot)
    # Per-repository state and out-of-order requests cannot leak history.
    old=latest(page,'history')
    other={**snapshot,'root':'/company/web/portal','name':'portal'}
    state(page,other)
    reply(page,old,{'commits':SNAPSHOT['commits'],'hasMore':False})
    expect(page.locator('.history-log-row')).to_have_count(0)
    history_reply(page,[])
    state(page,snapshot)
    history_reply(page)
    # Sidebar remains usable without widening VS Code.
    page.set_viewport_size({'width':340,'height':800})
    expect(page.locator('.history-refs-pane')).not_to_be_visible()
    page.locator('[data-hact="toggleTree"]').click()
    expect(page.locator('.history-refs-pane')).to_be_visible()
    page.locator('[data-href="refs/heads/main"]').click()
    expect(page.locator('.history-refs-pane')).not_to_be_visible()
    history_reply(page)
    page.screenshot(path=str(ART/'branches-as-sidebar.png'))
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    browser.close()
    print('History UI passed: dual pane, tree, query filters, pagination, stale replies, context menus, keyboard, comparisons, details, diff, scope, busy state, resizing, narrow layout and CSP.')
