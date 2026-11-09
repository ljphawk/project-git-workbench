// macOS JXA helper. Keep the complete pasteboard in this process only; never
// send the user's original clipboard data to the extension or write it to disk.
ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  var board = argv.length ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
  var initialCount = Number(board.changeCount);
  var saved = [];
  var items = board.pasteboardItems;
  for (var i = 0; i < Number(items.count); i++) {
    var item = items.objectAtIndex(i), types = item.types, contents = [];
    for (var j = 0; j < Number(types.count); j++) {
      var type = types.objectAtIndex(j), data = item.dataForType(type);
      if (!data || data.isNil()) throw new Error('Cannot preserve a clipboard format; selection lookup cancelled.');
      contents.push({ type: type, data: data.copy });
    }
    saved.push(contents);
  }
  if (Number(board.changeCount) !== initialCount) throw new Error('Clipboard changed during snapshot; selection lookup cancelled.');
  var output = $.NSFileHandle.fileHandleWithStandardOutput;
  function write(value) { output.writeData($(value + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  write('ready');
  var signal = ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding));
  if (signal !== 'capture') { write(JSON.stringify({ path: '' })); return; }
  var capturedCount = Number(board.changeCount), copied = '';
  if (capturedCount !== initialCount) {
    var value = board.stringForType($.NSPasteboardTypeString);
    if (value && !value.isNil()) copied = ObjC.unwrap(value);
    var restored = [];
    for (var k = 0; k < saved.length; k++) {
      var replacement = $.NSPasteboardItem.alloc.init;
      for (var n = 0; n < saved[k].length; n++) replacement.setDataForType(saved[k][n].data, saved[k][n].type);
      restored.push(replacement);
    }
    // Do not overwrite another copy operation that happened during capture.
    if (Number(board.changeCount) !== capturedCount) { write(JSON.stringify({ path: '', changed: true })); return; }
    board.clearContents;
    if (restored.length && !board.writeObjects($(restored))) throw new Error('Clipboard restoration failed.');
  }
  write(JSON.stringify({ path: copied }));
}
