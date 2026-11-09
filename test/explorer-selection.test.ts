import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { explorerSelection } from '../src/explorer-selection';

const exec = promisify(execFile);
const script = path.resolve(__dirname, '../../media/explorer-selection.js');
const setup = (name: string, text: string, binary = false) => `ObjC.import('AppKit'); ObjC.import('Foundation'); var p=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}); p.clearContents; var item=$.NSPasteboardItem.alloc.init; item.setStringForType(${JSON.stringify(text)}, $.NSPasteboardTypeString); ${binary ? "item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions('AAECA/8=',0), 'com.project-git.test-binary');" : ''} p.writeObjects($.NSArray.arrayWithObject(item));`;
async function jxa(source: string): Promise<string> { return (await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source])).stdout.trim(); }

test('Explorer path capture restores all original clipboard formats using an isolated named pasteboard', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const name = `project-git.test.${randomUUID()}`;
  try {
    await jxa(setup(name, 'original clipboard text', true));
    const resource = '/company/android/project with spaces';
    const selected = await explorerSelection(() => jxa(setup(name, resource)), script, name);
    assert.equal(selected, resource);
    const result = await jxa(`ObjC.import('AppKit'); var p=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}); JSON.stringify({text:ObjC.unwrap(p.stringForType($.NSPasteboardTypeString)), binary:ObjC.unwrap(p.dataForType('com.project-git.test-binary').base64EncodedStringWithOptions(0))});`);
    assert.deepEqual(JSON.parse(result), { text: 'original clipboard text', binary: 'AAECA/8=' });
  } finally { await jxa(`ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).releaseGlobally;`); }
});

test('an unchanged clipboard is never mistaken for the selected Explorer path', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const name = `project-git.test.${randomUUID()}`;
  try {
    await jxa(setup(name, '/some/old/copied/path'));
    assert.equal(await explorerSelection(async () => {}, script, name), '');
  } finally { await jxa(`ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).releaseGlobally;`); }
});

test('path capture preserves image-only clipboard data without replacing it with empty text', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
  const name = `project-git.test.${randomUUID()}`;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  try {
    await jxa(`ObjC.import('AppKit'); ObjC.import('Foundation'); var p=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}); p.clearContents; var item=$.NSPasteboardItem.alloc.init; item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(png)},0),'public.png'); p.writeObjects($.NSArray.arrayWithObject(item));`);
    assert.equal(await explorerSelection(() => jxa(setup(name, '/company/web')), script, name), '/company/web');
    const restored = await jxa(`ObjC.import('AppKit'); var p=$.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}); ObjC.unwrap(p.dataForType('public.png').base64EncodedStringWithOptions(0));`);
    assert.equal(restored, png);
  } finally { await jxa(`ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName(${JSON.stringify(name)}).releaseGlobally;`); }
});
