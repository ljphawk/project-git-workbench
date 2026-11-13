"""Check actual editor-title placement in an isolated VS Code renderer via CDP.
Adds temporary run and extra toolbar actions; no user settings/extensions change.
Run after npm run compile. Requires Python Playwright.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
ART = ROOT / 'artifacts'

def poll_state(workspace, file=None, line=None, extra=None):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        try:
            state = json.loads((workspace / 'toolbar-state.json').read_text())
            if (file is None or Path(state.get('file', '')).name == file) and (line is None or state.get('line') == line) and (extra is None or state.get('extra') == extra):
                return state
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(.03)
    raise AssertionError(f'Toolbar fixture did not reach {file}:{line}, extra={extra}')

with tempfile.TemporaryDirectory(prefix='pg-toolbar-', dir='/tmp') as temp, sync_playwright() as p:
    base = Path(temp).resolve(); workspace = base/'workspace'; workspace.mkdir()
    extension = base/'extension'; (extension/'dist').mkdir(parents=True)
    shutil.copytree(ROOT/'dist/src', extension/'dist/src'); shutil.copytree(ROOT/'media', extension/'media')
    package = json.loads((ROOT/'package.json').read_text())
    for n, group in [(0,'navigation@0'),(1,'navigation@97'),(2,'navigation@98')]:
        name = f'projectGit.toolbarFixture{n}'
        package['contributes']['commands'].append({'command':name,'title':f'Test extra toolbar action {n}','icon':'$(play)' if n == 0 else '$(beaker)'})
        package['contributes']['menus'].setdefault('editor/title', []).append({'command':name,'when':'projectGit.diffNavigation' if n == 0 else 'projectGit.toolbarTestExtra','group':group})
    (extension/'package.json').write_text(json.dumps(package))
    settings = base/'user-data/User'; settings.mkdir(parents=True)
    (settings/'settings.json').write_text(json.dumps({'chat.disableAIFeatures':True,'telemetry.telemetryLevel':'off','extensions.autoUpdate':False,'workbench.startupEditor':'none'}))
    vim = os.environ.get('PROJECT_GIT_TEST_VIM')
    if vim:
        extension_path = Path(vim)
        shutil.copytree(extension_path, base / 'extensions' / extension_path.name)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
    env = {k:v for k,v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    env['PROJECT_GIT_TOOLBAR_TEST'] = '1'
    with (ART/'toolbar-host.log').open('w') as log:
        proc = subprocess.Popen([CODE,str(workspace),f'--extensionDevelopmentPath={extension}',f'--extensionTestsPath={ROOT / "dist/test/extension-host"}',f'--user-data-dir={base / "user-data"}',f'--extensions-dir={base / "extensions"}',f'--remote-debugging-port={port}','--remote-debugging-address=127.0.0.1','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry','--disable-gpu','--new-window'],env=env,stdout=log,stderr=subprocess.STDOUT)
        browser = None
        try:
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version',timeout=.3).read(); break
                except Exception:
                    if proc.poll() is not None: raise AssertionError('VS Code exited before renderer was ready')
                    time.sleep(.1)
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            page = next(page for context in browser.contexts for page in context.pages if 'workbench' in page.url)
            page.on('console', lambda msg: print(msg.text, flush=True) if msg.type == 'error' else None)
            poll_state(workspace,'a-nav.txt',30)
            # Read rendered labels before choosing the controls.
            labels = page.locator('.editor-actions [aria-label]').evaluate_all('(nodes)=>nodes.map(n=>n.getAttribute("aria-label"))')
            (ART/'toolbar-labels.json').write_text(json.dumps(labels,ensure_ascii=False,indent=2))
            previous = page.locator('.statusbar').get_by_role('button', name=re.compile('上一处修改（跨文件）'))
            following = page.locator('.statusbar').get_by_role('button', name=re.compile('下一处修改（跨文件）'))
            expect(previous).to_be_visible(); expect(following).to_be_visible()
            before = [previous.bounding_box(),following.bounding_box()]
            assert before[0]['x'] < before[1]['x']
            page.screenshot(path=str(ART/'navigation-toolbar-before.png'))
            (workspace/'toolbar-signal').write_text('extra'); poll_state(workspace,extra=True)
            page.wait_for_timeout(200) # Native toolbar menu updates are debounced.
            assert page.locator('.editor-actions').get_by_role('button', name=re.compile('修改（跨文件）')).count() == 0
            after = [previous.bounding_box(),following.bounding_box()]
            assert all(abs(a['x']-b['x']) <= 1 for a,b in zip(before,after)), (before,after)
            # Click the actual dedicated title buttons within and across files.
            previous.click(); poll_state(workspace,'a-nav.txt',3)
            following.click(); poll_state(workspace,'a-nav.txt',30)
            following.click(); poll_state(workspace,'b-nav.txt',3)
            previous.click(); poll_state(workspace,'a-nav.txt',30)
            # The left Local Changes list must select the same repository and open a clicked file.
            changes = page.get_by_role('treeitem', name=re.compile('b-nav.txt'))
            expect(changes).to_be_visible()
            changes.click(); poll_state(workspace,'b-nav.txt',3)
            page.get_by_role('treeitem', name=re.compile('a-nav.txt')).click(); poll_state(workspace,'a-nav.txt',3)
            following.click(); poll_state(workspace,'a-nav.txt',30)
            page.screenshot(path=str(ART/'navigation-toolbar-after.png'))
            (workspace/'toolbar-signal').write_text('ordinary'); poll_state(workspace,'file.txt',0)
            expect(previous).not_to_be_visible(); expect(following).not_to_be_visible()
            expect(page.locator('.part.sidebar')).to_contain_text('Explorer')
            (workspace/'toolbar-signal').write_text('reopen'); poll_state(workspace,'a-nav.txt',3)
            expect(previous).to_be_visible(); expect(following).to_be_visible()
            # Deliberately choosing another module during Diff must be respected.
            (workspace/'toolbar-signal').write_text('search')
            expect(page.locator('.part.sidebar')).to_contain_text('Search')
            (workspace/'toolbar-signal').write_text('ordinary'); poll_state(workspace,'file.txt',0)
            expect(page.locator('.part.sidebar')).to_contain_text('Search')
            expect(previous).not_to_be_visible(); expect(following).not_to_be_visible()
            (workspace/'toolbar-signal').write_text('reopen'); poll_state(workspace,'a-nav.txt',3)
            expect(page.locator('.part.sidebar')).to_contain_text('Local Changes')
            following.click(); poll_state(workspace,'a-nav.txt',30)
            # Send the physical key through VS Code's keybinding resolver.
            diff_tab = page.get_by_role('tab', name=re.compile('a-nav.txt.*Local changes', re.I))
            (workspace/'toolbar-signal').write_text('focusLocalChanges')
            expect(page.locator('.part.sidebar .monaco-list:focus')).to_have_count(1, timeout=3000)
            page.keyboard.press('Escape')
            expect(diff_tab).to_have_count(0, timeout=3000)
            expect(page.locator('.part.sidebar')).to_contain_text('Explorer')
            (workspace/'toolbar-signal').write_text('reopen'); poll_state(workspace,'a-nav.txt',3)
            page.keyboard.press('Meta+1')
            expect(page.locator('.monaco-diff-editor .monaco-editor.focused')).to_have_count(1, timeout=3000)
            page.keyboard.press('Escape')
            expect(diff_tab).to_have_count(0, timeout=3000)
            expect(page.locator('.part.sidebar')).to_contain_text('Explorer')
            (workspace/'toolbar-signal').write_text('reopenAfterEscape'); poll_state(workspace,'a-nav.txt',3)
            following.click(); poll_state(workspace,'a-nav.txt',30)
            (workspace/'toolbar-signal').write_text('imageNavigation')
            image_tab = page.get_by_role('tab', name=re.compile('z-nav.png.*Local changes', re.I))
            expect(image_tab).to_have_attribute('aria-selected', 'true')
            expect(previous).to_be_visible(); expect(following).to_be_visible()
            following.click(); poll_state(workspace,'a-nav.txt',3)
            previous.click()
            expect(image_tab).to_have_attribute('aria-selected', 'true')
            previous.click(); poll_state(workspace,'b-nav.txt',30)
            (workspace/'toolbar-signal').write_text('finishImageNavigation'); poll_state(workspace,'a-nav.txt',3)
            following.click(); poll_state(workspace,'a-nav.txt',30)
            (workspace/'toolbar-signal').write_text('done')
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                log.flush()
                if 'Extension host checks passed' in (ART/'toolbar-host.log').read_text():
                    break
                time.sleep(.05)
            else:
                raise AssertionError('Native extension host checks did not finish')
            # A live CDP client can keep Electron alive after extension tests exit.
            browser.close(); browser = None
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try: proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait(timeout=3)
            print('Toolbar checks passed: bottom-right arrows visible and stable while top toolbar actions change, no added top arrows, left Local Changes selection, Explorer restored on exit, manual Search selection respected, mouse hunk/file navigation, isolated native host.')
        except Exception:
            if browser:
                page.screenshot(path=str(ART/'statusbar-failure.png'))
                (ART/'statusbar-failure.txt').write_text(page.locator('body').inner_text())
            raise
        finally:
            (workspace/'toolbar-signal').write_text('done')
            if browser:
                try: browser.close()
                except Exception: pass
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=8)
                except subprocess.TimeoutExpired: proc.kill()
