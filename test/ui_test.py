"""Run with: python3 test/ui_test.py (requires Python Playwright and Chromium)."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"

from support.ui_fixture import SNAPSHOT, state


with tempfile.TemporaryDirectory(prefix="project-git-ui-") as directory, sync_playwright() as p:
    html = Path(directory) / "index.html"
    html.write_text(f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src file:; script-src 'nonce-test';"><link rel="stylesheet" href="{(ROOT / 'media/workbench.css').as_uri()}"><link rel="stylesheet" href="{(ROOT / 'media/history.css').as_uri()}"></head><body><div id="app"></div><script nonce="test" src="{(ROOT / 'media/history.js').as_uri()}"></script><script nonce="test" src="{(ROOT / 'media/workbench.js').as_uri()}"></script></body></html>''')
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 720}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("window.sent=[]; window.acquireVsCodeApi=()=>({getState:()=>({}),setState:s=>{window.saved=s},postMessage:m=>window.sent.push(m)});")
    page.goto(html.as_uri())
    page.wait_for_load_state("networkidle")
    expect(page.get_by_text("一个项目，一个 Git 上下文")).to_be_visible()
    state(page)
    expect(page.get_by_text("ReaderActivity.kt", exact=True)).to_be_visible()
    page.get_by_role('button', name='查看 Git 地址', exact=True).click()
    assert page.evaluate("window.sent.at(-1).type") == 'repoRemotes'
    assert page.evaluate("window.sent.at(-1).root") == SNAPSHOT['root']
    page.locator('.file-name[data-action="diff"]').first.click()
    assert page.evaluate("window.sent.at(-1).files") == [c['path'] for c in SNAPSHOT['changes']]
    # Right-click Add targets the untracked row, independently of checkboxes.
    untracked = next(change["path"] for change in SNAPSHOT["changes"] if change["index"] == "?")
    checkbox = page.get_by_label(f"选择 {untracked}", exact=True)
    checkbox.uncheck()
    row = page.locator(".file-row").filter(has=checkbox)
    row.click(button="right")
    add = page.get_by_role("menuitem", name="Add", exact=True)
    expect(add).to_be_focused()
    add.press("Enter")
    sent = page.evaluate("window.sent.at(-1)")
    assert sent == {"type": "stage", "root": SNAPSHOT["root"], "paths": [untracked]}
    expect(checkbox).not_to_be_checked()
    checkbox.check()
    # Staging keeps changes visible, but moves them to the staged group.
    page.locator('[data-action="stage"]').click()
    assert page.evaluate("window.sent.at(-1).type") == "stage"
    staged = {**SNAPSHOT, "changes": [{**c, "index": "A" if c["index"] == "?" else "M", "worktree": " "} for c in SNAPSHOT["changes"]]}
    state(page, staged)
    expect(page.locator('.file-group').filter(has=page.get_by_role('heading', name='已暂存的更改'))).to_contain_text('ReaderActivity.kt')
    expect(page.get_by_role('heading', name='未暂存的更改')).not_to_be_visible()
    expect(page.locator('[data-action="stage"]')).to_be_disabled()
    expect(page.locator('[data-action="unstage"]')).to_be_enabled()
    partial = {**staged, "changes": [{**staged["changes"][0], "worktree": "M"}, *staged["changes"][1:]]}
    state(page, partial)
    expect(page.get_by_text('另有未暂存修改', exact=True)).to_be_visible()
    state(page)
    page.locator("#commit-message").fill("Add offline reader cache")
    page.get_by_label("选择 app/src/main/res/layout/reader.xml", exact=True).uncheck()
    page.locator("#commit-button").click()
    sent = page.evaluate("window.sent.at(-1)")
    assert sent["root"] == SNAPSHOT["root"] and sent["type"] == "commit"
    assert sent["paths"] == ["app/src/main/ReaderActivity.kt", "app/src/main/OfflineCache.kt"]
    ARTIFACTS.mkdir(exist_ok=True)
    page.screenshot(path=str(ARTIFACTS / "workbench-wide.png"))
    # Refresh preserves drafts, file selection and keyboard focus.
    page.locator("#commit-message").focus()
    state(page)
    expect(page.locator("#commit-message")).to_be_focused()
    expect(page.locator("#commit-message")).to_have_value("Add offline reader cache")
    expect(page.get_by_label("选择 app/src/main/res/layout/reader.xml", exact=True)).not_to_be_checked()
    # Search and keyboard tab navigation.
    page.locator("#filter").fill("Offline")
    expect(page.get_by_text("OfflineCache.kt", exact=True)).to_be_visible()
    expect(page.get_by_text("ReaderActivity.kt", exact=True)).not_to_be_visible()
    page.get_by_role("tab", name="Log", exact=True).click()
    page.wait_for_function("window.sent.some(m=>m.type==='history')")
    request = page.evaluate("window.sent.filter(m=>m.type==='history').at(-1)")
    page.evaluate("s=>window.postMessage(s,'*')", {"type":"history", "root":SNAPSHOT["root"], "requestId":request["requestId"], "result":{"commits":SNAPSHOT["commits"],"hasMore":False}})
    page.get_by_text("Merge offline reader improvements", exact=True).click()
    request = page.evaluate("window.sent.at(-1)")
    page.evaluate("s=>window.postMessage(s,'*')", {"type": "commitDetails", "root": SNAPSHOT["root"], "requestId":request["requestId"], "result":{"hash":"a"*40,"author":"Junpeng Liu","message":SNAPSHOT["head"]["message"],"files":[SNAPSHOT["changes"][0]]}})
    page.locator(".history-changed-file").click()
    assert page.evaluate("window.sent.at(-1).hash") == "a" * 40
    page.screenshot(path=str(ARTIFACTS / "workbench-log.png"))
    page.get_by_role("tab", name="Log", exact=True).focus()
    page.keyboard.press("ArrowRight")
    expect(page.get_by_role("tab", name="Branches", exact=True)).to_have_attribute("aria-selected", "true")
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    page.locator('[data-hact="switch"]').click()
    assert page.evaluate("window.sent.at(-1).ref.name") == "main"
    # All mutations are disabled during an operation.
    state(page, busy=True)
    page.locator('[data-hact="refMenu"][data-hkey="refs/heads/main"]').click()
    expect(page.locator('[data-hact="switch"]')).to_be_disabled()
    page.keyboard.press('Escape')
    # Draft isolation and escaped untrusted Git metadata.
    other = {**SNAPSHOT, "root": "/company/web/portal", "name": "<img src=x onerror=alert(1)>", "changes": []}
    state(page, other)
    page.get_by_role("tab", name="Local Changes").click()
    expect(page.locator("#commit-message")).to_have_value("")
    assert page.locator("img").count() == 0
    state(page)
    expect(page.locator("#commit-message")).to_have_value("Add offline reader cache")
    # Narrow sidebar stays within the viewport.
    page.set_viewport_size({"width": 340, "height": 800})
    page.screenshot(path=str(ARTIFACTS / "workbench-sidebar.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "sidebar overflows horizontally"
    page.get_by_role("tab", name="Log", exact=True).click()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "log overflows horizontally"
    page.get_by_role("tab", name="Branches", exact=True).click()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "branches overflow horizontally"
    page.get_by_role("tab", name="Local Changes").click()
    page.locator("#select-all").check()
    page.locator("#select-all").uncheck()
    expect(page.locator("#commit-button")).to_be_disabled()
    page.get_by_label("Amend commit（修改最后一次提交）", exact=True).check()
    expect(page.locator("#commit-message")).to_have_value(SNAPSHOT["head"]["message"])
    expect(page.locator("#commit-button")).to_be_enabled()
    page.screenshot(path=str(ARTIFACTS / "workbench-amend.png"))
    state(page)
    expect(page.locator("#amend-commit")).to_be_checked()
    page.locator("#commit-button").click()
    sent = page.evaluate("window.sent.at(-1)")
    assert sent["amend"] and sent["expectedHead"] == "a" * 40 and sent["paths"] == []
    assert sent["message"] == SNAPSHOT["head"]["message"]
    # Amend state is isolated per repo, and turning it off restores the draft.
    state(page, other)
    expect(page.locator("#amend-commit")).not_to_be_checked()
    state(page)
    expect(page.locator("#amend-commit")).to_be_checked()
    page.locator("#amend-commit").uncheck()
    expect(page.locator("#commit-message")).to_have_value("Add offline reader cache")
    page.locator("#amend-commit").check()
    state(page, {**SNAPSHOT, "head": {"hash": "e" * 40, "message": "A new HEAD"}})
    expect(page.locator("#amend-commit")).not_to_be_checked()
    expect(page.locator("#commit-message")).to_have_value("Add offline reader cache")
    state(page, {**SNAPSHOT, "head": None, "commits": []})
    expect(page.locator("#amend-commit")).to_be_disabled()
    expect(page.locator('[data-action="shelve"]')).to_be_disabled()
    # Shelve sends selected paths to this repository and opens its Shelf tab.
    state(page)
    page.locator('[data-action="shelve"]').click()
    sent = page.evaluate('window.sent.at(-1)')
    assert sent['type'] == 'shelve' and sent['root'] == SNAPSHOT['root'] and len(sent['paths']) == 3
    shelf = {
        'id': 'aabbccdd-1111-2222-3333-aabbccddeeff', 'title': '离线阅读 · 进行中的修改',
        'createdAt': '2026-11-03T09:00:00Z', 'branch': SNAPSHOT['branch'], 'base': 'a' * 40,
        'files': [c['path'] for c in SNAPSHOT['changes']], 'state': 'shelved',
    }
    page.evaluate("s=>window.postMessage(s,'*')", {'type': 'completed', 'action': 'shelve', 'root': SNAPSHOT['root']})
    shelved = {**SNAPSHOT, 'changes': [], 'shelves': [shelf]}
    state(page, shelved)
    expect(page.locator('#tab-shelf')).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_text(shelf['title'], exact=True)).to_be_visible()
    page.get_by_text('查看文件列表', exact=True).click()
    expect(page.get_by_text('app/src/main/OfflineCache.kt', exact=True)).to_be_visible()
    page.get_by_role('button', name='查看补丁', exact=True).click()
    assert page.evaluate('window.sent.at(-1).id') == shelf['id']
    assert page.evaluate('window.sent.at(-1).type') == 'shelfPatch'
    page.get_by_role('button', name='Unshelve 恢复', exact=True).click()
    sent = page.evaluate('window.sent.at(-1)')
    assert sent['type'] == 'unshelve' and sent['root'] == SNAPSHOT['root'] and sent['id'] == shelf['id']
    state(page, shelved, busy=True)
    expect(page.get_by_role('button', name='Unshelve 恢复', exact=True)).to_be_disabled()
    restored = {**SNAPSHOT, 'shelves': [{**shelf, 'restoredAt': '2026-11-03T09:30:00Z'}]}
    state(page, restored)
    expect(page.get_by_text('已恢复 · 备份保留', exact=True)).to_be_visible()
    page.get_by_role('button', name='删除…', exact=True).click()
    assert page.evaluate('window.sent.at(-1).type') == 'deleteShelf'
    assert page.evaluate('window.sent.at(-1).id') == shelf['id']
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'shelf overflows sidebar'
    page.screenshot(path=str(ARTIFACTS / 'workbench-shelf-sidebar.png'))
    page.set_viewport_size({'width': 1100, 'height': 720})
    page.screenshot(path=str(ARTIFACTS / 'workbench-shelf-wide.png'))
    page.locator('#filter').fill('not a shelf')
    expect(page.get_by_text(shelf['title'], exact=True)).not_to_be_visible()
    page.locator('#filter').fill('OfflineCache')
    expect(page.get_by_text(shelf['title'], exact=True)).to_be_visible()
    state(page, other)
    expect(page.get_by_text(shelf['title'], exact=True)).not_to_be_visible()
    assert not errors, errors
    browser.close()
    print("UI checks passed: scope, staging groups, drafts, history, branches, keyboard, escaping, amend, Shelf creation/navigation/preview/restore/delete/isolation, narrow layout.")
